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
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import {
  applyNormalisers, assertPhaseValid, detectPaymentRequired, handleFindTools, initialPhase, paidSentence, priceFromDescription,
  buildGreeting, phaseSessionUpdate, shapeResult, gateTools, MAX_TOOLS_PER_PHASE,
} from '@interpres/core';
import type { Phase, PlannerInput } from '@interpres/core';
import { config, assertConfigured } from './config.ts';
import { RateLimiter, clientKey } from './ratelimit.ts';
import type { Decision } from './ratelimit.ts';
import { EventLog, publicEvent } from './logs.ts';
import { getCatalog, cacheStats, invalidate } from './catalog.ts';
import type { Catalog } from './catalog.ts';
import { McpError, callTool, httpStatus, pool } from './mcp.ts';
import { MESSAGES, UPSTREAM_FAILED, explainFailure, requireServerUrl } from './errors.ts';
import type { Failure } from './errors.ts';
import { SsrfError, ensureVerified } from './ssrf.ts';
import { MIN_QUERY, Registry } from './registry.ts';
import { DISCOVERY_TIMEOUT_MS, DiscoveryCache, discover, domainOf, isSiteRoot } from './discover.ts';
import { CircuitBreaker, makeShaper, newShaperStats } from './shaper.ts';
import { PRESETS, presetFor } from './presets.ts';
import { writeStarters } from './starters.ts';
import type { Starters } from './starters.ts';

const log = new EventLog(config.logPath);
const limiter = new RateLimiter({
  perIpPerHour: config.limits.perIpPerHour,
  globalPerDay: config.limits.globalPerDay,
});
// Connects, searches and discoveries are free to us but make this server fetch
// strangers' URLs, so each has its own per-IP hourly bucket and no daily cap.
const connectLimiter = new RateLimiter({ perIpPerHour: config.limits.connectPerIpPerHour, globalPerDay: Number.POSITIVE_INFINITY });
const searchLimiter = new RateLimiter({ perIpPerHour: config.limits.searchPerIpPerHour, globalPerDay: Number.POSITIVE_INFINITY });
const discoverLimiter = new RateLimiter({ perIpPerHour: config.limits.discoverPerIpPerHour, globalPerDay: Number.POSITIVE_INFINITY });
/** The registry index, read once at start and kept in memory. */
const registry = Registry.load();
const discoveryCache = new DiscoveryCache();
const shaperStats = newShaperStats();
const breaker = new CircuitBreaker();
const shaper = makeShaper({ stats: shaperStats, breaker });
/** Consulted before every Gateway call, so an open breaker costs no wait. */
const shaperAvailable = (): boolean => config.shaperRefine && !breaker.isOpen();

const counters = { tokens: 0, connects: 0, toolCalls: 0, toolFailures: 0, findTools: 0, discoveries: 0, searches: 0, paid: 0 };

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

// ------------------------------------------------------------------ routes

// Even a bug answers in JSON, so the page can always read what went wrong.
app.onError((err, c) => {
  const f = explainFailure(err);
  return c.json(f.body, f.status);
});

app.get('/api/health', (c) => c.json({ ok: true, at: new Date().toISOString() }));

app.get('/api/presets', (c) => c.json({
  presets: PRESETS,
  maxToolsPerPhase: MAX_TOOLS_PER_PHASE,
  // The page's "search N public MCP servers" reads N from here, never from its own copy.
  registry: { count: registry.count, recheckAt: registry.recheckAt, rule: registry.rule },
}));

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
      await res.body?.cancel().catch(() => {});
      log.record('token.error', { status: res.status, ms: Date.now() - started });
      // The upstream body could name the key; never pass it through verbatim.
      return c.json({ error: `AssemblyAI's token service answered ${res.status}. Try again in a minute.`, code: 'token_upstream', kind: 'server_error' }, UPSTREAM_FAILED);
    }
    const body = (await res.json()) as { token?: string };
    if (typeof body.token !== 'string' || body.token === '') {
      return c.json({ error: "AssemblyAI's token service returned no token. Try again in a minute.", code: 'token_upstream', kind: 'server_error' }, UPSTREAM_FAILED);
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
    return c.json({ error: "Couldn't reach AssemblyAI's token service. Try again in a minute.", code: 'token_unreachable', kind: 'unreachable' }, UPSTREAM_FAILED);
  }
});

