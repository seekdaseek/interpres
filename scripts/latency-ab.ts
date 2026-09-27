/**
 * Round G1: does `input.transcription_mode: "min_latency"` end turns faster
 * without costing accuracy?
 *
 * In-process sessions with the API key (as scripts/e2e-audio.ts runs them),
 * each set up exactly as the page sets up that server (`LiveSession.open(url,
 * { asPage: true })`). Two arms:
 * - balanced: what interpres sends today, no `transcription_mode` at all, so the
 *   API's default ("balanced", events-reference.mdx);
 * - min_latency: the same setup plus `transcription_mode: "min_latency"` on every
 *   input update.
 *
 * Clips (all 24 kHz PCM16): Q1-Q4 as gated for the video; the Books preset's
 * other two tested questions in michael's voice; Sergiu's own question, cut from
 * channel 0 of his phone session's Session History recording; and a hesitation
 * clip, michael saying "What is", 800 ms of silence, then "SEO in plain English?".
 * Every clip is the first question of a fresh session, after the greeting has
 * played, except Q4, which follows Q3 and the paste, as in scene C.
 *
 * Per turn: end of turn (the API's input.speech.stopped after the clip's last
 * voiced sample), voice to voice the e2e-audio way (the clip's last chunk sent to
 * the first reply.audio), heard exactly or not, the tool calls with their
 * arguments, and whether the turn split in two.
 *
 * Round H1, the follow-up: where min_latency could be worse. Two shorter
 * hesitations (the same two halves as G1's clip, with 400 ms and 600 ms of
 * silence between them), and Q5, the spoken address, in scene C's setup: after
 * Q3's swap, before any paste. For Q5 it records how many turns the utterance
 * became, whether the gate held it (needs_paste), every MCP request the
 * executor made (in-process, what the page would send as /api/mcp/call), and
 * what the agent said.
 *
 *   node --env-file=.env scripts/latency-ab.ts clips
 *   node --env-file=.env scripts/latency-ab.ts run [--runs 3]
 *   node --env-file=.env scripts/latency-ab.ts clips-h1
 *   node --env-file=.env scripts/latency-ab.ts run-h1 [--runs 3]
 *   node --env-file=.env scripts/latency-ab.ts report
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AudioPump, parseWav, silence } from './lib/audio.ts';
import { LiveSession } from './lib/session.ts';
import { getSession, getTimeline } from './session-history.ts';
import { speakAsGreeting, wav } from './video/voices.ts';
import { PROPER_NOUN_VARIANTS } from './video/config.ts';
import { matchWords, transcribeFile } from './video/stt.ts';
import { SAMPLE_ADDRESS } from './video/capture.ts';
import { collapseSpelled, findIdentifiers } from '@interpres/core';

export const AB_FILE = 'data/latency-ab-2026-09-27.json';
export const AB_CLIPS = 'data/latency-ab-clips.json';
export const AB_H1_FILE = 'data/latency-ab-h1-2026-09-27.json';
const DIR = 'video/voices';
const GOJI = 'https://mcp.goji.agency/mcp';
const BOOKS = 'https://mostrecommendedbooks.com/api/mcp';
const AFG = 'https://afg.ai/mcp';
const SERGIU_SESSION = 'sess_a5ba0e6e7f7648ceb26cc31b751f1e08';
const RATE = 24_000;

export type Mode = 'balanced' | 'min_latency';
type ClipDef = { id: string; text: string; file: string; source: string };
export const CLIPS: ClipDef[] = [
  { id: 'Q1', text: 'What is SEO in plain English?', file: `${DIR}/Q1.wav`, source: 'the video caller clip Q1 (michael, gated)' },
  { id: 'HESITATION', text: 'What is SEO in plain English?', file: `${DIR}/ab-hesitation.wav`, source: 'michael: "What is", 800 ms of silence, "SEO in plain English?"' },
  { id: 'SERGIU', text: 'What is SEO in plain English?', file: `${DIR}/ab-sergiu.wav`, source: `Sergiu's own voice: channel 0 of ${SERGIU_SESSION} (Session History)` },
  { id: 'Q2', text: 'Who recommends Sapiens?', file: `${DIR}/Q2.wav`, source: 'the video caller clip Q2 (michael, gated); a Books tested question' },
  { id: 'GATES', text: 'What books does Bill Gates recommend?', file: `${DIR}/ab-gates.wav`, source: 'michael; a Books tested question' },
  { id: 'DUNE', text: 'What is the reading order for the Dune series?', file: `${DIR}/ab-dune.wav`, source: 'michael; a Books tested question' },
  { id: 'Q3', text: 'I want to run a spec check on a job contract.', file: `${DIR}/Q3.wav`, source: 'the video caller clip Q3 (michael, gated)' },
  { id: 'Q4', text: 'Check the reputation of the wallet I pasted.', file: `${DIR}/Q4.wav`, source: 'the video caller clip Q4 (michael, gated), after Q3 and the paste' },
];
/** Sessions per arm per run: which server, which clips in order. */
const PLANS: Array<{ url: string; clips: string[] }> = [
  { url: GOJI, clips: ['Q1'] }, { url: GOJI, clips: ['HESITATION'] }, { url: GOJI, clips: ['SERGIU'] },
  { url: BOOKS, clips: ['Q2'] }, { url: BOOKS, clips: ['GATES'] }, { url: BOOKS, clips: ['DUNE'] },
  { url: AFG, clips: ['Q3', 'Q4'] },
];

