/**
 * Every narration line and caller clip in the demo video, spoken by an
 * AssemblyAI Voice Agent voice. One session per line, opened with the API key
 * from this machine (not through the public site, whose limits are for
 * judges): the voice is set, the exact line goes in `greeting`, and the
 * greeting's `reply.audio` (PCM16, 24 kHz) is saved before the session ends.
 *
 * Each narration clip is then transcribed with AssemblyAI and must match its
 * line word for word, after case, punctuation and number format
 * (scripts/video/stt.ts): the first try and three retries, then the run stops.
 *
 * Caller clips Q1-Q4 are judged where they are heard, in a live session set up
 * as the page sets up that scene (scripts/video/caller-gate.ts). Their
 * pre-recorded transcript is kept as information and never retried. Q5, the
 * spoken address, is not checked word for word.
 *
 *   node --env-file=.env scripts/video/voices.ts [--only N1,Q1] [--force]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mintToken, WS_URL } from '../lib/session.ts';
import { PROPER_NOUN_VARIANTS, VOICES, callerLines, callerSay, narration } from './config.ts';
import { matchWords, transcribeFile } from './stt.ts';

export const VOICE_DIR = 'video/voices';
export const MANIFEST = 'data/video/voices.json';
const RATE = 24_000;
const GAP_MS = 250;

/** PCM16 mono little-endian into a WAV file's bytes. */
export function wav(pcm: Buffer, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

type Spoken = { pcm: Buffer; sessionId: string; said: string; path: 'greeting' | 'conversation.message' };

/** One session: the line as the greeting, its audio saved, the session ended. */
export async function speakAsGreeting(text: string, voice: string): Promise<Spoken> {
  const token = await mintToken(60);
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  const chunks: Buffer[] = [];
  let sessionId = '';
  let said = '';
  return await new Promise<Spoken>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error(`no greeting within 45 s (${sessionId || 'no session'})`)); }, 45_000);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.send(JSON.stringify({ type: 'session.end' })); } catch { /* closed */ }
      setTimeout(() => ws.close(), 500);
      resolve({ pcm: Buffer.concat(chunks), sessionId, said, path: 'greeting' });
    };
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          system_prompt: 'You read one line aloud as your greeting and then stay silent.',
          greeting: text,
          input: { format: { encoding: 'audio/pcm' } },
          output: { voice, format: { encoding: 'audio/pcm' } },
        },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
      if (msg.type === 'session.ready') sessionId = String(msg.session_id ?? '');
      else if (msg.type === 'reply.audio') chunks.push(Buffer.from(String(msg.data ?? ''), 'base64'));
      else if (msg.type === 'transcript.agent') said = String(msg.text ?? '');
      else if (msg.type === 'reply.done') finish();
      else if (msg.type === 'session.error') { clearTimeout(timer); ws.close(); reject(new Error(`session.error ${String(msg.code)}: ${String(msg.message)}`)); }
    });
    ws.addEventListener('close', () => { if (!done && chunks.length > 0) finish(); });
  });
}

/** Sentences, for a line too long to be one greeting. */
export function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((s) => s.trim()) ?? [text];
}

/** strict: narration, must match; info: caller Q1-Q4, recorded only; none: Q5. */
type Check = 'strict' | 'info' | 'none';

type Entry = {
  id: string; voice: string; text: string; file: string; path: string; parts: number;
  /** What the voice was given, when it differs from `text` (the caption). */
  say?: string;
  attempts: Array<{ sessionIds: string[]; ms: number; transcript?: string; speechModel?: string | null; pass?: boolean; firstDifference?: unknown; variantsUsed?: string[] }>;
  /** strict: the clip matched. info and none: the clip was made. */
  pass: boolean; checked: boolean | Check;
};

/** The first try plus up to three retries, counted across runs for the same line and voice. */
export const MAX_TRIES = 4;