/**
 * The connect payload for a URL: its converted catalog, the opening phase, and
 * what the gate knows about each tool. Throws what getCatalog throws.
 */
async function connectPayload(url: string, opts: { input: string; notes: string[]; started: number; force?: boolean; discovery?: Record<string, unknown> }) {
  const { catalog, cached } = await getCatalog(url, { force: opts.force });
  const phase = initialPhase(plannerInput(catalog));
  // The API validates none of this, so our own guard is the only one there is.
  assertPhaseValid(phase);

  counters.connects++;
  log.record(cached ? 'mcp.cache.hit' : 'mcp.connect', {
    url, ms: Date.now() - opts.started, ok: true,
    transport: catalog.transport,
    toolsIn: catalog.conversion.stats.toolsIn,
    toolsConverted: catalog.conversion.stats.toolsConverted,
    failed: catalog.conversion.stats.failed,
  });

  const preset = presetFor(url);
  // The gate's view of every tool: whether it changes state (classifier,
  // not just a preset's hand list) and the server's own argument patterns.
  const gate = gateTools(
    catalog.conversion.converted.filter((cv) => cv.source).map((cv) => ({ voiceName: cv.tool.name, source: cv.source! })),
    preset?.writeTools ?? [],
  );
  const gateByName = new Map(gate.map((g) => [g.voiceName, g]));
  return {
    url,
    input: opts.input,
    notes: opts.notes,
    discovery: opts.discovery ?? null,
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
      isWriteTool: gateByName.get(cv.tool.name)?.write ?? false,
      writeReason: gateByName.get(cv.tool.name)?.writeReason ?? '',
    })),
    phase: phasePayload(phase),
    asks: preset?.asks ?? [],
    sampleValue: preset?.sampleValue ?? null,
    gate: { tools: gate, server: new URL(url).host },
  };
}

/** A 429 in the same JSON shape as every other refusal. */
function limited(c: Context, d: Exclude<Decision, { allowed: true }>, error: string) {
  return c.json({ error, code: 'rate_limited', retryAfterSeconds: d.retryAfterSeconds }, 429, { 'retry-after': String(d.retryAfterSeconds) });
}

/** "a, b and c". */
const listSentence = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Discovery's probe: the same path as a connect, so a hit is cached for the connect that follows. */
async function probeForDiscovery(url: string): Promise<{ tools: number; title?: string }> {
  const { catalog } = await getCatalog(url, { timeoutMs: DISCOVERY_TIMEOUT_MS });
  const tools = catalog.conversion.converted.length;
  if (tools === 0) throw new Error('answered with no tools');
  return { tools, title: catalog.server?.title ?? catalog.server?.name };
}

/**
 * A website in, its MCP server out: discovery, then the connect. One answer
 * connects; several come back as a pick list; none is the not-MCP sentence
 * plus everything that was tried.
 */
