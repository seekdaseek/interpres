/**
 * End-to-end proof, without a microphone.
 *
 * Opens a real Voice Agent session, registers a real MCP server's converted
 * tools, injects a user turn as text, and lets the agent do the rest: it decides
 * to call a tool, we run it against the MCP server, hand back the shaped result,
 * and wait for the spoken answer that uses it.
 *
 * It takes the browser's path exactly - mint a token, connect with `?token=` -
 * rather than the Authorization header a Node client could use, so what passes
 * here is what the demo does.
 *
 *   node --env-file=.env scripts/e2e.ts [--preset <url>] [--ask "question"] [--verbose]
 */
import { writeFile, mkdir } from 'node:fs/promises';
import {
  applyNormalisers, buildNameMap, convertCatalog, handleFindTools, initialPhase,
  assertPhaseValid, shapeResult, FIND_TOOLS_NAME,
} from '@interpres/core';
import type { ConvertedTool, McpServerInfo, PlannerInput } from '@interpres/core';
import { probeServer, callTool } from '../apps/server/src/mcp.ts';
import { makeShaper } from '../apps/server/src/shaper.ts';
import type { ShaperStats } from '../apps/server/src/shaper.ts';
import { config } from '../apps/server/src/config.ts';
import { PRESETS } from '../apps/server/src/presets.ts';

const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
const VOICE = 'alba';

type Args = { preset?: string; ask?: string[]; verbose: boolean; out?: string };

function parseArgs(argv: string[]): Args {
  const out: Args = { verbose: false, ask: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') out.preset = argv[++i];
    else if (a === '--ask') out.ask!.push(argv[++i] ?? '');
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--out') out.out = argv[++i];
  }
  if (out.ask!.length === 0) delete out.ask;
  return out;
}

async function mintToken(): Promise<string> {
  const url = new URL(`${config.agentsApi}/token`);
  url.searchParams.set('expires_in_seconds', '120');
  url.searchParams.set('max_session_duration_seconds', '300');
  const res = await fetch(url, { headers: { authorization: `Bearer ${config.assemblyAiKey}` } });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('token endpoint returned no token');
  return body.token;
}

export type ToolCallRecord = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  mcpName?: string;
  normalisersApplied?: string[];
  rawChars?: number;
  spokenChars?: number;
  spoken?: string;
  shapeMethod?: string;
  isError?: boolean;
  mcpMs?: number;
  totalMs?: number;
};

export type TurnResult = {
  ask: string;
  agentReply: string;
  toolCalls: ToolCallRecord[];
  phaseChanges: string[];
  ms: number;
};

export type E2EResult = {
  url: string;
  server: McpServerInfo | undefined;
  sessionId: string;
  catalogSize: number;
  turns: TurnResult[];
  events: Record<string, number>;
  ok: boolean;
  failures: string[];
};

