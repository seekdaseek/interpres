/**
 * interpres server.
 *
 * Mints Voice Agent tokens so the API key never reaches the browser, converts a
 * remote MCP server's tools into Voice Agent function tools, calls those tools
 * on the agent's behalf, and shapes the results into something speakable.
 *
 * The web app is served from the same origin as the API, so the browser needs no
 * CORS and no second hostname.
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import {
  applyNormalisers, assertPhaseValid, handleFindTools, initialPhase,
  buildGreeting, phaseSessionUpdate, shapeResult, MAX_TOOLS_PER_PHASE,
} from '@interpres/core';
import type { Phase, PlannerInput } from '@interpres/core';
import { config, assertConfigured } from './config.ts';
import { RateLimiter, clientKey } from './ratelimit.ts';
import { EventLog } from './logs.ts';
import { getCatalog, cacheStats, invalidate } from './catalog.ts';
import type { Catalog } from './catalog.ts';
import { McpError, callTool } from './mcp.ts';
import { SsrfError } from './ssrf.ts';
import { makeShaper } from './shaper.ts';
import type { ShaperStats } from './shaper.ts';
import { PRESETS, presetFor } from './presets.ts';

const log = new EventLog(config.logPath);
const limiter = new RateLimiter({
  perIpPerHour: config.limits.perIpPerHour,
  globalPerDay: config.limits.globalPerDay,
});
const shaperStats: ShaperStats = { calls: 0, failures: 0, totalMs: 0, retries: 0 };
const shaper = makeShaper(shaperStats);

const counters = { tokens: 0, connects: 0, toolCalls: 0, toolFailures: 0, findTools: 0 };

// HttpBindings gives access to the raw Node request, and so to the socket's
// own peer address - the only client identity a caller cannot forge.
export const app = new Hono<{ Bindings: HttpBindings }>();

/** The planner input for a cached catalog. */
function plannerInput(catalog: Catalog): PlannerInput {
  return {
    catalog: catalog.conversion.converted,
    server: catalog.server,
    instructions: catalog.instructions,
  };
}

/** What the browser needs in order to send `session.update`. */
function phasePayload(phase: Phase) {
  return {
    tools: phase.tools,
    systemPrompt: phase.systemPrompt,
    keyterms: phase.keyterms,
    transcriptionPrompt: phase.transcriptionPrompt,
    hasFindTools: phase.hasFindTools,
    reason: phase.reason,
    visible: phase.visible.map((c) => ({ voiceName: c.tool.name, mcpName: c.report.mcpName })),
    sessionUpdate: phaseSessionUpdate(phase),
  };
}

function errorStatus(err: unknown): number {
  if (err instanceof SsrfError) return err.code === 'timeout' ? 504 : 400;
  if (err instanceof McpError) {
    if (err.classification === 'auth_required') return 502;
    if (err.classification === 'unreachable') return 502;
    return 502;
  }
  return 500;
}

function errorBody(err: unknown): { error: string; code: string } {
  if (err instanceof SsrfError) return { error: err.message, code: err.code };
  if (err instanceof McpError) return { error: err.detail, code: err.classification };
  return { error: err instanceof Error ? err.message : 'Unknown error', code: 'internal' };
}

// ------------------------------------------------------------------ routes

app.get('/api/health', (c) => c.json({ ok: true, at: new Date().toISOString() }));

app.get('/api/presets', (c) => c.json({ presets: PRESETS, maxToolsPerPhase: MAX_TOOLS_PER_PHASE }));

/**
 * A short-lived Voice Agent token. The API key stays in this process.
 *
 * Keyed on `cf-connecting-ip` or the socket's peer address - never on a header
 * a client can forge, which is what makes the limit real.
 */