async function discoverAndConnect(c: Context, a: {
  input: string; url: string; notes: string[]; key: string; started: number; skip?: string[]; firstFailure?: Failure;
}) {
  const target = new URL(a.url);
  // A private address is refused as it is, not searched around.
  const apex = await ensureVerified(target.href).then(() => null, (e: unknown) => e);
  if (apex instanceof SsrfError && apex.code === 'blocked_address') throw apex;

  const cacheKey = `${domainOf(target)}|${isSiteRoot(target) ? 'root' : (a.skip ?? []).join(',')}`;
  let result = discoveryCache.get(cacheKey);
  const cached = result !== undefined;
  if (result === undefined) {
    const d = discoverLimiter.take(a.key);
    if (!d.allowed) {
      if (a.firstFailure) return c.json(a.firstFailure.body, a.firstFailure.status);
      return limited(c, d, `interpres has looked up ${discoverLimiter.perIpPerHour} websites for you this hour, which is the limit. Paste the server's full MCP address instead.`);
    }
    result = await discover(target, { forDomain: (dom) => registry.forDomain(dom), probe: probeForDiscovery }, { skip: a.skip });
    discoveryCache.set(cacheKey, result);
    counters.discoveries++;
  }
  log.record('discover', {
    url: a.url, ok: result.kind !== 'none', ms: result.ms, count: result.tried.length, cached,
    source: result.kind === 'one' ? result.found.source : result.kind,
  });
  const discovery = { ...result, from: a.input, cached };

  if (result.kind === 'one') return c.json(await connectPayload(result.found.url, { input: a.input, notes: a.notes, started: a.started, discovery }));
  if (result.kind === 'several') return c.json({ url: a.url, input: a.input, notes: a.notes, choose: result.candidates, discovery });
  // Nothing found. An address that does not even resolve says so instead.
  if (apex instanceof SsrfError) throw apex;
  return c.json({
    error: `${MESSAGES.notMcp} Nothing on ${result.domain} answered as one: interpres looked in the official MCP registry and tried ${listSentence(result.tried)}.`,
    code: 'not_found',
    kind: 'not_mcp',
    tried: result.tried,
    ...(a.firstFailure?.body.detail ? { detail: a.firstFailure.body.detail } : {}),
    discovery,
  }, UPSTREAM_FAILED);
}

/**
 * Connect to an MCP server, convert its tools, and return the opening phase.
 * A bare domain or site root goes to discovery first; a URL that answers but
 * not as MCP goes there after.
 */
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
  const key = clientKey(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress);
  const allowed = connectLimiter.take(key);
  if (!allowed.allowed) {
    return limited(c, allowed, `That is ${connectLimiter.perIpPerHour} connects from your address this hour, which is the limit. Try again later.`);
  }
  const input = body.url.trim();
  const started = Date.now();
  let url = input;
  let notes: string[] = [];

  try {
    // What was typed becomes what was meant; the SSRF guard then vets that.
    ({ url, notes } = requireServerUrl(input));
    if (isSiteRoot(new URL(url))) return await discoverAndConnect(c, { input, url, notes, key, started });
    try {
      return c.json(await connectPayload(url, { input, notes, started, force: body.force === true }));
    } catch (err) {
      const f = explainFailure(err);
      if (f.body.kind !== 'not_mcp' && f.body.kind !== 'redirect') throw err;
      return await discoverAndConnect(c, { input, url, notes, key, started, skip: [url], firstFailure: f });
    }
  } catch (err) {
    const f = explainFailure(err);
    log.record('mcp.connect.failed', { url, ms: Date.now() - started, ok: false, code: f.body.code, kind: f.body.kind, error: f.body.detail ?? f.body.error });
    return c.json(f.body, f.status);
  }
});

/**
 * Search the registry index: the top 12 on name, host, title and description,
 * two per host at most. Needs two characters.
 */
app.get('/api/registry/search', (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < MIN_QUERY) return c.json({ error: `Type at least ${MIN_QUERY} characters to search.`, code: 'query_too_short' }, 400);
  if (q.length > 100) return c.json({ error: 'That search is too long: 100 characters at most.', code: 'query_too_long' }, 400);
  const d = searchLimiter.take(clientKey(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress));
  if (!d.allowed) return limited(c, d, `That is ${searchLimiter.perIpPerHour} searches from your address this hour, which is the limit. Try again later.`);
  const started = performance.now();
  const { results, cached } = registry.search(q);
  counters.searches++;
  return c.json({ q, total: registry.count, results, cached, ms: Math.round(performance.now() - started) });
});

/** Handle a `find_tools` call: rank the catalog and hand back a new phase. */
/**
 * Three starter questions for the server just connected, written by the LLM
 * Gateway off the speech path, templates when it cannot. One per URL for as
 * long as its catalog is cached, so a busy page does not spend the Gateway.
 */