/** One session against one MCP server, asking each question in turn. */
async function runPreset(url: string, asks: string[], verbose: boolean): Promise<E2EResult> {
  const failures: string[] = [];
  const eventCounts: Record<string, number> = {};

  console.log(`\n${'='.repeat(78)}\n${url}\n${'='.repeat(78)}`);

  // 1. Real MCP server, real tools/list, real conversion.
  const connection = await probeServer(url);
  const conversion = convertCatalog(connection.tools, { reserved: [FIND_TOOLS_NAME] });
  const nameMap = buildNameMap(conversion.converted);
  const planner: PlannerInput = {
    catalog: conversion.converted,
    server: connection.serverInfo,
    instructions: connection.instructions,
  };
  let phase = initialPhase(planner);
  assertPhaseValid(phase);
  console.log(
    `MCP: ${connection.serverInfo?.name} v${connection.serverInfo?.version} over ${connection.transport}, ` +
      `${conversion.stats.toolsConverted}/${conversion.stats.toolsIn} tools converted`,
  );
  console.log(`phase 0 (${phase.reason}): ${phase.tools.map((t) => t.name).join(', ')}`);

  const shaperStats: ShaperStats = { calls: 0, failures: 0, totalMs: 0, retries: 0 };
  const shaper = makeShaper(shaperStats);
  const byVoiceName = new Map<string, ConvertedTool>(conversion.converted.map((c) => [c.tool.name, c]));

  // 2. Open the session the way the browser does.
  const token = await mintToken();
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

  let sessionId = '';
  let lastEvent = '';
  const pending: Array<{ call_id: string; result: string }> = [];
  const turns: TurnResult[] = [];

  let currentTurn: TurnResult | null = null;
  let turnResolve: (() => void) | null = null;
  /** Tool handlers still running. A turn cannot be finished while any is. */
  let inFlight = 0;
  /**
   * True once a `tool.result` has gone out. Sending one auto-fires the agent's
   * next reply, so the reply.done after that is the answer rather than the
   * transition phrase - and the turn is only over then.
   */
  let awaitingAnswer = false;

  const send = (msg: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    if (verbose) console.log(`  -> ${(msg as { type: string }).type}`);
  };

  const flushIfIdle = (): void => {
    if (lastEvent !== 'reply.done' || pending.length === 0) return;
    for (const p of pending) send({ type: 'tool.result', call_id: p.call_id, result: p.result });
    pending.length = 0;
    awaitingAnswer = true;
  };

  const ready = new Promise<void>((resolve, reject) => {
    const failTimer = setTimeout(() => reject(new Error('no session.ready within 20s')), 20_000);
    ws.addEventListener('message', (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
      const type = String(msg.type ?? '');
      eventCounts[type] = (eventCounts[type] ?? 0) + 1;
      if (verbose && type !== 'reply.audio' && type !== 'transcript.agent.delta') {
        console.log(`  <- ${type}${type === 'session.error' ? ` ${JSON.stringify(msg)}` : ''}`);
      }

      switch (type) {
        case 'session.ready': {
          sessionId = String(msg.session_id ?? '');
          clearTimeout(failTimer);
          resolve();
          break;
        }
        case 'session.error': {
          const detail = `${String(msg.code)}: ${String(msg.message)}`;
          failures.push(`session.error ${detail}`);
          console.log(`  !! session.error ${detail}`);
          clearTimeout(failTimer);
          reject(new Error(detail));
          break;
        }
        case 'reply.started':
        case 'input.speech.started':
          lastEvent = type;
          break;

        case 'tool.call': {
          const callId = String(msg.call_id ?? '');
          const name = String(msg.name ?? '');
          const args = (msg.arguments ?? {}) as Record<string, unknown>;
          const record: ToolCallRecord = { callId, name, arguments: args };
          currentTurn?.toolCalls.push(record);
          console.log(`  TOOL.CALL ${name}(${JSON.stringify(args)})`);
          inFlight++;
          void (async () => {
            const started = Date.now();
            try {
              if (name === FIND_TOOLS_NAME) {
                // The phase planner runs here, exactly as the browser runs it.
                const query = String((args as { query?: unknown }).query ?? '');
                const outcome = handleFindTools(planner, query);
                assertPhaseValid(outcome.phase);
                phase = outcome.phase;
                send({
                  type: 'session.update',
                  session: {
                    system_prompt: phase.systemPrompt,
                    tools: phase.tools,
                    input: { keyterms: phase.keyterms, transcription_prompt: phase.transcriptionPrompt },
                  },
                });
                currentTurn?.phaseChanges.push(`find_tools(${JSON.stringify(query)}) -> ${outcome.available.join(', ')}`);
                console.log(`  PHASE -> ${outcome.available.join(', ')}`);
                record.spoken = outcome.available.filter((n) => n !== FIND_TOOLS_NAME).join(', ');
                record.shapeMethod = 'phase_change';
                record.totalMs = Date.now() - started;
                pending.push({
                  call_id: callId,
                  result: JSON.stringify({
                    available_tools: outcome.available.filter((n) => n !== FIND_TOOLS_NAME),
                    note: 'These tools are now callable. Call the right one now.',
                  }),
                });
                flushIfIdle();
                return;
              }

              const mcpName = nameMap.get(name);
              if (mcpName === undefined) {
                failures.push(`agent called unknown tool ${name}`);
                pending.push({ call_id: callId, result: JSON.stringify({ error: `No tool named ${name}. Call find_tools.` }) });
                flushIfIdle();
                return;
              }
              record.mcpName = mcpName;
              const entry = byVoiceName.get(name);
              const { args: normalised, applied } = applyNormalisers(args, entry?.report.normalisers ?? []);
              record.normalisersApplied = applied;

              const outcome = await callTool(url, mcpName, normalised);
              const shaped = await shapeResult(name, outcome.result, { shaper, question: currentTurn?.ask });
              record.rawChars = shaped.rawChars;
              record.spokenChars = shaped.spokenChars;
              record.spoken = shaped.spoken;
              record.shapeMethod = shaped.method;
              record.isError = shaped.isError;
              record.mcpMs = outcome.durationMs;
              record.totalMs = Date.now() - started;
              console.log(
                `  RESULT  ${mcpName}: ${shaped.rawChars} chars raw -> ${shaped.spokenChars} spoken ` +
                  `[${shaped.method}] in ${outcome.durationMs}ms`,
              );
              console.log(`  SHAPED  ${shaped.spoken.slice(0, 200)}`);
              pending.push({ call_id: callId, result: shaped.result });
              flushIfIdle();
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              failures.push(`tool ${name} threw: ${detail}`);
              record.isError = true;
              record.spoken = detail;
              pending.push({ call_id: callId, result: JSON.stringify({ error: detail }) });
            } finally {
              inFlight--;
              // The tool may well have finished AFTER reply.done already fired,
              // which is exactly the case the docs warn about: "Call
              // flushIfIdle() from the tool.call handler."
              flushIfIdle();
            }
          })();
          break;
        }

        case 'transcript.agent': {
          const text = String(msg.text ?? '');
          if (currentTurn && text.trim() !== '') {
            currentTurn.agentReply = currentTurn.agentReply ? `${currentTurn.agentReply} ${text}` : text;
          }
          break;
        }

        case 'reply.done': {
          lastEvent = 'reply.done';
          if (msg.status === 'interrupted') {
            // "Discard any pending tool.result accumulators from the just-ended
            // reply." Nothing we send now belongs to a live turn.
            pending.length = 0;
            awaitingAnswer = false;
            turnResolve?.();
            break;
          }
          // Captured before the flush, because the flush itself sets the flag.
          const wasAwaiting = awaitingAnswer;
          flushIfIdle();
          if (inFlight > 0 || pending.length > 0) break;   // a tool is still running
          if (wasAwaiting) {
            // Results went out earlier, so this reply is the answer.
            awaitingAnswer = false;
            turnResolve?.();
            break;
          }
          if (awaitingAnswer) break;    // results just went out; the answer is next
          turnResolve?.();
          break;
        }
        default:
          break;
      }
    });
    ws.addEventListener('error', () => reject(new Error('websocket error')));
    ws.addEventListener('close', (ev) => {
      const e = ev as CloseEvent;
      if (sessionId === '') reject(new Error(`socket closed before session.ready (code ${e.code})`));
    });
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('could not open the websocket')), { once: true });
  });

  // No greeting: "omit it to listen first", which keeps the event flow clean.
  send({
    type: 'session.update',
    session: {
      system_prompt: phase.systemPrompt,
      tools: phase.tools,
      input: { keyterms: phase.keyterms, transcription_prompt: phase.transcriptionPrompt },
      output: { voice: VOICE, format: { encoding: 'audio/pcm' } },
    },
  });

  await ready;
  console.log(`session.ready  session_id=${sessionId}`);

  // 3. Each question as an injected user turn.
  for (const ask of asks) {
    console.log(`\n--- ASK: ${ask}`);
    const started = Date.now();
    currentTurn = { ask, agentReply: '', toolCalls: [], phaseChanges: [], ms: 0 };
    awaitingAnswer = false;
    inFlight = 0;
    pending.length = 0;

    const done = new Promise<void>((resolve) => {
      let settled = false;
      turnResolve = () => { if (!settled) { settled = true; resolve(); } };
      setTimeout(() => { if (!settled) { settled = true; failures.push(`turn timed out: ${ask}`); resolve(); } }, 90_000);
    });

    // `conversation.message` seeds the context; it does not make the agent
    // speak, so `reply.create` is what starts the turn.
    // `conversation.message` puts the question in the conversation history, which
    // is what the tool-argument inference reads ("tool calls infer argument
    // values only from user turns and tool results"). On its own, though, a bare
    // `reply.create` had the agent inventing a generic query, so the question is
    // also passed as the one-shot `instructions` for this reply.
    send({ type: 'conversation.message', role: 'user', content: ask });
    await new Promise((r) => setTimeout(r, 400));
    send({
      type: 'reply.create',
      instructions:
        `The person just asked, out loud: "${ask}" ` +
        `Answer exactly that question. If you need a tool, call it with arguments drawn from ` +
        `that question and nothing else.`,
    });

    await done;
    currentTurn.ms = Date.now() - started;
    if (currentTurn.agentReply.trim() === '') failures.push(`no agent reply for: ${ask}`);
    console.log(`  AGENT (${currentTurn.ms}ms): ${currentTurn.agentReply || '(nothing)'}`);
    turns.push(currentTurn);
    currentTurn = null;
  }

  send({ type: 'session.end' });
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000);
    ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
  });

  return {
    url,
    server: connection.serverInfo,
    sessionId,
    catalogSize: conversion.converted.length,
    turns,
    events: eventCounts,
    ok: failures.length === 0,
    failures,
  };
}