/** Round H1's clips. Q5's text is the caller line the video speaks (data/video/voices.json). */
const Q5_TEXT = (JSON.parse(readFileSync('data/video/voices.json', 'utf8')) as { lines: Record<string, { text: string }> }).lines.Q5!.text;
export const H1_CLIPS: ClipDef[] = [
  { id: 'HES400', text: 'What is SEO in plain English?', file: `${DIR}/ab-hesitation-400.wav`, source: 'michael: "What is", 400 ms of silence, "SEO in plain English?" (the same two halves as G1\'s 800 ms clip)' },
  { id: 'HES600', text: 'What is SEO in plain English?', file: `${DIR}/ab-hesitation-600.wav`, source: 'michael: "What is", 600 ms of silence, "SEO in plain English?" (the same two halves as G1\'s 800 ms clip)' },
  { id: 'Q5', text: Q5_TEXT, file: `${DIR}/Q5.wav`, source: 'the video caller clip Q5 (michael), the spoken address, after Q3\'s swap and before any paste, as in scene C' },
];
const H1_PLANS: Array<{ url: string; clips: string[] }> = [
  { url: GOJI, clips: ['HES400'] }, { url: GOJI, clips: ['HES600'] },
  { url: AFG, clips: ['Q3', 'Q5'] },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clipDef = (id: string) => [...CLIPS, ...H1_CLIPS].find((c) => c.id === id)!;
const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** First and last samples above -40 dBFS, in ms: where the speech in a clip starts and ends. */
function voiced(pcm: Buffer): { startMs: number; endMs: number; lengthMs: number } {
  const n = pcm.length >> 1;
  let a = -1; let b = -1;
  for (let i = 0; i < n; i++) if (Math.abs(pcm.readInt16LE(2 * i)) > 328) { if (a < 0) a = i; b = i; }
  return { startMs: (a / RATE) * 1000, endMs: (b / RATE) * 1000, lengthMs: (n / RATE) * 1000 };
}

// ------------------------------------------------------------------ clips

async function makeClips(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const manifest: Record<string, unknown> = existsSync(AB_CLIPS) ? JSON.parse(readFileSync(AB_CLIPS, 'utf8')) : {};
  for (const [id, text] of [['GATES', 'What books does Bill Gates recommend?'], ['DUNE', 'What is the reading order for the Dune series?']] as const) {
    if (existsSync(clipDef(id).file)) continue;
    const r = await speakAsGreeting(text, 'michael');
    writeFileSync(clipDef(id).file, wav(r.pcm));
    manifest[id] = { madeIn: r.sessionId, ms: Math.round(r.pcm.length / 48) };
    console.log(`${id}: ${r.sessionId}, ${Math.round(r.pcm.length / 48)} ms`);
  }
  if (!existsSync(clipDef('HESITATION').file)) {
    const a = await speakAsGreeting('What is', 'michael');
    const b = await speakAsGreeting('SEO in plain English?', 'michael');
    const va = voiced(a.pcm);
    const vb = voiced(b.pcm);
    // Keep "What is" through its last voiced sample, then exactly 800 ms of silence, then the rest from its first.
    const head = a.pcm.subarray(0, (Math.round((va.endMs / 1000) * RATE) + 1) * 2);
    const tail = b.pcm.subarray(Math.round((vb.startMs / 1000) * RATE) * 2);
    writeFileSync(clipDef('HESITATION').file, wav(Buffer.concat([head, silence(800), tail])));
    manifest.HESITATION = { madeIn: [a.sessionId, b.sessionId], gapMs: 800, ms: Math.round((head.length + tail.length) / 48) + 800 };
    console.log(`HESITATION: ${a.sessionId} + ${b.sessionId}, 800 ms gap`);
  }
  if (!existsSync(clipDef('SERGIU').file)) {
    // Channel 0 of the session recording is the caller; the timeline says where the question is.
    const s = await getSession(SERGIU_SESSION);
    const tl = await getTimeline(s);
    const turn = (tl?.turns ?? []).find((t) => t.trigger === 'user_speech' && t.user_transcript === 'What is SEO in plain English?') as { user_speech_started_at_ms: number; user_speech_ended_at_ms: number } | undefined;
    if (!tl || !turn) throw new Error('the phone session has no such turn');
    const audio = s.artifacts?.find((x) => x.type === 'audio');
    if (!audio) throw new Error('the phone session has no audio artifact');
    const res = await fetch(audio.url);
    if (!res.ok) throw new Error(`audio artifact -> ${res.status}`);
    const ogg = `${DIR}/ab-sergiu-session.ogg`;
    writeFileSync(ogg, Buffer.from(await res.arrayBuffer()));
    // The recording does not start at the session's started_at (it was 1.5 s late here), so the
    // question is found by transcribing channel 0 and taking its words' own times.
    const ch0 = `${DIR}/ab-sergiu-ch0.wav`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', ogg, '-af', 'pan=mono|c0=c0', '-ar', '16000', '-sample_fmt', 's16', ch0]);
    const all = await transcribeFile(ch0);
    const words = all.words;
    const k = words.findIndex((w, i) => /^what$/i.test(w.text) && /^english/i.test(words[i + 5]?.text ?? ''));
    if (k < 0) throw new Error(`channel 0 has no "What is SEO in plain English?": ${all.text.slice(0, 80)}`);
    const from = words[k]!.start / 1000 - 0.3;
    const to = words[k + 5]!.end / 1000 + 0.4;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', ogg, '-af', `pan=mono|c0=c0,atrim=${from.toFixed(3)}:${to.toFixed(3)},aresample=${RATE}`, '-ac', '1', '-ar', String(RATE), '-sample_fmt', 's16', clipDef('SERGIU').file]);
    const t = await transcribeFile(clipDef('SERGIU').file);
    manifest.SERGIU = { session: SERGIU_SESSION, channel: 0, fromS: Number(from.toFixed(3)), toS: Number(to.toFixed(3)), timelineSaid: [turn.user_speech_started_at_ms, turn.user_speech_ended_at_ms], recordingOffsetS: Number(((turn.user_speech_started_at_ms - Number(tl.started_at_unix_ms)) / 1000 - words[k]!.start / 1000).toFixed(2)), transcript: t.text, speechModel: t.speechModel };
    console.log(`SERGIU: ${from.toFixed(2)}-${to.toFixed(2)} s of channel 0, transcribed "${t.text}"`);
  }
  writeFileSync(AB_CLIPS, `${JSON.stringify(manifest, null, 1)}\n`);
}

/**
 * The 400 ms and 600 ms hesitation clips, from G1's own halves: the 800 ms clip
 * is "What is" through its last voiced sample, 800 ms of digital silence, then
 * "SEO in plain English?" from its first voiced sample. The halves are recovered
 * at the one 800 ms run of zeros between voiced samples, and the recovery is
 * proved by rebuilding the 800 ms clip byte for byte before anything is written.
 */
async function makeH1Clips(): Promise<void> {
  const src = clipDef('HESITATION').file;
  const pcm = Buffer.from(parseWav(readFileSync(src)).pcm);
  const n = pcm.length >> 1;
  const gap = Math.round(0.8 * RATE);
  const loud = (i: number) => Math.abs(pcm.readInt16LE(2 * i)) > 328;
  const cuts: number[] = [];
  for (let i = 1; i + gap < n; i++) {
    if (!loud(i - 1) || !loud(i + gap)) continue;
    let zero = true;
    for (let k = i; k < i + gap && zero; k++) zero = pcm.readInt16LE(2 * k) === 0;
    if (zero) cuts.push(i);
  }
  if (cuts.length !== 1) throw new Error(`expected one 800 ms run of zeros between voiced samples, found ${cuts.length}`);
  const head = pcm.subarray(0, cuts[0]! * 2);
  const tail = pcm.subarray((cuts[0]! + gap) * 2);
  if (!wav(Buffer.concat([head, silence(800), tail])).equals(readFileSync(src))) throw new Error('the halves do not rebuild the 800 ms clip byte for byte');
  const manifest = JSON.parse(readFileSync(AB_CLIPS, 'utf8')) as Record<string, unknown>;
  const g1 = manifest.HESITATION as { madeIn: string[] };
  for (const [id, gapMs] of [['HES400', 400], ['HES600', 600]] as const) {
    const out = wav(Buffer.concat([head, silence(gapMs), tail]));
    writeFileSync(clipDef(id).file, out);
    const v = voiced(Buffer.from(parseWav(out).pcm));
    manifest[id] = { from: src, halvesMadeIn: g1.madeIn, gapMs, headMs: Math.round((head.length / 2 / RATE) * 1000), tailMs: Math.round((tail.length / 2 / RATE) * 1000), ms: Math.round(v.lengthMs), sha256: sha256File(clipDef(id).file) };
    console.log(`${id}: "What is" ${Math.round((head.length / 2 / RATE) * 1000)} ms + ${gapMs} ms of zeros + "SEO in plain English?" ${Math.round((tail.length / 2 / RATE) * 1000)} ms`);
  }
  manifest.Q5 = { file: clipDef('Q5').file, sha256: sha256File(clipDef('Q5').file), text: Q5_TEXT, note: 'the video caller clip, unchanged' };
  writeFileSync(AB_CLIPS, `${JSON.stringify(manifest, null, 1)}\n`);
}

// ------------------------------------------------------------------ runs

export type Turn = {
  clip: string; mode: Mode; run: number; sessionId: string; at: string;
  heard: string; exact: boolean; transcripts: number; split: boolean;
  endOfTurnMs: number | null; voiceToVoiceMs: number | null;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Round H1 on: each transcript.user of the utterance, in order. */
  transcriptTexts?: string[];
  /** A reply started before the clip's last voiced sample. */
  earlyReply?: boolean;
  interrupted?: boolean;
  /**
   * The turn's events, ms from the clip's last voiced sample (negative: while the
   * caller was still speaking). Audio chunks are collapsed to the first of each
   * run; reply.done carries its status, tool.call its name.
   */
  seq?: Array<[number, string, string?]>;
  /** Everything the agent said in the turn (transcript.agent). */
  agentSaid?: string;
  /** The gate's decisions in the turn: needs_paste is action "paste". */
  gate?: Array<{ tool: string; action: string; heard?: string }>;
  /** MCP tools/call requests the executor made in the turn: in-process, what the page sends as /api/mcp/call. */
  mcpRequests?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** The tool calls' methods (gate_paste, phase_change, paste, or the shaper's). */
  methods?: string[];
  clipSha256?: string;
};