const startersCache = new Map<string, { starters: Starters; expires: number }>();
app.post('/api/mcp/starters', async (c) => {
  let body: { url?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Send a JSON body.', code: 'bad_request' }, 400);
  }
  if (typeof body.url !== 'string' || body.url.trim() === '') return c.json({ error: 'Send a url.', code: 'bad_request' }, 400);
  try {
    const { url } = requireServerUrl(body.url);
    const hit = startersCache.get(url);
    if (hit && hit.expires > Date.now()) return c.json({ ...hit.starters, cached: true });
    const { catalog } = await getCatalog(url);
    const starters = await writeStarters(catalog, { breaker, paidNames: paidSeen.get(url) ?? [] });
    log.record('starters', { url, source: starters.source, ms: starters.ms, reason: starters.reason, count: starters.questions.length });
    // Templates are not worth keeping: the Gateway may be back in a minute.
    if (starters.source === 'gateway') {
      if (startersCache.size >= config.limits.catalogCacheEntries) startersCache.delete(startersCache.keys().next().value!);
      startersCache.set(url, { starters, expires: Date.now() + config.limits.catalogCacheMs });
    }
    return c.json({ ...starters, cached: false });
  } catch (err) {
    const f = explainFailure(err);
    return c.json(f.body, f.status);
  }
});

app.post('/api/mcp/find-tools', async (c) => {
  let body: { url?: unknown; query?: unknown; lastUserTurn?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Send a JSON body.', code: 'bad_request' }, 400);
  }
  if (typeof body.url !== 'string' || typeof body.query !== 'string') {
    return c.json({ error: 'Send a url and a query.', code: 'bad_request' }, 400);
  }
  try {
    const { catalog } = await getCatalog(requireServerUrl(body.url).url);
    // The caller's last final transcript, so values they spoke ride across the
    // phase change. Capped: it is user speech, not a place to post a novel.
    const lastUserTurn = typeof body.lastUserTurn === 'string' ? body.lastUserTurn.slice(0, 2000) : undefined;
    const outcome = handleFindTools(plannerInput(catalog), body.query, { lastUserTurn });
    assertPhaseValid(outcome.phase);
    counters.findTools++;
    log.record('find_tools', { url: body.url, query: body.query, revealed: outcome.available.length, carried: outcome.carried.length, top: outcome.matched.slice(0, 3) });
    return c.json({
      available: outcome.available,
      matched: outcome.matched,
      phase: phasePayload(outcome.phase),
      /** Exactly what goes back in `tool.result`. */
      toolResult: outcome.toolResult,
      carried: outcome.carried,
    });
  } catch (err) {
    const f = explainFailure(err);
    return c.json(f.body, f.status);
  }
});

/**
 * Tools that have answered with a payment request, per server URL. Starter
 * questions leave them out, as they leave out tools whose description names a
 * price. Bounded: the oldest server is forgotten first.
 */
const paidSeen = new Map<string, Set<string>>();
function markPaid(url: string, mcpName: string): void {
  const seen = paidSeen.get(url) ?? new Set<string>();
  seen.add(mcpName);
  paidSeen.delete(url);
  paidSeen.set(url, seen);
  if (paidSeen.size > config.limits.catalogCacheEntries) paidSeen.delete(paidSeen.keys().next().value!);
}

/**
 * What a paid tool call returns: the plain sentence for the agent and the
 * page, and "paid, x402" for the timeline. The x402 object itself is not
 * passed on: its addresses are not data the caller asked for.
 */
function paidReply(a: { url: string; voiceName: string; mcpName: string; price?: string; started: number; mcpMs?: number; args: Record<string, unknown> }) {
  markPaid(a.url, a.mcpName);
  counters.toolCalls++;
  counters.paid++;
  const sentence = paidSentence(a.price);
  log.record('tool.call', { url: a.url, voiceName: a.voiceName, mcpName: a.mcpName, ok: false, ms: Date.now() - a.started, mcpMs: a.mcpMs, method: 'paid, x402' });
  return {
    result: JSON.stringify({ error: sentence }),
    spoken: sentence,
    isError: true,
    paid: true,
    price: a.price ?? null,
    shaped: false,
    method: 'paid, x402',
    mcpMs: a.mcpMs,
    totalMs: Date.now() - a.started,
    arguments: a.args,
  };
}