// --------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
if (config.assemblyAiKey === '') {
  console.error('ASSEMBLYAI_API_KEY is not set. Run with: node --env-file=.env scripts/e2e.ts');
  process.exit(2);
}

const targets = args.preset
  ? [{ url: args.preset, asks: args.ask ?? ['What can you do?'] }]
  : PRESETS.map((p) => ({ url: p.url, asks: args.ask ?? p.asks.slice(0, 2) }));

const results: E2EResult[] = [];
for (const t of targets) {
  try {
    results.push(await runPreset(t.url, t.asks, args.verbose));
  } catch (err) {
    console.log(`\n!! ${t.url} failed: ${err instanceof Error ? err.message : String(err)}`);
    results.push({
      url: t.url, server: undefined, sessionId: '', catalogSize: 0, turns: [], events: {},
      ok: false, failures: [err instanceof Error ? err.message : String(err)],
    });
  }
}

console.log(`\n${'#'.repeat(78)}\nSUMMARY`);
let totalCalls = 0;
let okCalls = 0;
for (const r of results) {
  const calls = r.turns.flatMap((t) => t.toolCalls);
  totalCalls += calls.length;
  okCalls += calls.filter((c) => !c.isError).length;
  console.log(
    `${r.ok ? 'ok  ' : 'FAIL'} ${r.url}\n` +
      `     session_id=${r.sessionId || '(none)'} turns=${r.turns.length} tool_calls=${calls.length} ` +
      `replies=${r.turns.filter((t) => t.agentReply.trim() !== '').length}`,
  );
  for (const f of r.failures) console.log(`     ! ${f}`);
}
console.log(`\ntool calls: ${okCalls}/${totalCalls} succeeded`);
console.log(`session ids: ${results.map((r) => r.sessionId).filter(Boolean).join(', ')}`);

const outPath = args.out ?? `data/e2e-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
await mkdir('data', { recursive: true });
await writeFile(outPath, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
console.log(`\nwritten: ${outPath}`);

process.exit(results.every((r) => r.ok) ? 0 : 1);
