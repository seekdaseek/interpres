/**
 * Builds the homepage replay from one recorded e2e-audio session.
 *
 * The audio is Session History's own recording: stereo Ogg Opus, the caller on
 * channel 0 and the agent on channel 1. It is mixed to mono and encoded as AAC,
 * which every browser plays. The timeline does not say when a tool_result reply
 * started speaking, so each line is placed on the recording's own clock: speech
 * is found per channel, and the timeline's tool timestamps are shifted by the
 * offset between its user-speech starts and the caller channel's.
 *
 *   node --env-file=.env scripts/replay-build.ts <session_id> <data/e2e-audio-*.json> "<server label>"
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSession, getTimeline } from './session-history.ts';
import type { TimelineTurn } from './session-history.ts';

const OUT_DIR = 'apps/web/src/replay';
/** 100 ms windows; speech is RMS above this on int16 samples. */
const WINDOW_S = 0.1;
const SPEECH_RMS = 300;
/** Pauses shorter than this stay inside one utterance. */
const JOIN_GAP_S = 1.5;

export type ReplayEvent =
  | { at: number; kind: 'user'; end: number; text: string }
  | { at: number; kind: 'agent'; end: number; text: string }
  | { at: number; kind: 'call'; id: string; name: string; args: unknown }
  | { at: number; kind: 'result'; id: string; name: string; ms: number; ok: boolean; spoken: string; method: string };

type Span = { start: number; end: number };

function readWav(buf: Buffer): { channels: number; rate: number; frames: number; sample: (frame: number, ch: number) => number } {
  let off = 12;
  let channels = 0;
  let rate = 0;
  let dataOff = 0;
  let dataLen = 0;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); }
    if (id === 'data') { dataOff = off + 8; dataLen = len; break; }
    off += 8 + len + (len % 2);
  }
  const frames = Math.floor(dataLen / (2 * channels));
  return { channels, rate, frames, sample: (f, c) => buf.readInt16LE(dataOff + 2 * (f * channels + c)) };
}

/** Utterances on one channel: windows above the speech level, short pauses joined. */
export function utterances(rms: number[], windowS = WINDOW_S): Span[] {
  const raw: Span[] = [];
  let start = -1;
  rms.forEach((r, i) => {
    if (r > SPEECH_RMS && start < 0) start = i;
    if (r <= SPEECH_RMS && start >= 0) { if (i - start >= 3) raw.push({ start: start * windowS, end: i * windowS }); start = -1; }
  });
  if (start >= 0) raw.push({ start: start * windowS, end: rms.length * windowS });
  const out: Span[] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < JOIN_GAP_S) last.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const round = (s: number) => Math.round(s * 1000) / 1000;