/** Call one tool on the MCP server and shape the result for speech. */
app.post('/api/mcp/call', async (c) => {
  let body: { url?: unknown; tool?: unknown; arguments?: unknown; question?: unknown; session?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Send a JSON body.', code: 'bad_request' }, 400);
  }
  if (typeof body.url !== 'string' || typeof body.tool !== 'string') {
    return c.json({ error: 'Send a url and a tool.', code: 'bad_request' }, 400);
  }
  let url: string;
  try {
    url = requireServerUrl(body.url).url;
  } catch (err) {
    const f = explainFailure(err);
    return c.json(f.body, f.status);
  }
  const voiceName = body.tool;
  const rawArgs = (body.arguments ?? {}) as Record<string, unknown>;
  const started = Date.now();
  // Known before the call goes out, so a thrown 402 can still name the price.
  let mcpName: string | undefined;
  let description: string | undefined;

  try {
    const { catalog } = await getCatalog(url);
    mcpName = catalog.nameMap.get(voiceName);
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
    // The tool's own description: the converted one can be cut short before its price.
    description = entry?.source?.description;
    // Patterns we dropped are no longer enforced upstream, so spoken values get
    // tidied here instead - the handler-side strip the docs prescribe.
    const { args, applied } = applyNormalisers(rawArgs, entry?.report.normalisers ?? []);

    // The Voice Agent session_id keys a warm MCP client for that conversation.
    const poolKey = typeof body.session === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.session) ? body.session : undefined;
    const outcome = await callTool(url, mcpName, args, { poolKey });
    // A paid tool answers with an x402 payment request, not data: one sentence, never the JSON.
    const pay = detectPaymentRequired(outcome.result);
    if (pay) {
      return c.json(paidReply({ url, voiceName, mcpName, price: pay.price ?? priceFromDescription(description), started, mcpMs: outcome.durationMs, args }));
    }
    const shaped = await shapeResult(voiceName, outcome.result, {
      shaper,
      shaperAvailable,
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
      refine: shaped.refine,
      refineMs: shaped.refineMs,
      ...(shaped.refine === 'error' ? { shaperError: shaperStats.lastError } : {}),
    });

    return c.json({
      result: shaped.result,
      spoken: shaped.spoken,
      raw: shaped.raw,
      isError: shaped.isError,
      shaped: shaped.shaped,
      method: shaped.method,
      refine: shaped.refine,
      refineMs: shaped.refineMs,
      rawChars: shaped.rawChars,
      spokenChars: shaped.spokenChars,
      mcpMs: outcome.durationMs,
      totalMs: Date.now() - started,
      normalisersApplied: applied,
      arguments: args,
    });
  } catch (err) {
    // The same request, refused at the HTTP level: a 402.
    if (mcpName !== undefined && err instanceof McpError && httpStatus(err.detail) === 402) {
      const body402 = err.detail.match(/\{[\s\S]*\}/)?.[0];
      let fromBody: string | undefined;
      try { fromBody = body402 ? detectPaymentRequired(JSON.parse(body402))?.price : undefined; } catch { /* not JSON */ }
      return c.json(paidReply({ url, voiceName, mcpName, price: fromBody ?? priceFromDescription(description), started, args: rawArgs }));
    }
    counters.toolFailures++;
    const f = explainFailure(err);
    log.record('tool.call.failed', { url, voiceName, ms: Date.now() - started, ok: false, code: f.body.code, kind: f.body.kind, error: f.body.detail ?? f.body.error });
    // A failed tool call is a conversational event, not an HTTP failure: the
    // agent needs a `tool.result` it can speak, or the turn just stalls. It gets
    // the same plain sentence the page shows, never an upstream body.
    return c.json({
      result: JSON.stringify({ error: f.body.error }),
      spoken: f.body.error,
      raw: f.body.detail,
      isError: true,
      code: f.body.code,
      kind: f.body.kind,
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
    shaper: {
      ...shaperStats,
      avgMs: shaperStats.calls > 0 ? Math.round(shaperStats.totalMs / shaperStats.calls) : 0,
      breakerOpen: breaker.isOpen(),
      breakerSecondsLeft: breaker.secondsLeft(),
      breakerTrips: breaker.trips,
    },
    cache: cacheStats(),
    mcpPool: { warm: pool.size, opened: pool.opened },
    rate: { trackedKeys: limiter.trackedKeys, globalUsed: limiter.globalUsed, globalPerDay: limiter.globalPerDay, perIpPerHour: limiter.perIpPerHour },
    recent: log.tail(30).map(publicEvent),
  }),
);

// ------------------------------------------------------------ static web app

const WEB_DIST = 'apps/web/dist';
/** Per-app prefixed entry rather than index.html: many apps share the box. */
const WEB_ENTRY = 'interpres-index.html';
if (existsSync(`${WEB_DIST}/${WEB_ENTRY}`)) {
  const serveEntry = serveStatic({ path: `${WEB_DIST}/${WEB_ENTRY}` });
  // The page always revalidates. Without this a browser caches it by heuristic,
  // and after a redeploy a returning visitor gets old HTML asking for bundles
  // that no longer exist (seen locally after a rebuild: two 404s, a dead page).
  const entry: typeof serveEntry = async (c, next) => {
    const res = await serveEntry(c, next);
    if (res) res.headers.set('Cache-Control', 'no-cache');
    return res;
  };
  app.get('/', entry);
  // The share-card image, at the fixed absolute URL the og:image tag names.
  // Without this route the catch-all below would answer it with the page.
  const serveOg = serveStatic({ path: `${WEB_DIST}/og.png` });
  app.get('/og.png', async (c, next) => {
    const res = await serveOg(c, next);
    if (res && res.status === 200) res.headers.set('Cache-Control', 'public, max-age=3600');
    return res ?? c.notFound();
  });
  // The replay's recording. Hono's MIME table has no .m4a, and Safari will not
  // play audio served as application/octet-stream. Registered first, so it wraps
  // the static handler and fixes the header on the way out.
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.req.path.endsWith('.m4a')) c.header('Content-Type', 'audio/mp4');
    // Hashed names never change content, so a found asset can be kept for good.
    if (c.res.status === 200 || c.res.status === 206) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('/assets/*', serveStatic({ root: WEB_DIST }));
  // A missing hashed asset is a 404, not the app: after a redeploy, a stale page
  // asking for an old bundle would otherwise be handed HTML as JavaScript.
  app.get('/assets/*', (c) => c.notFound());
  // Any other GET is the app itself (for ?url= links), except an unknown API
  // path, which must 404 as JSON rather than come back as a 200 HTML page.
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found', code: 'not_found' }, 404);
    return (await entry(c, next)) ?? c.notFound();
  });
} else {
  app.get('/', (c) => c.text('interpres API is up. The web app is not built yet - run: npm run build -w @interpres/web\n'));
}

// ----------------------------------------------------------------- bootstrap

/** Binds the server. `serve.ts` calls this for process managers; `node index.ts` does too, below. */
export function start(): void {
  assertConfigured();
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`interpres listening on http://${config.host}:${info.port}`);
    console.log(`  token: ${config.token.expiresInSeconds}s window, ${config.token.maxSessionDurationSeconds}s max session`);
    console.log(`  limits: ${config.limits.perIpPerHour}/IP/hour, ${config.limits.globalPerDay}/day global`);
    console.log(`  web app: ${existsSync(WEB_DIST) ? WEB_DIST : 'not built'}`);
  });
}

// True only for `node apps/server/src/index.ts`. Under PM2 it is false, because
// PM2's fork container is argv[1] and imports this file: use serve.ts there.
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) start();
