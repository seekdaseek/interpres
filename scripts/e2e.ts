/**
 * FALLBACK HARNESS - text injection, not speech.
 *
 * The main proof path is `scripts/e2e-audio.ts`, which streams real synthesised
 * speech through `input.audio` exactly as a microphone would. This script
 * injects each question as text instead: `conversation.message` puts it in the
 * history, and `reply.create.instructions` makes the agent act on it. It is
 * quicker and needs no audio tooling, but it is a different input path, and it
 * gets one thing measurably wrong: an injected message does not count as a user
 * turn for argument inference. At CHECKPOINT A an argument given this way did
 * not survive a `find_tools` phase change; spoken, the same argument does
 * (data/e2e-audio-afg-natural.json). Use this for quick protocol checks only.
 *
 * It drives the same `AgentProtocol` state machine as the browser and the audio
 * harness, through `scripts/lib/session.ts`.
 *
 *   node --env-file=.env scripts/e2e.ts [--preset <url>] [--ask "question"] [--verbose] [--out file]
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { PRESETS } from '../apps/server/src/presets.ts';
import { config } from '../apps/server/src/config.ts';
import { LiveSession } from './lib/session.ts';
import type { TurnRecord } from './lib/session.ts';

type Args = { preset?: string; ask: string[]; verbose: boolean; out?: string };

function parseArgs(argv: string[]): Args {
  const out: Args = { ask: [], verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') out.preset = argv[++i];
    else if (a === '--ask') out.ask.push(argv[++i] ?? '');
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

type Result = { url: string; sessionId: string; turns: TurnRecord[]; events: Record<string, number>; failures: string[]; ok: boolean };

async function runPreset(url: string, asks: string[], verbose: boolean): Promise<Result> {
  console.log(`\n${'='.repeat(78)}\n${url}  [TEXT-INJECTION FALLBACK]\n${'='.repeat(78)}`);
  const session = await LiveSession.open(url, { verbose });
  console.log(`phase 0 (${session.phase.reason}): ${session.phase.tools.map((t) => t.name).join(', ')}`);
  console.log(`session.ready  session_id=${session.sessionId}`);
  const turns: TurnRecord[] = [];
  for (const ask of asks) {
    console.log(`\n--- ASK (injected text): ${ask}`);
    session.beginTurn(ask);
    // Without a spoken turn, the injected text is also what the planner and the
    // shaper treat as the caller's words.
    session.lastUserTranscript = ask;
    const idle = session.waitIdle(90_000);
    session.sendRaw({ type: 'conversation.message', role: 'user', content: ask });
    await new Promise((r) => setTimeout(r, 400));
    session.sendRaw({
      type: 'reply.create',
      instructions:
        `The person just asked, out loud: "${ask}" Answer exactly that question. ` +
        `If you need a tool, call it with arguments drawn from that question and nothing else.`,
    });
    if ((await idle) === 'timeout') session.failures.push(`turn timed out: ${ask}`);
    const t = session.endTurn()!;
    if (t.agentReply.trim() === '') session.failures.push(`no agent reply for: ${ask}`);
    console.log(`  AGENT (${t.ms}ms): ${t.agentReply || '(nothing)'}`);
    turns.push(t);
  }
  await session.close();
  return { url, sessionId: session.sessionId, turns, events: session.events, failures: session.failures, ok: session.failures.length === 0 };
}

const args = parseArgs(process.argv.slice(2));
if (config.assemblyAiKey === '') {
  console.error('ASSEMBLYAI_API_KEY is not set. Run with: node --env-file=.env scripts/e2e.ts');
  process.exit(2);
}
const targets = args.preset
  ? [{ url: args.preset, asks: args.ask.length > 0 ? args.ask : ['What can you do?'] }]
  : PRESETS.map((p) => ({ url: p.url, asks: args.ask.length > 0 ? args.ask : p.asks.slice(0, 2) }));

const results: Result[] = [];
for (const t of targets) {
  try {
    results.push(await runPreset(t.url, t.asks, args.verbose));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`\n!! ${t.url} failed: ${detail}`);
    results.push({ url: t.url, sessionId: '', turns: [], events: {}, failures: [detail], ok: false });
  }
}

console.log(`\n${'#'.repeat(78)}\nSUMMARY (text-injection fallback)`);
for (const r of results) {
  const calls = r.turns.flatMap((t) => t.calls);
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.url}\n     session_id=${r.sessionId || '(none)'} turns=${r.turns.length} tool_calls=${calls.length}`);
  for (const f of r.failures) console.log(`     ! ${f}`);
}
const outPath = args.out ?? `data/e2e-text-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
await mkdir('data', { recursive: true });
await writeFile(outPath, `${JSON.stringify({ at: new Date().toISOString(), harness: 'text-injection-fallback', results }, null, 2)}\n`);
console.log(`\nwritten: ${outPath}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