async function main(): Promise<void> {
  const [sessionId, dataFile, label] = process.argv.slice(2);
  if (!sessionId || !dataFile || !label) {
    console.error('usage: node --env-file=.env scripts/replay-build.ts <session_id> <data/e2e-audio-*.json> "<server label>"');
    process.exit(2);
  }
  const session = await getSession(sessionId);
  const timeline = await getTimeline(session);
  const audioArt = session.artifacts?.find((a) => a.type === 'audio');
  if (!timeline || !audioArt) throw new Error('the session has no timeline or no audio artifact');
  const t0 = Number(timeline.started_at_unix_ms);

  // The recording, decoded to 16-bit PCM so speech can be found per channel.
  const dir = await mkdtemp(join(tmpdir(), 'interpres-replay-'));
  const ogg = join(dir, 'session.ogg');
  const wav = join(dir, 'session.wav');
  const res = await fetch(audioArt.url);   // pre-signed: no key goes with it
  if (!res.ok) throw new Error(`audio artifact -> ${res.status}`);
  await writeFile(ogg, Buffer.from(await res.arrayBuffer()));
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', ogg, wav]);
  const w = readWav(await readFile(wav));
  if (w.channels !== 2) throw new Error(`expected the two-channel recording, got ${w.channels}`);
  const win = Math.round(w.rate * WINDOW_S);
  const rms: [number[], number[]] = [[], []];
  for (let f = 0; f + win <= w.frames; f += win) {
    for (const c of [0, 1] as const) {
      let e = 0;
      for (let i = f; i < f + win; i++) e += w.sample(i, c) ** 2;
      rms[c].push(Math.sqrt(e / win));
    }
  }
  const caller = utterances(rms[0]);
  const agent = utterances(rms[1]);

  // Mono mix for the page: both voices, centred.
  const mono = Buffer.alloc(44 + w.frames * 2);
  mono.write('RIFF', 0); mono.writeUInt32LE(36 + w.frames * 2, 4); mono.write('WAVEfmt ', 8);
  mono.writeUInt32LE(16, 16); mono.writeUInt16LE(1, 20); mono.writeUInt16LE(1, 22); mono.writeUInt32LE(w.rate, 24);
  mono.writeUInt32LE(w.rate * 2, 28); mono.writeUInt16LE(2, 32); mono.writeUInt16LE(16, 34); mono.write('data', 36); mono.writeUInt32LE(w.frames * 2, 40);
  for (let f = 0; f < w.frames; f++) mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((w.sample(f, 0) + w.sample(f, 1)) / 2))), 44 + f * 2);
  const monoWav = join(dir, 'mono.wav');
  await writeFile(monoWav, mono);
  const audioName = `${sessionId}.m4a`;
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', monoWav, join(OUT_DIR, audioName)]);

  // Timeline -> the recording's clock.
  const turns = (timeline.turns ?? []) as TimelineTurn[];
  const userStarts = turns
    .map((t) => t.user_speech_started_at_ms as number | undefined)
    .filter((x): x is number => typeof x === 'number')
    .map((x) => (x - t0) / 1000);
  const offsets = userStarts.map((u, i) => (caller[i] ? u - caller[i]!.start : NaN)).filter(Number.isFinite);
  if (offsets.length === 0) throw new Error('no caller speech to align the timeline with');
  const offset = median(offsets);
  const onClock = (unixMs: number) => round((unixMs - t0) / 1000 - offset);

  // What the harness recorded for each call: the shaped line the agent was given.
  const data = JSON.parse(await readFile(dataFile, 'utf8'));
  const run = (data.results ?? [data]).find((r: { sessionId?: string }) => r.sessionId === sessionId);
  if (!run) throw new Error(`${dataFile} has no run for ${sessionId}`);
  const harnessCalls: Array<{ name: string; spoken?: string; method?: string }> = run.turns.flatMap((t: { calls?: unknown[] }) => t.calls ?? []);

  const events: ReplayEvent[] = [];
  let ci = 0;
  let ai = 0;
  let callN = 0;
  let after = 0;
  for (const t of turns) {
    if (t.trigger === 'user_speech' && typeof t.user_transcript === 'string' && t.user_transcript !== '') {
      const u = caller[ci++];
      if (u) { events.push({ at: round(u.start), kind: 'user', end: round(u.end), text: t.user_transcript }); after = u.end; }
    }
    for (const c of t.tool_calls ?? []) {
      const id = `call${++callN}`;
      const h = harnessCalls.find((x) => x.name === c.name && !(x as { used?: boolean }).used) as ({ spoken?: string; method?: string; used?: boolean }) | undefined;
      if (h) h.used = true;
      events.push({ at: onClock(Number(c.dispatched_at_ms)), kind: 'call', id, name: c.name, args: c.arguments });
      events.push({ at: onClock(Number(c.result_received_at_ms)), kind: 'result', id, name: c.name, ms: Number(c.duration_ms ?? 0), ok: c.is_error !== true, spoken: h?.spoken ?? '', method: h?.method ?? '' });
      after = onClock(Number(c.result_received_at_ms));
    }
    if (typeof t.agent_text === 'string' && t.agent_text !== '') {
      while (agent[ai] && agent[ai]!.end <= after) ai++;
      const a = agent[ai++];
      if (a) { events.push({ at: round(a.start), kind: 'agent', end: round(a.end), text: t.agent_text }); after = a.end; }
    }
  }
  events.sort((x, y) => x.at - y.at);

  // The tools the session was given, from its own session.update.
  const update = (timeline.config_changes as Array<{ update?: { tools?: Array<{ name?: string }> } }> | undefined)?.[0]?.update;
  const tools = (update?.tools ?? []).map((x) => x.name ?? '').filter(Boolean);

  const replay = {
    sessionId,
    recordedAt: session.created_at,
    durationSeconds: round(w.frames / w.rate),
    server: { label, url: run.url as string },
    tools,
    voice: 'Samantha, a macOS say voice: synthetic speech, not a person',
    audio: audioName,
    alignment: { offsetSeconds: round(offset), callerUtterances: caller.length, agentUtterances: agent.length },
    events,
  };
  await writeFile(join(OUT_DIR, 'replay.json'), `${JSON.stringify(replay, null, 1)}\n`);
  console.log(`replay: ${events.length} events over ${replay.durationSeconds} s, offset ${replay.alignment.offsetSeconds} s, tools ${tools.length}`);
  for (const e of events) console.log(`  ${e.at.toFixed(2).padStart(6)} s  ${e.kind.padEnd(6)} ${'text' in e ? e.text.slice(0, 70) : `${e.name}${e.kind === 'result' ? ` ${e.ms} ms ok=${e.ok}` : ''}`}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) await main();