async function makeLine(id: string, text: string, voice: string, check: Check, previous?: Entry, say = text): Promise<Entry> {
  const same = previous !== undefined && previous.text === text && previous.voice === voice && (previous.say ?? previous.text) === say;
  const entry: Entry = { id, voice, text, ...(say !== text ? { say } : {}), file: `${VOICE_DIR}/${id}.wav`, path: 'greeting', parts: 1, attempts: same ? previous.attempts : [], pass: false, checked: check };
  // A caller clip is made once; its pre-recorded result is information, not a retry trigger.
  const tries = check === 'strict' ? MAX_TRIES : entry.attempts.length + 1;
  for (let attempt = entry.attempts.length + 1; attempt <= tries; attempt++) {
    let pcm: Buffer;
    const sessionIds: string[] = [];
    try {
      const r = await speakAsGreeting(say, voice);
      sessionIds.push(r.sessionId);
      pcm = r.pcm;
    } catch (err) {
      // Too long for one greeting: say it a sentence at a time, joined by 250 ms of silence.
      const parts = sentences(say);
      if (parts.length < 2) throw err;
      console.log(`  ${id}: one greeting failed (${err instanceof Error ? err.message : err}); splitting into ${parts.length} sentences`);
      const pieces: Buffer[] = [];
      for (const p of parts) {
        const r = await speakAsGreeting(p, voice);
        sessionIds.push(r.sessionId);
        if (pieces.length) pieces.push(Buffer.alloc(Math.round(RATE * GAP_MS / 1000) * 2));
        pieces.push(r.pcm);
      }
      pcm = Buffer.concat(pieces);
      entry.parts = parts.length;
    }
    writeFileSync(entry.file, wav(pcm));
    const ms = Math.round((pcm.length / 2 / RATE) * 1000);
    if (check === 'none') {
      entry.attempts.push({ sessionIds, ms });
      entry.pass = true;
      return entry;
    }
    const t = await transcribeFile(entry.file);
    const m = matchWords(text, t.text, PROPER_NOUN_VARIANTS);
    entry.attempts.push({ sessionIds, ms, transcript: t.text, speechModel: t.speechModel, pass: m.ok, firstDifference: m.firstDifference, variantsUsed: m.variantsUsed });
    const verdict = check === 'info' ? `pre-recorded ${m.ok ? 'match' : 'differs'} (information only)` : m.ok ? 'PASS' : 'FAIL';
    console.log(`  ${id} try ${attempt}: ${verdict} ${ms} ms, ${sessionIds.join('+')}${m.ok ? '' : ` | at word ${m.firstDifference?.at}: script "${m.firstDifference?.expected}" heard "${m.firstDifference?.heard}"`}`);
    if (check === 'info' || m.ok) { entry.pass = true; return entry; }
  }
  return entry;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(process.argv[i + 1]!.split(',')) : null; })();
  const force = process.argv.includes('--force');
  mkdirSync(VOICE_DIR, { recursive: true });
  const manifest: Record<string, Entry> = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')).lines : {};
  const jobs: Array<[string, string, string, Check, string]> = [
    ...Object.entries(narration()).map(([id, text]) => [id, text, VOICES.narrator, 'strict', text] as [string, string, string, Check, string]),
    ...Object.entries(callerLines()).map(([id, text]) => [id, text, VOICES.caller, id === 'Q5' ? 'none' : 'info', callerSay(id, text)] as [string, string, string, Check, string]),
  ];
  console.log(`voices: agent ${VOICES.agent}, narrator ${VOICES.narrator}, caller ${VOICES.caller}`);
  for (const [id, text, voice, check, say] of jobs) {
    if (only && !only.has(id)) continue;
    const prev = manifest[id];
    const same = prev !== undefined && prev.text === text && prev.voice === voice && (prev.say ?? prev.text) === say && existsSync(prev.file);
    // A caller clip made before, whatever its pre-recorded result, is kept: the live gate judges it.
    if (!force && same && (prev.pass || check === 'info')) { console.log(`  ${id}: kept (made before${check === 'info' ? '; judged by the live gate' : ', passed'})`); continue; }
    const e = await makeLine(id, text, voice, check, prev, say);
    manifest[id] = e;
    writeFileSync(MANIFEST, `${JSON.stringify({ voices: VOICES, lines: manifest }, null, 1)}\n`);
    if (!e.pass) {
      console.error(`\nSTOP: ${id} failed its check on all ${e.attempts.length} tries (the first and ${e.attempts.length - 1} retries). Last transcript: ${e.attempts.at(-1)?.transcript}`);
      process.exit(1);
    }
  }
  console.log(`\nwritten: ${MANIFEST}`);
}