async function runSession(url: string, clips: string[], mode: Mode, run: number): Promise<Turn[]> {
  // balanced sends no transcription_mode at all, as interpres did until round H.
  const s = await LiveSession.open(url, { asPage: true, maxSessionSeconds: 180, transcriptionMode: mode === 'min_latency' ? 'min_latency' : 'omit' });
  const events: Array<{ t: number; type: string; text?: string }> = [];
  s.onEvent((m) => {
    if (m.type === 'reply.audio' && events.at(-1)?.type === 'reply.audio') return;
    if (m.type.endsWith('.delta')) return;
    const text = m.type === 'transcript.user' || m.type === 'transcript.agent' ? String(m.text ?? '')
      : m.type === 'reply.done' ? String(m.status ?? 'completed')
        : m.type === 'tool.call' ? String(m.name ?? '') : undefined;
    events.push({ t: Date.now(), type: m.type, text });
  });
  const pump = new AudioPump((b64) => s.sendAudio(b64));
  pump.start();
  const out: Turn[] = [];
  try {
    // The greeting plays out first, as on the page.
    const t0 = Date.now();
    while (Date.now() - t0 < 25_000) {
      const r = s.replies[0];
      if (r?.doneAt !== undefined && r.firstAudioAt !== undefined && Date.now() >= r.firstAudioAt + r.audioBytes / 48 + 700) break;
      await sleep(100);
    }
    for (const id of clips) {
      if (id === 'Q4') { s.setPaste(SAMPLE_ADDRESS); await pump.enqueue(silence(3000)); }
      // Q5 as in scene C: nothing is ever pasted in this session.
      if (id === 'Q5') await pump.enqueue(silence(700));
      const gateFrom = s.gateLog.length;
      const mcpFrom = s.mcpRequests.length;
      const c = clipDef(id);
      const pcm = Buffer.from(parseWav(readFileSync(c.file)).pcm);
      const v = voiced(pcm);
      const turn = s.beginTurn(c.text);
      const sentFrom = Date.now();
      await pump.enqueue(pcm);
      const clipEnd = Date.now();
      turn.speechEndAt = clipEnd;
      const idle = s.waitIdle(60_000);
      void pump.enqueue(silence(1500));
      await idle;
      const done = s.endTurn()!;
      // The clip's last voiced sample, on this clock.
      const voicedEnd = clipEnd - (v.lengthMs - v.endMs);
      const inTurn = events.filter((e) => e.t >= sentFrom && e.t <= (done.idleAt ?? Date.now()));
      const lastStart = inTurn.filter((e) => e.type === 'input.speech.started').at(-1);
      const stop = lastStart ? inTurn.find((e) => e.type === 'input.speech.stopped' && e.t >= lastStart.t) : undefined;
      const transcripts = inTurn.filter((e) => e.type === 'transcript.user').length;
      const transcriptTexts = inTurn.filter((e) => e.type === 'transcript.user').map((e) => e.text ?? '');
      const earlyReply = inTurn.some((e) => e.type === 'reply.started' && e.t < voicedEnd);
      const heard = done.heard.join(' ').trim();
      out.push({
        clip: id, mode, run, sessionId: s.sessionId, at: new Date(sentFrom).toISOString(),
        heard, exact: matchWords(c.text, heard, PROPER_NOUN_VARIANTS).ok,
        transcripts, split: transcripts > 1 || earlyReply,
        endOfTurnMs: stop ? Math.round(stop.t - voicedEnd) : null,
        voiceToVoiceMs: done.voiceToVoiceMs ?? null,
        calls: done.calls.map((x) => ({ name: x.name, arguments: x.arguments })),
        transcriptTexts, earlyReply, interrupted: done.interrupted, agentSaid: done.agentReply,
        seq: inTurn.map((e) => (e.text === undefined ? [Math.round(e.t - voicedEnd), e.type] : [Math.round(e.t - voicedEnd), e.type, e.text]) as [number, string, string?]),
        gate: s.gateLog.slice(gateFrom).map((g) => ({ tool: g.tool, action: g.action, heard: g.heard })),
        mcpRequests: s.mcpRequests.slice(mcpFrom).map((r) => ({ tool: r.tool, args: r.args })),
        methods: done.calls.map((x) => x.method ?? ''),
        clipSha256: sha256File(c.file),
      });
      const o = out.at(-1)!;
      console.log(`  ${mode.padEnd(11)} run ${run} ${id.padEnd(10)} ${s.sessionId} heard ${JSON.stringify(transcriptTexts)} ${o.exact ? 'exact' : 'DIFFERS'}${o.split ? ' SPLIT' : ''} | end of turn ${o.endOfTurnMs} ms | v2v ${o.voiceToVoiceMs} ms | ${o.calls.map((x) => `${x.name}(${JSON.stringify(x.arguments)})`).join(', ') || 'no call'}${o.gate?.length ? ` | gate ${o.gate.map((g) => g.action).join(',')}` : ''} | mcp ${o.mcpRequests?.length ?? 0}${id === 'Q5' ? ` | agent: ${JSON.stringify(o.agentSaid?.slice(0, 160))}` : ''}`);
      await pump.enqueue(silence(800));
    }
  } finally {
    pump.stop();
    await s.close();
  }
  return out;
}

