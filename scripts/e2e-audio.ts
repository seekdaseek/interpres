/**
 * MAIN PROOF PATH - real speech through `input.audio`.
 *
 * Every question is synthesised with macOS `say`, converted to the API's input
 * format with `afconvert` (24 kHz, mono, 16-bit little-endian PCM), and streamed
 * in 40 ms chunks at real-time pace through a continuous microphone stand-in,
 * followed by 1.5 s of silence so turn detection closes the turn. The agent
 * hears speech exactly as it would from a browser microphone, so the user turn,
 * `transcript.user`, turn detection and argument inference are all the real
 * thing - which the text-injection harness in `e2e.ts` is not.
 *
 *   node --env-file=.env scripts/e2e-audio.ts                  every preset, spoken
 *   node --env-file=.env scripts/e2e-audio.ts --case afg-address
 *   node --env-file=.env scripts/e2e-audio.ts --preset <url> --say "..." [--say "..."]
 *   options: --voice Samantha --rate 175 --verbose --out <file>
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { PRESETS } from '../apps/server/src/presets.ts';
import { config } from '../apps/server/src/config.ts';
import { AudioPump, synthesize, silence } from './lib/audio.ts';
import { LiveSession } from './lib/session.ts';
import type { TurnRecord } from './lib/session.ts';

const TRAILING_SILENCE_MS = 1500;
const TURN_TIMEOUT_MS = 120_000;

/**
 * The afg case CHECKPOINT A could not settle: an argument spoken before a phase
 * change. Two addresses:
 *
 *   afg-address  the EIP-55 test vector, read one character at a time the way a
 *                person reads an address aloud. Tests the phase change itself.
 *   afg-zeros    0x followed by 39 zeros and a 1, the address used at
 *                CHECKPOINT A. Adversarial for speech-to-text: 39 identical
 *                tokens in a row. Kept to record what happens to it.
 */
export const ADDRESSES: Record<string, { address: string; asks: string[]; startPhaseQuery?: string; mustBeHidden?: string }> = {
  /**
   * The phase-change test. Turn 1 asks about the job flow, which swaps in a phase
   * WITHOUT afg_get_reputation (observed at CHECKPOINT A). Turn 2 then speaks the
   * address, so the agent must call find_tools, take the swap, and only then
   * reach the tool - the argument has to cross the phase change. The address has
   * no two identical characters side by side, so a speech-to-text merge of
   * doubled letters cannot confound the result; that failure is measured on its
   * own by afg-address.
   */
  'afg-phase': {
    address: '0x3f9a1c7e5b2d8f4a6c0e9b3d7f1a5c8e2b4d6f09',
    // The phase find_tools produced live at CHECKPOINT A for this query. It
    // leaves afg_get_reputation out, so the spoken address MUST cross a swap.
    startPhaseQuery: 'official job flow and limits',
    mustBeHidden: 'afg_get_reputation',
    asks: [
      'What is the reputation of wallet 0 x 3 f 9 a 1 c 7 e 5 b 2 d 8 f 4 a 6 c 0 e 9 b 3 d 7 f 1 a 5 c 8 e 2 b 4 d 6 f 0 9?',
    ],
  },
  /**
   * The same crossing with no harness help at all. Turn 1 asks for something
   * only a hidden tool can do, so the agent itself calls find_tools and the swap
   * it gets hides afg_get_reputation (checked offline with handleFindTools).
   * Turn 2 speaks the address, so a second swap is needed to reach the tool.
   */
  'afg-natural': {
    address: '0x3f9a1c7e5b2d8f4a6c0e9b3d7f1a5c8e2b4d6f09',
    asks: [
      'I want to run a spec check on a job contract.',
      'Actually, first tell me the reputation of wallet 0 x 3 f 9 a 1 c 7 e 5 b 2 d 8 f 4 a 6 c 0 e 9 b 3 d 7 f 1 a 5 c 8 e 2 b 4 d 6 f 0 9.',
    ],
  },
  /** The EIP-55 test vector, read one character at a time. Has doubled letters. */
  'afg-address': {
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    asks: ['What is the reputation of wallet 0 x 5 a a e b 6 0 5 3 f 3 e 9 4 c 9 b 9 a 0 9 f 3 3 6 6 9 4 3 5 e 7 e f 1 b e a e d?'],
  },
  /** The CHECKPOINT A address: 39 identical tokens in a row, adversarial for STT. */
  'afg-zeros': {
    address: '0x0000000000000000000000000000000000000001',
    asks: ['What is the reputation of wallet 0x0000000000000000000000000000000000000001?'],
  },
};