app.get('/api/token', async (c) => {
  const key = clientKey(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress);
  const decision = limiter.take(key);
  if (!decision.allowed) {
    log.record('token.refused', { reason: decision.reason, retryAfterSeconds: decision.retryAfterSeconds });
    return c.json(
      {
        error:
          decision.reason === 'per_ip'
            ? `That is ${limiter.perIpPerHour} sessions from your address this hour, which is the limit. Try again later.`
            : 'The demo has used its daily session budget. Try again tomorrow.',
        code: decision.reason,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      429,
      { 'retry-after': String(decision.retryAfterSeconds) },
    );
  }

  const url = new URL(`${config.agentsApi}/token`);
  url.searchParams.set('expires_in_seconds', String(config.token.expiresInSeconds));
  url.searchParams.set('max_session_duration_seconds', String(config.token.maxSessionDurationSeconds));

  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${config.assemblyAiKey}` } });
    if (!res.ok) {
      const detail = await res.text();
      log.record('token.error', { status: res.status, ms: Date.now() - started });
      // The upstream body could name the key; never pass it through verbatim.
      return c.json({ error: `The token service answered ${res.status}.`, code: 'token_upstream' }, 502);
    }
    const body = (await res.json()) as { token?: string };
    if (typeof body.token !== 'string' || body.token === '') {
      return c.json({ error: 'The token service returned no token.', code: 'token_upstream' }, 502);
    }
    counters.tokens++;
    log.record('token.minted', {
      ms: Date.now() - started,
      maxSessionDurationSeconds: config.token.maxSessionDurationSeconds,
      remainingForClient: decision.remaining,
      globalRemaining: decision.globalRemaining,
    });
    return c.json({
      token: body.token,
      maxSessionDurationSeconds: config.token.maxSessionDurationSeconds,
      expiresInSeconds: config.token.expiresInSeconds,
    });
  } catch (err) {
    log.record('token.error', { ms: Date.now() - started, detail: String(err) });
    return c.json({ error: 'Could not reach the token service.', code: 'token_unreachable' }, 502);
  }
});

/** Connect to an MCP server, convert its tools, and return the opening phase. */
app.post('/api/mcp/connect', async (c) => {
  let body: { url?: unknown; force?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Send a JSON body with a url.', code: 'bad_request' }, 400);
  }
  if (typeof body.url !== 'string' || body.url.trim() === '') {
    return c.json({ error: 'Send a url.', code: 'bad_request' }, 400);
  }
  const url = body.url.trim();
  const started = Date.now();

  try {
    const { catalog, cached } = await getCatalog(url, { force: body.force === true });
    const phase = initialPhase(plannerInput(catalog));
    // The API validates none of this, so our own guard is the only one there is.
    assertPhaseValid(phase);

    counters.connects++;
    log.record(cached ? 'mcp.cache.hit' : 'mcp.connect', {
      url, ms: Date.now() - started, ok: true,
      transport: catalog.transport,
      toolsIn: catalog.conversion.stats.toolsIn,
      toolsConverted: catalog.conversion.stats.toolsConverted,
      failed: catalog.conversion.stats.failed,
    });

    const preset = presetFor(url);
    return c.json({
      url,
      cached,
      transport: catalog.transport,
      server: catalog.server ?? null,
      instructions: catalog.instructions ?? null,
      greeting: buildGreeting(catalog.server, catalog.conversion.converted.length),
      stats: catalog.conversion.stats,
      failures: catalog.conversion.failures,
      catalog: catalog.conversion.converted.map((cv) => ({
        voiceName: cv.tool.name,
        mcpName: cv.report.mcpName,
        description: cv.tool.description,
        parameters: cv.tool.parameters,
        report: cv.report,
        isWriteTool: preset?.writeTools?.includes(cv.report.mcpName) ?? false,
      })),
      phase: phasePayload(phase),
      asks: preset?.asks ?? [],
    });
  } catch (err) {
    log.record('mcp.connect.failed', { url, ms: Date.now() - started, ok: false, ...errorBody(err) });
    return c.json(errorBody(err), errorStatus(err) as 400);
  }
});

/** Handle a `find_tools` call: rank the catalog and hand back a new phase. */
app.post('/api/mcp/find-tools', async (c) => {
  let body: { url?: unknown; query?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Send a JSON body.', code: 'bad_request' }, 400);
  }
  if (typeof body.url !== 'string' || typeof body.query !== 'string') {
    return c.json({ error: 'Send a url and a query.', code: 'bad_request' }, 400);
  }
  try {
    const { catalog } = await getCatalog(body.url.trim());
    const outcome = handleFindTools(plannerInput(catalog), body.query);
    assertPhaseValid(outcome.phase);
    counters.findTools++;
    log.record('find_tools', { url: body.url, query: body.query, revealed: outcome.available.length, top: outcome.matched.slice(0, 3) });
    return c.json({
      available: outcome.available,
      matched: outcome.matched,
      phase: phasePayload(outcome.phase),
      /** Exactly what goes back in `tool.result`. */
      toolResult: JSON.stringify({
        available_tools: outcome.available.filter((n) => n !== 'find_tools'),
        note: 'These tools are now callable. Call the right one now.',
      }),
    });
  } catch (err) {
    return c.json(errorBody(err), errorStatus(err) as 400);
  }
});

/** Call one tool on the MCP server and shape the result for speech. */
app.post('/api/mcp/call', async (c) => {
  let body: { url?: unknown; tool?: unknown; arguments?: unknown; question?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Send a JSON body.', code: 'bad_request' }, 400);
  }
  if (typeof body.url !== 'string' || typeof body.tool !== 'string') {
    return c.json({ error: 'Send a url and a tool.', code: 'bad_request' }, 400);
  }
  const url = body.url.trim();
  const voiceName = body.tool;
  const rawArgs = (body.arguments ?? {}) as Record<string, unknown>;
  const started = Date.now();

  try {
    const { catalog } = await getCatalog(url);
    const mcpName = catalog.nameMap.get(voiceName);
    if (mcpName === undefined) {
      // The agent asked for a tool this server does not have. Say so in the
      // shape the docs recommend, so it can recover rather than guess.
      return c.json({
        result: JSON.stringify({
          error: `There is no tool called "${voiceName}" on this server. Call find_tools to see what is available.`,
        }),
        spoken: `No tool named ${voiceName} exists here.`,
        isError: true,
        unknownTool: true,
      });
    }

    const entry = catalog.conversion.converted.find((cv) => cv.tool.name === voiceName);
    // Patterns we dropped are no longer enforced upstream, so spoken values get
    // tidied here instead - the handler-side strip the docs prescribe.
    const { args, applied } = applyNormalisers(rawArgs, entry?.report.normalisers ?? []);

    const outcome = await callTool(url, mcpName, args);
    const shaped = await shapeResult(voiceName, outcome.result, {
      shaper,
      question: typeof body.question === 'string' ? body.question : undefined,
    });

    counters.toolCalls++;
    if (shaped.isError) counters.toolFailures++;
    log.record('tool.call', {
      url, voiceName, mcpName, ok: !shaped.isError,
      ms: Date.now() - started,
      mcpMs: outcome.durationMs,
      normalisersApplied: applied,
      rawChars: shaped.rawChars,
      spokenChars: shaped.spokenChars,
      shaped: shaped.shaped,
      method: shaped.method,
      ...(shaped.method === 'llm_failed_local' ? { shaperError: shaperStats.lastError } : {}),
    });

    return c.json({
      result: shaped.result,
      spoken: shaped.spoken,
      raw: shaped.raw,
      isError: shaped.isError,
      shaped: shaped.shaped,
      method: shaped.method,
      rawChars: shaped.rawChars,
      spokenChars: shaped.spokenChars,
      mcpMs: outcome.durationMs,
      totalMs: Date.now() - started,
      normalisersApplied: applied,
      arguments: args,
    });
  } catch (err) {
    counters.toolFailures++;
    const detail = errorBody(err);
    log.record('tool.call.failed', { url, voiceName, ms: Date.now() - started, ok: false, ...detail });
    // A failed tool call is a conversational event, not an HTTP failure: the
    // agent needs a `tool.result` it can speak, or the turn just stalls.
    return c.json({
      result: JSON.stringify({ error: `${detail.code}: ${detail.error}` }),
      spoken: `That call failed: ${detail.error}`,
      isError: true,
      shaped: false,
      method: 'error',
      totalMs: Date.now() - started,
    });
  }
});

/** Counters for the proof page. */
app.get('/api/status', (c) =>
  c.json({
    counters,
    shaper: { ...shaperStats, avgMs: shaperStats.calls > 0 ? Math.round(shaperStats.totalMs / shaperStats.calls) : 0 },
    cache: cacheStats(),
    rate: { trackedKeys: limiter.trackedKeys, globalUsed: limiter.globalUsed, globalPerDay: limiter.globalPerDay, perIpPerHour: limiter.perIpPerHour },
    recent: log.tail(30),
  }),
);

// ------------------------------------------------------------ static web app

const WEB_DIST = 'apps/web/dist';
if (existsSync(WEB_DIST)) {
  app.use('/*', serveStatic({ root: WEB_DIST }));
  app.get('*', serveStatic({ path: `${WEB_DIST}/index.html` }));
} else {
  app.get('/', (c) =>
    c.text(`interpres API is up. The web app is not built yet - run: npm run build -w @interpres/web\n`),
  );
}

// ----------------------------------------------------------------- bootstrap

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  assertConfigured();
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`interpres listening on http://${config.host}:${info.port}`);
    console.log(`  token: ${config.token.expiresInSeconds}s window, ${config.token.maxSessionDurationSeconds}s max session`);
    console.log(`  limits: ${config.limits.perIpPerHour}/IP/hour, ${config.limits.globalPerDay}/day global`);
    console.log(`  web app: ${existsSync(WEB_DIST) ? WEB_DIST : 'not built'}`);
  });
}