async function runAll(runs: number, round: 'G1' | 'H1' = 'G1'): Promise<void> {
  const [clips, plans, file, what] = round === 'G1'
    ? [CLIPS, PLANS, AB_FILE, 'Round G1: transcription_mode balanced (nothing sent, today) against min_latency; in-process, the page\'s exact session setup per server. scripts/latency-ab.ts']
    : [H1_CLIPS, H1_PLANS, AB_H1_FILE, 'Round H1: the follow-up A/B. 400 ms and 600 ms hesitations, and Q5 (the spoken address) after Q3\'s swap with nothing pasted; balanced (nothing sent) against min_latency, in-process, the page\'s exact session setup. scripts/latency-ab.ts run-h1'];
  for (const c of clips) if (!existsSync(c.file)) throw new Error(`${c.id}: no clip at ${c.file}; run "clips" / "clips-h1" first`);
  const saved: { turns: Turn[] } = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { turns: [] };
  for (let run = 1; run <= runs; run++) {
    for (const plan of plans) {
      // Alternate which arm goes first, run by run, so time of day falls on both evenly.
      const order: Mode[] = run % 2 ? ['balanced', 'min_latency'] : ['min_latency', 'balanced'];
      for (const mode of order) {
        if (saved.turns.some((t) => t.run === run && t.mode === mode && plan.clips.includes(t.clip))) continue;
        let turns: Turn[] = [];
        for (let attempt = 1; attempt <= 2 && turns.length === 0; attempt++) {
          try { turns = await runSession(plan.url, plan.clips, mode, run); } catch (err) { console.error(`  ${mode} run ${run} ${plan.clips.join('+')}: ${err instanceof Error ? err.message : err}`); }
        }
        saved.turns.push(...turns);
        writeFileSync(file, `${JSON.stringify({ what, turns: saved.turns }, null, 1)}\n`);
      }
    }
  }
}