type Args = { preset?: string; say: string[]; caseName?: string; voice: string; rate?: number; verbose: boolean; out?: string; carry: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { say: [], voice: 'Samantha', verbose: false, carry: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--preset') { a.preset = v; i++; }
    else if (k === '--say') { a.say.push(v ?? ''); i++; }
    else if (k === '--case') { a.caseName = v; i++; }
    else if (k === '--voice') { a.voice = v ?? a.voice; i++; }
    else if (k === '--rate') { a.rate = Number(v); i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--verbose') a.verbose = true;
    else if (k === '--no-carry') a.carry = false;
  }
  return a;
}

export type AddressVerdict = {
  spoken: string;
  heard: string[];
  findToolsCalled: boolean;
  reputationCalledAfterPhaseChange: boolean;
  /** The argument the tool actually received, as the agent produced it. */
  addressArgument: string | null;
  /** Did the argument survive the phase change at all? */
  survived: boolean;
  /** And does it match what was spoken, character for character? */
  exact: boolean;
};

function judgeAddressCase(turn: TurnRecord, spokenAddress: string): AddressVerdict {
  const findIdx = turn.calls.findIndex((c) => c.name === 'find_tools');
  const rep = turn.calls.find((c, i) => c.name === 'afg_get_reputation' && i > findIdx);
  const arg = rep ? String(rep.arguments.address ?? '') : null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  return {
    spoken: spokenAddress,
    heard: turn.heard,
    findToolsCalled: findIdx >= 0,
    reputationCalledAfterPhaseChange: rep !== undefined && findIdx >= 0,
    addressArgument: arg,
    survived: rep !== undefined && arg !== null && arg.trim() !== '',
    exact: arg !== null && norm(arg) === norm(spokenAddress),
  };
}

type TargetResult = {
  url: string;
  sessionId: string;
  /** Every agent reply in the session: when it started, when audio arrived, how much. */
  replies?: Array<{ startedAt: number; firstAudioAt?: number; audioMs: number; doneAt?: number }>;
  turns: TurnRecord[];
  events: Record<string, number>;
  failures: string[];
  audio: { chunksSent: number; reanchors: number };
  shaper: Record<string, unknown>;
  addressVerdict?: AddressVerdict;
  ok: boolean;
};

async function runTarget(
  url: string,
  asks: string[],
  args: Args,
  spokenAddress?: string,
  setup: { startPhaseQuery?: string; mustBeHidden?: string } = {},
): Promise<TargetResult> {
  console.log(`\n${'='.repeat(78)}\n${url}\n${'='.repeat(78)}`);

  // Synthesise before opening the session: `say` + `afconvert` take a second or
  // two, and a token's redemption window should not be spent waiting on them.
  const clips = [];
  for (const text of asks) {
    const s = await synthesize(text, { voice: args.voice, rate: args.rate });
    console.log(`  audio: ${s.durationMs} ms of speech | ${s.afinfo}`);
    clips.push({ text, ...s });
  }

  const session = await LiveSession.open(url, { verbose: args.verbose, carry: args.carry, startPhaseQuery: setup.startPhaseQuery });
  console.log(`carry across phase changes: ${args.carry ? 'ON' : 'OFF (A/B baseline)'}`);
  if (setup.startPhaseQuery) {
    const visible = session.phase.tools.map((t) => t.name);
    console.log(`HARNESS-SET start phase = find_tools(${JSON.stringify(setup.startPhaseQuery)})`);
    if (setup.mustBeHidden && visible.includes(setup.mustBeHidden)) {
      throw new Error(`precondition failed: ${setup.mustBeHidden} is visible in the start phase, so no swap would be needed`);
    }
    if (setup.mustBeHidden) console.log(`precondition ok: ${setup.mustBeHidden} is NOT callable until find_tools swaps it in`);
  }
  console.log(`MCP: ${session.catalog.connection.serverInfo?.name} v${session.catalog.connection.serverInfo?.version}, ${session.catalog.stats.toolsConverted}/${session.catalog.stats.toolsIn} tools`);
  console.log(`phase 0 (${session.phase.reason}): ${session.phase.tools.map((t) => t.name).join(', ')}`);
  console.log(`session.ready  session_id=${session.sessionId}`);

  // Only after session.ready, per the docs. From here to the end the pump sends
  // audio continuously, silence included, like a live microphone.
  const pump = new AudioPump((b64) => session.sendAudio(b64));
  pump.start();
  await pump.enqueue(silence(400));

  const turns: TurnRecord[] = [];
  for (const clip of clips) {
    console.log(`\n--- SAY: ${clip.text}`);
    const turn = session.beginTurn(clip.text);
    await pump.enqueue(clip.pcm);
    turn.speechEndAt = Date.now();
    const idle = session.waitIdle(TURN_TIMEOUT_MS);
    // "about 1.5 s of silence so turn detection closes the turn"
    void pump.enqueue(silence(TRAILING_SILENCE_MS));
    const outcome = await idle;
    if (outcome === 'timeout') session.failures.push(`turn timed out: ${clip.text}`);
    const done = session.endTurn()!;
    if (done.agentReply.trim() === '') session.failures.push(`no agent reply for: ${clip.text}`);
    console.log(`  AGENT (${done.ms}ms; first audio ${done.voiceToVoiceMs ?? '?'}ms, answer audio ${done.timeToAnswerMs ?? '-'}ms after speech end): ${done.agentReply || '(nothing)'}`);
    for (const c of done.calls) {
      if (c.agentWaitMs !== undefined) {
        console.log(
          `  timing ${c.name}: transition phrase ${c.transitionAudioMs ?? 0}ms of audio | ` +
            `silence caused by the tool call ${c.silenceOnUsMs ?? '?'}ms (exec ${c.execMs}ms, of which Gateway ${c.refineMs ?? 0}ms)`,
        );
      }
    }
    turns.push(done);
    // A beat between questions, still streaming silence.
    await pump.enqueue(silence(800));
  }

  pump.stop();
  await session.close();

  const result: TargetResult = {
    url,
    sessionId: session.sessionId,
    turns,
    events: session.events,
    failures: session.failures,
    audio: { chunksSent: pump.chunksSent, reanchors: pump.reanchors },
    shaper: { ...session.shaperStats },
    replies: session.replies.map((r) => ({ startedAt: r.startedAt, firstAudioAt: r.firstAudioAt, audioMs: Math.round(r.audioBytes / 48), doneAt: r.doneAt })),
    ok: session.failures.length === 0,
  };
  const addressTurn = turns[turns.length - 1];
  if (spokenAddress !== undefined && addressTurn) {
    result.addressVerdict = judgeAddressCase(addressTurn, spokenAddress);
    if (!result.addressVerdict.survived) result.ok = false;
  }
  return result;
}

// ------------------------------------------------------------------ barge-in

/**
 * Barge-in without a human. The AFG template question produces a long spoken
 * answer; 1.5 s after that answer's first audio chunk, a second utterance -
 * "Stop, just tell me the price." - starts streaming through the same
 * continuous mic. Asserted: the server ends the reply with status
 * "interrupted", the client's flush hook fires, a tool result arriving after
 * the cut is dropped by the epoch check (if one is in flight), and the next
 * answer carries the price from the template.
 */
async function runBargeIn(args: Args): Promise<void> {
  const url = 'https://afg.ai/mcp';
  const ask = 'What does the contract template for a passing test suite look like?';
  const cut = 'Stop, just tell me the price.';
  const clip1 = await synthesize(ask, { voice: args.voice, rate: args.rate });
  const clip2 = await synthesize(cut, { voice: args.voice, rate: args.rate });
  console.log(`audio: question ${clip1.durationMs} ms, interruption ${clip2.durationMs} ms`);

  const session = await LiveSession.open(url, { verbose: args.verbose });
  console.log(`session.ready  session_id=${session.sessionId}`);
  const pump = new AudioPump((b64) => session.sendAudio(b64));
  pump.start();
  await pump.enqueue(silence(400));

  const ev = {
    answerFirstAudioAt: 0, cutStreamStartAt: 0, cutStreamEndAt: 0, interruptedAt: 0,
    cutAgentText: '', answerAudioBeforeCutMs: 0,
  };
  let scheduled = false;
  let answerReplyIndex = -1;
  session.onEvent((m) => {
    if (m.type === 'reply.audio' && !scheduled) {
      const tpl = session.turn?.calls.find((c) => c.name === 'afg_contract_template' && c.sentAt !== undefined);
      if (tpl) {
        scheduled = true;
        ev.answerFirstAudioAt = Date.now();
        answerReplyIndex = session.replies.length - 1;
        setTimeout(() => {
          ev.cutStreamStartAt = Date.now();
          console.log(`  >>> streaming the interruption, ${ev.cutStreamStartAt - ev.answerFirstAudioAt} ms after the answer's first audio`);
          void pump.enqueue(clip2.pcm).then(() => {
            ev.cutStreamEndAt = Date.now();
            void pump.enqueue(silence(1500));
          });
        }, 1500);
      }
    }
    if (m.type === 'reply.done' && m.status === 'interrupted' && ev.interruptedAt === 0) ev.interruptedAt = Date.now();
    if (m.type === 'transcript.agent' && m.interrupted === true) ev.cutAgentText = String(m.text ?? '');
  });

  console.log(`\n--- SAY: ${ask}`);
  const turn1 = session.beginTurn(ask);
  await pump.enqueue(clip1.pcm);
  turn1.speechEndAt = Date.now();
  void pump.enqueue(silence(1500));

  // Wait for the server to cut the answer.
  const deadline = Date.now() + 120_000;
  while (ev.interruptedAt === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const t1 = session.endTurn()!;
  const answer = session.replies[answerReplyIndex];
  if (answer) ev.answerAudioBeforeCutMs = Math.round(answer.audioBytes / 48);

  console.log(`\n--- SAY (barging in): ${cut}`);
  const turn2 = session.beginTurn(cut);
  while (ev.cutStreamEndAt === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  turn2.speechEndAt = ev.cutStreamEndAt;
  const idle = await session.waitIdle(60_000);
  const t2 = session.endTurn()!;
  pump.stop();
  await session.close();

  const tplCall = t1.calls.find((c) => c.name === 'afg_contract_template');
  const raw = tplCall ? session.rawResults.get(tplCall.callId) ?? '' : '';
  const priceMatch = raw.match(/"price"\s*:\s*\{[^}]*"amount"\s*:\s*"?([\d.]+)/);
  const price = priceMatch ? Number(priceMatch[1]) : NaN;
  const PRICE_WORDS: Record<number, string> = { 40: 'forty', 50: 'fifty', 25: 'twenty-five', 100: 'one hundred', 10: 'ten', 20: 'twenty', 30: 'thirty' };
  const carriesPrice = Number.isFinite(price) && (new RegExp(`\\b${price}(\\.0+)?\\b`).test(t2.agentReply) || (PRICE_WORDS[price] !== undefined && new RegExp(PRICE_WORDS[price]!, 'i').test(t2.agentReply)));
  const inFlightAtCut = session.inFlightAtInterrupt[0] ?? 0;

  const assertions = {
    replyDoneInterrupted: ev.interruptedAt > 0,
    flushHookFired: session.flushes >= 1,
    lateResultDroppedByEpoch: session.droppedLate >= 1,
    lateResultApplicable: inFlightAtCut > 0,
    nextAnswerCarriesPrice: carriesPrice,
  };
  console.log(`\n${'#'.repeat(78)}\nBARGE-IN (spoken)  session_id=${session.sessionId}`);
  console.log(`  question heard      : ${JSON.stringify(t1.heard)}`);
  console.log(`  tool                : ${tplCall ? `${tplCall.name}(${JSON.stringify(tplCall.arguments)}) mcp=${tplCall.mcpMs}ms` : '(not called)'}`);
  console.log(`  answer audio played : ${ev.answerAudioBeforeCutMs} ms before the cut; interrupted text: ${JSON.stringify(ev.cutAgentText.slice(0, 160))}`);
  console.log(`  interruption heard  : ${JSON.stringify(t2.heard)}`);
  console.log(`  cut latency         : ${ev.interruptedAt && ev.cutStreamStartAt ? ev.interruptedAt - ev.cutStreamStartAt : '?'} ms from the interruption's first audio chunk to reply.done(interrupted)`);
  console.log(`  after the cut       : ${JSON.stringify(t2.agentReply)} (${idle})`);
  console.log(`  template price      : ${Number.isFinite(price) ? price : '(not found in result)'}`);
  console.log(`  flushes=${session.flushes} droppedLate=${session.droppedLate} toolsInFlightAtCut=${inFlightAtCut}`);
  for (const [k, v] of Object.entries(assertions)) {
    if (k === 'lateResultApplicable') continue;
    const na = k === 'lateResultDroppedByEpoch' && !assertions.lateResultApplicable;
    console.log(`  ${na ? 'N/A ' : v ? 'PASS' : 'FAIL'}  ${k}${na ? ' (no tool call was in flight at the cut)' : ''}`);
  }
  if (!assertions.lateResultApplicable) {
    console.log('  note: no tool call was in flight when the answer was cut - the agent speaks only after its result is sent -');
    console.log('        so the epoch check had nothing to drop live. Covered offline: protocol.test.ts "an interruption drops pending results".');
  }
  const outPath = args.out ?? `data/e2e-audio-bargein-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
  await mkdir('data', { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ at: new Date().toISOString(), sessionId: session.sessionId, assertions, ev, price, inFlightAtCut, flushes: session.flushes, droppedLate: session.droppedLate, turns: [t1, t2], replies: session.replies.map((r) => ({ ...r, audioMs: Math.round(r.audioBytes / 48) })) }, null, 2)}\n`);
  console.log(`\nwritten: ${outPath}`);
  const required = assertions.replyDoneInterrupted && assertions.flushHookFired && assertions.nextAnswerCarriesPrice && (assertions.lateResultDroppedByEpoch || !assertions.lateResultApplicable);
  process.exit(required ? 0 : 1);
}

// --------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
if (config.assemblyAiKey === '') {
  console.error('ASSEMBLYAI_API_KEY is not set. Run with: node --env-file=.env scripts/e2e-audio.ts');
  process.exit(2);
}

if (args.caseName === 'barge-in') await runBargeIn(args);

type Target = { url: string; asks: string[]; spokenAddress?: string; startPhaseQuery?: string; mustBeHidden?: string };
let targets: Target[];
const addressCase = args.caseName ? ADDRESSES[args.caseName] : undefined;
if (args.caseName && !addressCase) {
  console.error(`unknown case ${args.caseName}; known: ${Object.keys(ADDRESSES).join(', ')}`);
  process.exit(2);
}
if (addressCase) {
  targets = [{
    url: 'https://afg.ai/mcp', asks: addressCase.asks, spokenAddress: addressCase.address,
    startPhaseQuery: addressCase.startPhaseQuery, mustBeHidden: addressCase.mustBeHidden,
  }];
}
else if (args.preset) targets = [{ url: args.preset, asks: args.say.length > 0 ? args.say : ['What can you do?'] }];
else targets = PRESETS.map((p) => ({ url: p.url, asks: p.asks.slice(0, 2) }));

const results: TargetResult[] = [];
for (const t of targets) {
  try {
    results.push(await runTarget(t.url, t.asks, args, t.spokenAddress, { startPhaseQuery: t.startPhaseQuery, mustBeHidden: t.mustBeHidden }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`\n!! ${t.url} failed: ${detail}`);
    results.push({ url: t.url, sessionId: '', turns: [], events: {}, failures: [detail], audio: { chunksSent: 0, reanchors: 0 }, shaper: {}, ok: false });
  }
}

console.log(`\n${'#'.repeat(78)}\nSUMMARY (spoken input)`);
let calls = 0, okCalls = 0;
for (const r of results) {
  const all = r.turns.flatMap((t) => t.calls);
  calls += all.length;
  okCalls += all.filter((c) => !c.isError).length;
  const v2v = r.turns.map((t) => t.voiceToVoiceMs).filter((x): x is number => x !== undefined);
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.url}`);
  console.log(`     session_id=${r.sessionId || '(none)'} turns=${r.turns.length} tool_calls=${all.length} replies=${r.turns.filter((t) => t.agentReply.trim() !== '').length} voice-to-voice=${v2v.join('/') || '-'}ms audio_chunks=${r.audio.chunksSent} reanchors=${r.audio.reanchors} audio_rate_violations=${r.failures.filter((f) => /audio_rate/.test(f)).length}`);
  if (r.addressVerdict) {
    const v = r.addressVerdict;
    console.log(`     ADDRESS CASE: find_tools=${v.findToolsCalled} reputation_after_phase_change=${v.reputationCalledAfterPhaseChange}`);
    console.log(`                   spoken   = ${v.spoken}`);
    console.log(`                   heard    = ${v.heard.map((h) => JSON.stringify(h)).join(' | ') || '(nothing)'}`);
    console.log(`                   argument = ${v.addressArgument ?? '(tool never called)'}`);
    console.log(`                   survived = ${v.survived}   exact = ${v.exact}`);
  }
  for (const f of r.failures) console.log(`     ! ${f}`);
}
console.log(`\ntool calls: ${calls} made, ${okCalls} returned a result, ${calls - okCalls} returned a tool-level error (the MCP server's own answer, spoken back)`);
console.log(`session ids: ${results.map((r) => r.sessionId).filter(Boolean).join(', ')}`);

const outPath = args.out ?? `data/e2e-audio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
await mkdir('data', { recursive: true });
await writeFile(outPath, `${JSON.stringify({ at: new Date().toISOString(), voice: args.voice, carry: args.carry, results }, null, 2)}\n`);
console.log(`\nwritten: ${outPath}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
