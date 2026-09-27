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
 *   node --env-file=.env scripts/latency-ab.ts clips
 *   node --env-file=.env scripts/latency-ab.ts run [--runs 3]
 *   node --env-file=.env scripts/latency-ab.ts report
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AudioPump, parseWav, silence } from './lib/audio.ts';
import { LiveSession } from './lib/session.ts';
import { getSession, getTimeline } from './session-history.ts';
import { speakAsGreeting, wav } from './video/voices.ts';
import { PROPER_NOUN_VARIANTS } from './video/config.ts';
import { matchWords, transcribeFile } from './video/stt.ts';
import { SAMPLE_ADDRESS } from './video/capture.ts';

export const AB_FILE = 'data/latency-ab-2026-09-27.json';
export const AB_CLIPS = 'data/latency-ab-clips.json';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clipDef = (id: string) => CLIPS.find((c) => c.id === id)!;

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

// ------------------------------------------------------------------ runs

export type Turn = {
  clip: string; mode: Mode; run: number; sessionId: string; at: string;
  heard: string; exact: boolean; transcripts: number; split: boolean;
  endOfTurnMs: number | null; voiceToVoiceMs: number | null;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
};

async function runSession(url: string, clips: string[], mode: Mode, run: number): Promise<Turn[]> {
  const s = await LiveSession.open(url, { asPage: true, maxSessionSeconds: 180, ...(mode === 'min_latency' ? { transcriptionMode: 'min_latency' as const } : {}) });
  const events: Array<{ t: number; type: string; text?: string }> = [];
  s.onEvent((m) => events.push({ t: Date.now(), type: m.type, text: m.type === 'transcript.user' ? String(m.text ?? '') : undefined }));
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
      const earlyReply = inTurn.some((e) => e.type === 'reply.started' && e.t < voicedEnd);
      const heard = done.heard.join(' ').trim();
      out.push({
        clip: id, mode, run, sessionId: s.sessionId, at: new Date(sentFrom).toISOString(),
        heard, exact: matchWords(c.text, heard, PROPER_NOUN_VARIANTS).ok,
        transcripts, split: transcripts > 1 || earlyReply,
        endOfTurnMs: stop ? Math.round(stop.t - voicedEnd) : null,
        voiceToVoiceMs: done.voiceToVoiceMs ?? null,
        calls: done.calls.map((x) => ({ name: x.name, arguments: x.arguments })),
      });
      const o = out.at(-1)!;
      console.log(`  ${mode.padEnd(11)} run ${run} ${id.padEnd(10)} ${s.sessionId} heard "${heard}" ${o.exact ? 'exact' : 'DIFFERS'}${o.split ? ' SPLIT' : ''} | end of turn ${o.endOfTurnMs} ms | v2v ${o.voiceToVoiceMs} ms | ${o.calls.map((x) => `${x.name}(${JSON.stringify(x.arguments)})`).join(', ') || 'no call'}`);
      await pump.enqueue(silence(800));
    }
  } finally {
    pump.stop();
    await s.close();
  }
  return out;
}

async function runAll(runs: number): Promise<void> {
  for (const c of CLIPS) if (!existsSync(c.file)) throw new Error(`${c.id}: no clip at ${c.file}; run "clips" first`);
  const saved: { turns: Turn[] } = existsSync(AB_FILE) ? JSON.parse(readFileSync(AB_FILE, 'utf8')) : { turns: [] };
  for (let run = 1; run <= runs; run++) {
    for (const plan of PLANS) {
      // Alternate which arm goes first, run by run, so time of day falls on both evenly.
      const order: Mode[] = run % 2 ? ['balanced', 'min_latency'] : ['min_latency', 'balanced'];
      for (const mode of order) {
        if (saved.turns.some((t) => t.run === run && t.mode === mode && plan.clips.includes(t.clip))) continue;
        let turns: Turn[] = [];
        for (let attempt = 1; attempt <= 2 && turns.length === 0; attempt++) {
          try { turns = await runSession(plan.url, plan.clips, mode, run); } catch (err) { console.error(`  ${mode} run ${run} ${plan.clips.join('+')}: ${err instanceof Error ? err.message : err}`); }
        }
        saved.turns.push(...turns);
        writeFileSync(AB_FILE, `${JSON.stringify({ what: 'Round G1: transcription_mode balanced (nothing sent, today) against min_latency; in-process, the page\'s exact session setup per server. scripts/latency-ab.ts', ...saved }, null, 1)}\n`);
      }
    }
  }
}

// ------------------------------------------------------------------ report

const median = (xs: number[]) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export function report(): { md: string; adopt: boolean; reasons: string[] } {
  const d = JSON.parse(readFileSync(AB_FILE, 'utf8')) as { turns: Turn[] };
  const T = d.turns;
  const by = (clip: string, mode: Mode) => T.filter((t) => t.clip === clip && t.mode === mode);
  const rows: string[] = [];
  rows.push('| clip | arm | heard exactly | split | median end of turn | median voice to voice | tool calls |', '| --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const c of CLIPS) for (const mode of ['balanced', 'min_latency'] as Mode[]) {
    const ts = by(c.id, mode);
    const calls = [...new Set(ts.map((t) => t.calls.map((x) => `${x.name}(${JSON.stringify(x.arguments)})`).join(' + ') || 'none'))];
    rows.push(`| ${c.id} | ${mode} | ${ts.filter((t) => t.exact).length} of ${ts.length} | ${ts.filter((t) => t.split).length} of ${ts.length} | ${Math.round(median(ts.map((t) => t.endOfTurnMs ?? NaN)))} ms | ${Math.round(median(ts.map((t) => t.voiceToVoiceMs ?? NaN)))} ms | ${calls.join('; ')} |`);
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
  reasons.push(`${c3 ? 'met' : 'NOT met'}: the hesitation clip never splits in min_latency (${hes.filter((t) => !t.split).length} of ${hes.length} whole)`);
  const md = [
    '# transcription_mode: balanced against min_latency',
    '',
    `Generated by \`scripts/latency-ab.ts report\` from \`${AB_FILE}\`: ${T.length} turns, in-process sessions set up as the page sets up each server. "balanced" sends nothing (the API's default, and what interpres sent until then); "min_latency" adds \`input.transcription_mode: "min_latency"\`. End of turn runs from the clip's last voiced sample to the API's \`input.speech.stopped\`; voice to voice is measured the \`e2e-audio\` way, from the clip's last chunk sent to the first \`reply.audio\`.`,
    '',
    `Median over every turn: end of turn ${Math.round(eotMed('balanced'))} ms balanced, ${Math.round(eotMed('min_latency'))} ms min_latency; voice to voice ${Math.round(allMed('balanced'))} ms balanced, ${Math.round(allMed('min_latency'))} ms min_latency.`,
    '',
    ...rows,
    '',
    '## The rule (brief G1): adopt only if all three hold',
    '',
    ...reasons.map((r) => `- ${r}`),
    '',
    `Decision: ${c1 && c2 && c3 ? 'adopt min_latency' : 'keep balanced'}.`,
    '',
  ].join('\n');
  return { md, adopt: c1 && c2 && c3, reasons };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'clips') await makeClips();
  else if (cmd === 'run') { const i = process.argv.indexOf('--runs'); await runAll(i > 0 ? Number(process.argv[i + 1]) : 3); }
  else if (cmd === 'report') { const r = report(); writeFileSync('docs/LATENCY.md', `${r.md}\n`); console.log(r.md); }
  else { console.error('clips | run [--runs 3] | report'); process.exit(2); }
}