// ------------------------------------------------------------------ report

const median = (xs: number[]) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)} ms` : 'n/a');
const callsOf = (ts: Turn[]) => [...new Set(ts.map((t) => t.calls.map((x) => `${x.name}(${JSON.stringify(x.arguments)})`).join(' + ') || 'none'))].join('; ');

/** Round G1's section, and its three criteria. */
function reportG1(): { md: string[]; c1: boolean; c2: boolean; c3: boolean; reasons: string[]; T: Turn[] } {
  const d = JSON.parse(readFileSync(AB_FILE, 'utf8')) as { turns: Turn[] };
  const T = d.turns;
  const by = (clip: string, mode: Mode) => T.filter((t) => t.clip === clip && t.mode === mode);
  const rows: string[] = [];
  rows.push('| clip | arm | heard exactly | split | median end of turn | median voice to voice | tool calls |', '| --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const c of CLIPS) for (const mode of ['balanced', 'min_latency'] as Mode[]) {
    const ts = by(c.id, mode);
    rows.push(`| ${c.id} | ${mode} | ${ts.filter((t) => t.exact).length} of ${ts.length} | ${ts.filter((t) => t.split).length} of ${ts.length} | ${ms(median(ts.map((t) => t.endOfTurnMs ?? NaN)))} | ${ms(median(ts.map((t) => t.voiceToVoiceMs ?? NaN)))} | ${callsOf(ts)} |`);
  }
  const allMed = (mode: Mode) => median(T.filter((t) => t.mode === mode).map((t) => t.voiceToVoiceMs ?? NaN));
  const eotMed = (mode: Mode) => median(T.filter((t) => t.mode === mode).map((t) => t.endOfTurnMs ?? NaN));
  const gain = allMed('balanced') - allMed('min_latency');
  const reasons: string[] = [];
  const c1 = gain >= 500;
  reasons.push(`${c1 ? 'met' : 'NOT met'}: median voice to voice ${Math.round(allMed('balanced'))} ms balanced, ${Math.round(allMed('min_latency'))} ms min_latency, a gain of ${Math.round(gain)} ms (needs 500)`);
  const bad: string[] = [];
  for (const c of CLIPS) {
    const b = by(c.id, 'balanced');
    if (!b.some((t) => t.exact)) continue;
    const want = new Set(b.filter((t) => t.exact).map((t) => JSON.stringify(t.calls)));
    for (const t of by(c.id, 'min_latency')) {
      if (!t.exact) bad.push(`${c.id} run ${t.run} heard "${t.heard}"`);
      else if (!want.has(JSON.stringify(t.calls))) bad.push(`${c.id} run ${t.run} called ${JSON.stringify(t.calls)}`);
    }
  }
  const c2 = bad.length === 0;
  reasons.push(`${c2 ? 'met' : 'NOT met'}: every clip heard exactly in balanced is heard exactly in every min_latency run with the same tools and arguments${bad.length ? ` (${bad.join('; ')})` : ''}`);
  const hes = by('HESITATION', 'min_latency');
  const c3 = hes.length === 3 && hes.every((t) => !t.split);
  reasons.push(`${c3 ? 'met' : 'NOT met'}: the hesitation clip never splits in min_latency (${hes.filter((t) => !t.split).length} of ${hes.length} whole; balanced: ${by('HESITATION', 'balanced').filter((t) => !t.split).length} of ${by('HESITATION', 'balanced').length} whole)`);
  const md = [
    '## Round G1: speed and accuracy',
    '',
    `From \`${AB_FILE}\`: ${T.length} turns in ${new Set(T.map((t) => t.sessionId)).size} sessions. Every clip is the first question of a fresh session, after the greeting, except Q4, which follows Q3 and the paste. The hesitation clip is michael saying "What is", 800 ms of silence, then "SEO in plain English?".`,
    '',
    `Median over every turn: end of turn ${Math.round(eotMed('balanced'))} ms balanced, ${Math.round(eotMed('min_latency'))} ms min_latency; voice to voice ${Math.round(allMed('balanced'))} ms balanced, ${Math.round(allMed('min_latency'))} ms min_latency.`,
    '',
    ...rows,
    '',
    "### G1's own rule: adopt only if all three hold",
    '',
    ...reasons.map((r) => `- ${r}`),
    '',
    `Under G1's rule: ${c1 && c2 && c3 ? 'adopt min_latency' : 'keep balanced'}. Round H replaced the third test, which balanced fails as well, with the pause and spoken-address tests below.`,
    '',
  ];
  return { md, c1, c2, c3, reasons, T };
}

/** Wallet-address-shaped identifiers in a text, spelled-out characters joined up first (as scripts/spoken-identifiers.ts reads them). */
const addressesIn = (text: string) => findIdentifiers(collapseSpelled(text)).map((h) => h.normalized).filter((n) => /^0x[0-9a-f]{8,}$/i.test(n));
/**
 * What the agent said aloud in a turn, and what it only wrote. A reply is voiced
 * if a reply.audio arrived between its reply.started and its transcript.agent;
 * measured in round H1, a reply begun on a fragment ("What is?") can carry text
 * and a tool call but no audio at all.
 */
function agentWords(t: Turn): { voiced: string; unvoiced: string } {
  if (!t.seq) return { voiced: t.agentSaid ?? '', unvoiced: '' };
  const voiced: string[] = []; const unvoiced: string[] = [];
  let audio = false;
  for (const [, type, text] of t.seq) {
    if (type === 'reply.started') audio = false;
    else if (type === 'reply.audio') audio = true;
    else if (type === 'transcript.agent' && text?.trim()) (audio ? voiced : unvoiced).push(text.trim());
  }
  return { voiced: voiced.join(' '), unvoiced: unvoiced.join(' ') };
}
/** The agent's audio began before the clip's last voiced sample: a split the caller would hear. */
const spokeEarly = (t: Turn) => (t.seq ?? []).some(([at, type]) => type === 'reply.audio' && at < 0);
const shortAddr = (v: string) => (v.length > 24 ? `\`${v.slice(0, 10)}…${v.slice(-6)}\` (${v.length})` : `\`${v}\``);

/** Round H1's section, and brief H2's criteria. */
function reportH1(g1: { c1: boolean; c2: boolean; reasons: string[] }): { md: string[]; adopt: boolean; complete: boolean; reasons: string[] } {
  const d = JSON.parse(readFileSync(AB_H1_FILE, 'utf8')) as { turns: Turn[] };
  const T = d.turns;
  const by = (clip: string, mode: Mode) => T.filter((t) => t.clip === clip && t.mode === mode).sort((a, b) => a.run - b.run);
  const splits = (clip: string, mode: Mode) => by(clip, mode).filter((t) => t.split).length;
  const said = addressesIn(clipDef('Q5').text)[0]!;
  const heardAddr = (t: Turn) => addressesIn(t.heard)[0] ?? null;
  const exactOf = (t: Turn) => (t.clip === 'Q5' ? heardAddr(t) === said : t.exact);
  const held = (t: Turn) => (t.gate ?? []).some((g) => g.action === 'paste');
  const asks = (t: Turn) => /paste/i.test(agentWords(t).voiced);
  const rows: string[] = [];
  rows.push('| clip | arm | turns the utterance became, by run | split | agent audio before the caller finished | heard exactly | median end of turn | median voice to voice | tool calls |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const id of ['HES400', 'HES600', 'Q3', 'Q5']) for (const mode of ['balanced', 'min_latency'] as Mode[]) {
    const ts = by(id, mode);
    rows.push(`| ${id === 'Q3' ? 'Q3 (before Q5)' : id} | ${mode} | ${ts.map((t) => t.transcripts).join(', ')} | ${splits(id, mode)} of ${ts.length} | ${ts.filter(spokeEarly).length} of ${ts.length} | ${ts.filter(exactOf).length} of ${ts.length} | ${ms(median(ts.map((t) => t.endOfTurnMs ?? NaN)))} | ${ms(median(ts.map((t) => t.voiceToVoiceMs ?? NaN)))} | ${callsOf(ts)} |`);
  }
  const q5rows: string[] = [];
  q5rows.push('| arm | run | session | turns | a reply began before the caller finished | agent audio before the caller finished | gate | MCP requests | asks for a paste | the agent said aloud |', '| --- | ---: | --- | ---: | --- | --- | --- | ---: | --- | --- |');
  const unvoicedNotes: string[] = [];
  for (const mode of ['balanced', 'min_latency'] as Mode[]) for (const t of by('Q5', mode)) {
    const gate = (t.gate ?? []).map((g) => `${g.action === 'paste' ? 'needs_paste' : g.action} on ${g.tool}`).join(', ') || 'nothing held';
    const w = agentWords(t);
    const said5 = w.voiced.replace(/\s+/g, ' ').trim();
    if (w.unvoiced) unvoicedNotes.push(`- ${mode} run ${t.run}: "${w.unvoiced.replace(/\s+/g, ' ')}"`);
    q5rows.push(`| ${mode} | ${t.run} | \`${t.sessionId}\` | ${t.transcripts} | ${t.earlyReply ? 'yes' : 'no'} | ${spokeEarly(t) ? 'yes' : 'no'} | ${gate} | ${(t.mcpRequests ?? []).length} | ${asks(t) ? 'yes' : 'no'} | "${said5.length > 220 ? `${said5.slice(0, 220)}…` : said5}" |`);
  }
  const heardList = (['balanced', 'min_latency'] as Mode[]).flatMap((mode) => by('Q5', mode).map((t) => {
    const a = heardAddr(t);
    return `- ${mode} run ${t.run}: ${(t.transcriptTexts ?? [t.heard]).map((x) => `"${x}"`).join(' then ')}; the address heard: ${a ? shortAddr(a) : '(none)'}, ${a === said ? 'exact' : 'not exact'}`;
  }));
  // What a split sounded like: a reply begun on the fragment, with or without audio.
  const hes = T.filter((t) => t.clip.startsWith('HES') && t.split);
  const silentSplits = hes.filter((t) => t.earlyReply && !spokeEarly(t));
  const fragmentText = [...new Set(silentSplits.map((t) => agentWords(t).unvoiced).filter(Boolean))];
  // The first audio the caller heard came after the turn's first tool call: it was the answer.
  const answeredFirst = (t: Turn) => {
    const seq = t.seq ?? [];
    const call = seq.findIndex(([, type]) => type === 'tool.call');
    const audio = seq.findIndex(([, type]) => type === 'reply.audio');
    return call >= 0 && audio > call;
  };
  const rightCall = (t: Turn) => t.calls.length === 1 && t.calls[0]!.name === 'goji_explain_term' && JSON.stringify(t.calls[0]!.arguments) === '{"term":"SEO"}';
  const splitNote = hes.length === 0 ? [] : [
    `In ${silentSplits.length} of the ${hes.length} split hesitation turns (both arms), a reply began on the fragment ("What is?") but carried no audio. In ${hes.filter(answeredFirst).length} of ${hes.length}, the first sound the caller heard came after the tool call, and the call was \`goji_explain_term({"term":"SEO"})\` in ${hes.filter(rightCall).length} of ${hes.length}. The silent reply's text reached \`transcript.agent\` all the same${fragmentText.length ? `, for example "${fragmentText[0]}"` : ''}.`,
    '',
  ];
  const complete = ['HES400', 'HES600', 'Q5'].every((id) => (['balanced', 'min_latency'] as Mode[]).every((m) => by(id, m).length === 3));
  const reasons: string[] = [];
  for (const [id, gap] of [['HES400', 400], ['HES600', 600]] as const) {
    const ok = splits(id, 'min_latency') <= splits(id, 'balanced');
    reasons.push(`${ok ? 'met' : 'NOT met'}: at ${gap} ms, min_latency splits ${splits(id, 'min_latency')} of ${by(id, 'min_latency').length} runs, balanced ${splits(id, 'balanced')} of ${by(id, 'balanced').length}`);
  }
  const q5m = by('Q5', 'min_latency');
  const q5split = splits('Q5', 'min_latency') <= splits('Q5', 'balanced');
  reasons.push(`${q5split ? 'met' : 'NOT met'}: Q5, min_latency splits ${splits('Q5', 'min_latency')} of ${q5m.length} runs, balanced ${splits('Q5', 'balanced')} of ${by('Q5', 'balanced').length}`);
  const q5gate = q5m.length === 3 && q5m.every((t) => held(t) && (t.mcpRequests ?? []).length === 0);
  reasons.push(`${q5gate ? 'met' : 'NOT met'}: Q5, the gate holds it with zero MCP requests in every min_latency run (${q5m.filter(held).length} of ${q5m.length} held, ${q5m.reduce((n, t) => n + (t.mcpRequests ?? []).length, 0)} requests)`);
  const q5ask = q5m.length === 3 && q5m.every(asks);
  reasons.push(`${q5ask ? 'met' : 'NOT met'}: Q5, the agent asks for a paste in every min_latency run (${q5m.filter(asks).length} of ${q5m.length})`);
  const g1ok = g1.c1 && g1.c2;
  reasons.push(`${g1ok ? 'met' : 'NOT met'}: G1 stands. ${g1.reasons[0]}; ${g1.reasons[1]}`);
  const adopt = complete && reasons.every((r) => r.startsWith('met'));
  const md = [
    '## Round H1: shorter pauses, and the spoken address',
    '',
    `From \`${AB_H1_FILE}\`: ${T.length} turns in ${new Set(T.map((t) => t.sessionId)).size} sessions. The 400 ms and 600 ms clips are G1's own two halves with less silence between them; nothing else differs (\`data/latency-ab-clips.json\`). Q5 is the video's spoken-address clip, asked as in scene C: after Q3's swap, with nothing ever pasted. "Turns" counts the \`transcript.user\` events the utterance became. The gate and the MCP requests are the in-process executor's own records: every MCP request it makes is what the page would send as \`/api/mcp/call\`. "Asks for a paste" is the video's own scene C3 test, the word "paste" in what the agent said.`,
    '',
    ...rows,
    '',
    ...splitNote,
    '### Q5, run by run',
    '',
    ...q5rows,
    '',
    'What each Q5 run heard, turn by turn:',
    '',
    ...heardList,
    '',
    ...(unvoicedNotes.length ? ['Text a reply carried with no audio (the API sent it as `transcript.agent`; nobody heard it):', '', ...unvoicedNotes, ''] : []),
    '## The decision (brief H2): adopt min_latency if all of these hold',
    '',
    ...(complete ? [] : ['- NOT met: the runs are incomplete (3 of each clip in each arm are needed)']),
    ...reasons.map((r) => `- ${r}`),
    '',
    `Decision: ${adopt ? 'adopt min_latency' : 'keep balanced'}.`,
    '',
  ];
  return { md, adopt, complete, reasons };
}

export function report(): { md: string; adopt: boolean; reasons: string[] } {
  const g1 = reportG1();
  const h1 = existsSync(AB_H1_FILE) ? reportH1(g1) : undefined;
  const adopt = h1?.adopt ?? false;
  const md = [
    '# transcription_mode: balanced against min_latency',
    '',
    `Generated by \`scripts/latency-ab.ts report\` from two in-process A/Bs, each session set up exactly as the page sets up its server. "balanced" sends no \`transcription_mode\`: the API's default, and what interpres ${adopt ? 'sent until round H' : 'sends'}. "min_latency" adds \`input.transcription_mode: "min_latency"\` to every input update${adopt ? ', which is what interpres now sends' : ''}. End of turn runs from the clip's last voiced sample to the API's \`input.speech.stopped\`. Voice to voice is measured the \`e2e-audio\` way, from the clip's last chunk sent to the first \`reply.audio\`. A turn splits when the utterance becomes more than one \`transcript.user\`, or a reply begins before the clip's last voiced sample.`,
    '',
    ...g1.md,
    ...(h1 ? h1.md : []),
  ].join('\n');
  return { md, adopt, reasons: h1?.reasons ?? g1.reasons };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'clips') await makeClips();
  else if (cmd === 'run') { const i = process.argv.indexOf('--runs'); await runAll(i > 0 ? Number(process.argv[i + 1]) : 3); }
  else if (cmd === 'clips-h1') await makeH1Clips();
  else if (cmd === 'run-h1') { const i = process.argv.indexOf('--runs'); await runAll(i > 0 ? Number(process.argv[i + 1]) : 3, 'H1'); }
  else if (cmd === 'report') { const r = report(); writeFileSync('docs/LATENCY.md', `${r.md}\n`); console.log(r.md); }
  else { console.error('clips | run [--runs 3] | clips-h1 | run-h1 [--runs 3] | report'); process.exit(2); }
}
