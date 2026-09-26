/**
 * Brief F, F2.7: the checks on a rendered file.
 * - ffprobe against F2.1 (1920x1080, 30 fps constant, H.264 High, yuv420p;
 *   AAC-LC 48 kHz stereo 192 kbps; +faststart, read off the atom order);
 * - loudness with ebur128 (-16 LUFS integrated +-1, true peak <= -1.5 dBTP);
 * - blackdetect: no black over 0.3 s outside fades;
 * - silencedetect at -45 dB and 2.5 s: every silence, with what it is;
 * - the sync offsets of every capture used;
 * - AssemblyAI's transcript of the file's audio, with timestamps and speaker
 *   labels, and the narration checked word for word against the script;
 * - a contact sheet (a frame every 5 s, stamped) and full-size key frames.
 *
 *   node --env-file=.env scripts/video/checks.ts --edl video/out/edl.json --file video/out/interpres-demo.mp4 [--final]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { PROPER_NOUN_VARIANTS, narration } from './config.ts';
import { matchWords, transcribeFile } from './stt.ts';
import { KIT } from './edl.ts';
import type { Edl } from './edl.ts';
import { ffmpegStderr, measure } from './render.ts';

GlobalFonts.registerFromPath(`${KIT}/fonts/jetbrains-mono-latin-500-normal.ttf`, 'JB Mono Medium');

type Result = { check: string; ok: boolean; detail: string };

/** Top-level MP4 atoms in order: +faststart puts moov before mdat. */
function atoms(file: string): string[] {
  const fd = openSync(file, 'r');
  const size = statSync(file).size;
  const out: string[] = [];
  let off = 0;
  const h = Buffer.alloc(16);
  while (off + 8 <= size && out.length < 20) {
    readSync(fd, h, 0, 16, off);
    let len = h.readUInt32BE(0);
    const type = h.toString('ascii', 4, 8);
    if (len === 1) len = Number(h.readBigUInt64BE(8));
    if (len === 0) len = size - off;
    out.push(type);
    off += len;
  }
  closeSync(fd);
  return out;
}

export function probe(file: string): Result[] {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = j.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const r: Result[] = [];
  const add = (check: string, ok: boolean, detail: string) => r.push({ check, ok, detail });
  add('video: H.264 High', v.codec_name === 'h264' && v.profile === 'High', `${v.codec_name} ${v.profile}`);
  add('video: 1920x1080', v.width === 1920 && v.height === 1080, `${v.width}x${v.height}`);
  add('video: yuv420p', v.pix_fmt === 'yuv420p', v.pix_fmt);
  add('video: 30 fps constant', v.r_frame_rate === '30/1' && v.avg_frame_rate === '30/1', `r ${v.r_frame_rate}, avg ${v.avg_frame_rate}`);
  add('audio: AAC-LC', a.codec_name === 'aac' && a.profile === 'LC', `${a.codec_name} ${a.profile}`);
  add('audio: 48 kHz stereo', a.sample_rate === '48000' && a.channels === 2, `${a.sample_rate} Hz, ${a.channels} ch`);
  add('audio: 192 kbps', Math.abs(Number(a.bit_rate) - 192_000) <= 8_000, `${a.bit_rate} b/s`);
  const at = atoms(file);
  add('+faststart (moov before mdat)', at.indexOf('moov') >= 0 && at.indexOf('moov') < at.indexOf('mdat'), at.join(' '));
  return r.concat([{ check: 'duration and size', ok: true, detail: `${Number(j.format.duration).toFixed(3)} s, ${Number(j.format.size).toLocaleString('en-US')} bytes` }]);
}

export function finalLimits(file: string): Result[] {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', file]).toString());
  const d = Number(j.format.duration);
  const s = Number(j.format.size);
  return [
    { check: 'length 3:30 to 4:15 (hard cap 4:55)', ok: d >= 210 && d <= 255, detail: `${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, '0')}` },
    { check: 'size 300 MB or less', ok: s <= 300 * 1024 * 1024, detail: `${(s / 1024 / 1024).toFixed(1)} MB` },
  ];
}

export function loud(file: string): Result[] {
  const m = measure(file);
  return [
    { check: 'loudness -16 LUFS integrated +-1', ok: Math.abs(m.i + 16) <= 1, detail: `${m.i} LUFS (LRA ${m.lra} LU)` },
    { check: 'true peak -1.5 dBTP or lower', ok: m.tp <= -1.5, detail: `${m.tp} dBTP` },
  ];
}

/** Every stretch of black over 0.3 s, and whether it sits in a fade. */
export function black(file: string, edl: Edl): { result: Result; spans: Array<{ start: number; end: number; inFade: boolean }> } {
  const text = ffmpegStderr(['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.3:pix_th=0.10', '-an', '-f', 'null', '-']);
  const spans = [...text.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]) * 1000, end: Number(m[2]) * 1000 }));
  const fades = edl.shots.slice(1).map((s) => ({ start: s.start - 50, end: s.start + 350 }));
  const tagged = spans.map((s) => ({ ...s, inFade: fades.some((f) => s.start >= f.start && s.end <= f.end) }));
  return { result: { check: 'no black over 0.3 s outside fades', ok: tagged.every((s) => s.inFade), detail: `${tagged.length} black span(s)` }, spans: tagged };
}

/** Every silence at -45 dB for 2.5 s or more, and what it is: read off the edit list and the capture logs. */
export function silences(file: string, edl: Edl): Array<{ start: number; end: number; what: string }> {
  const text = ffmpegStderr(['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=n=-45dB:d=2.5', '-vn', '-f', 'null', '-']);
  const starts = [...text.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
  const ends = [...text.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
  const logs = new Map<string, Array<{ t: number; type: string; [k: string]: unknown }>>();
  const logOf = (name: string) => {
    if (!logs.has(name)) logs.set(name, JSON.parse(readFileSync(`video/captures/${name}/capture.json`, 'utf8')).log);
    return logs.get(name)!;
  };
  return starts.map((s, i) => {
    const e = ends[i] ?? edl.durationMs;
    const parts: string[] = [];
    const ex = edl.exchanges.find((x) => x.agentStartAt !== null && s < x.agentStartAt && e > x.callerEndAt);
    if (ex) parts.push(`${ex.id}: the voice-to-voice wait from the caller's last word to the agent's first (${ex.voiceToVoiceMs} ms), never cut`);
    for (const shot of edl.shots.filter((x) => s < x.end && e > x.start)) {
      if (shot.kind === 'still') { parts.push(edl.endCard && e > edl.endCard.start ? `the ${shot.name} slide and the end card` : `the ${shot.name} slide`); continue; }
      const seen = new Set<string>();
      for (const g of shot.segments) {
        const a = Math.max(s, g.at);
        const b = Math.min(e, g.at + (g.to - g.from));
        if (b <= a) continue;
        const c0 = g.from + (a - g.at);
        const c1 = g.from + (b - g.at);
        for (const ev of logOf(shot.capture).filter((x) => x.t >= c0 - 200 && x.t <= c1)) {
          if (ev.type === 'harness.talk' && ev.label === 'start') seen.add('Talk pressed: the page fetches a token, opens the session and waits for the greeting');
          else if (ev.type === 'harness.talk' && ev.label === 'end') seen.add('the session ended with the Talk button');
          else if (ev.type === 'ws.in' && ev.msg === 'tool.call') seen.add(`the tool call ${String(ev.name)} runs`);
          else if (ev.type === 'key') seen.add('typing');
          else if (ev.type === 'mousedown') seen.add('clicks');
          else if (ev.type === 'harness.scrolled') seen.add('scrolling');
          else if (ev.type === 'paste') seen.add('the paste');
        }
      }
      const zooms = edl.punchIns.filter((p) => p.start < e && p.start + p.hold + 800 > s).map((p) => `punch-in on ${p.reason}`);
      parts.push(`${shot.name} (live)${seen.size || zooms.length ? `: ${[...seen, ...zooms].join('; ')}` : ': the page between spoken turns'}`);
    }
    return { start: Math.round(s), end: Math.round(e), what: parts.join(' | ') || 'between scenes' };
  });
}

/** AssemblyAI transcript of the file's audio: words, speaker labels, and a text file. */
export async function transcript(file: string, outTxt: string): Promise<{ id: string; speechModel: string | null; words: Array<{ text: string; start: number; end: number; speaker?: string | null }>; utterances: Array<{ speaker: string; text: string; start: number; end: number }> }> {
  const flac = file.replace(/\.mp4$/, '-audio.flac');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', flac]);
  const t = await transcribeFile(flac, { speakerLabels: true });
  const ts = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${((ms % 60000) / 1000).toFixed(2).padStart(5, '0')}`;
  const lines = [
    `AssemblyAI transcript of ${file.split('/').at(-1)}'s audio. Transcript ${t.id}, speech model ${t.speechModel}, speaker labels on.`,
    'Speaker letters are AssemblyAI\'s own; the video has three voices: the narrator (charles), the caller (michael) and the agent (alba).',
    '',
    ...(t.utterances ?? []).map((u) => `[${ts(u.start)} - ${ts(u.end)}] Speaker ${u.speaker}: ${u.text}`),
    '',
  ];
  writeFileSync(outTxt, lines.join('\n'));
  return { id: t.id, speechModel: t.speechModel, words: t.words, utterances: t.utterances ?? [] };
}

/** Each narration line, from the words heard inside its window, against the script. */
export function narrationCheck(edl: Edl, words: Array<{ text: string; start: number; end: number }>): Result[] {
  const script = narration();
  return edl.narration.map((n) => {
    const heard = words.filter((w) => w.start >= n.at - 150 && w.end <= n.at + n.ms + 400).map((w) => w.text).join(' ');
    const m = matchWords(script[n.id]!, heard, PROPER_NOUN_VARIANTS);
    return { check: `${n.id} word for word`, ok: m.ok, detail: m.ok ? `ok${m.variantsUsed.length ? ` (variants: ${m.variantsUsed.join(', ')})` : ''}` : `at word ${m.firstDifference?.at}: script "${m.firstDifference?.expected}" heard "${m.firstDifference?.heard}"` };
  });
}

/** A frame every 5 s, stamped with its time, in one sheet. */
export async function contactSheet(file: string, out: string, durationMs: number): Promise<number> {
  const dir = out.replace(/\.png$/, '-tmp');
  mkdirSync(dir, { recursive: true });
  const times: number[] = [];
  for (let t = 0; t < durationMs / 1000; t += 5) times.push(t);
  for (const t of times) spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=384:216', `${dir}/${String(t).padStart(4, '0')}.png`]);
  const cols = 6;
  const rows = Math.ceil(times.length / cols);
  const cv = createCanvas(cols * 392 + 8, rows * 236 + 8);
  const g = cv.getContext('2d');
  g.fillStyle = '#05070a';
  g.fillRect(0, 0, cv.width, cv.height);
  for (const [i, t] of times.entries()) {
    const img = await loadImage(readFileSync(`${dir}/${String(t).padStart(4, '0')}.png`));
    const x = 8 + (i % cols) * 392;
    const y = 8 + Math.floor(i / cols) * 236;
    g.drawImage(img, x, y, 384, 216);
    g.fillStyle = 'rgba(0,0,0,0.75)';
    g.fillRect(x, y + 216, 384, 18);
    g.fillStyle = '#e8eaed';
    g.font = '14px "JB Mono Medium"';
    g.fillText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, x + 6, y + 230);
  }
  writeFileSync(out, cv.toBuffer('image/png'));
  return times.length;
}

export function keyFrame(file: string, atMs: number, out: string): void {
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', (atMs / 1000).toFixed(3), '-i', file, '-frames:v', '1', out]);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const edl = JSON.parse(readFileSync(arg('--edl') ?? 'video/out/edl.json', 'utf8')) as Edl;
  const file = arg('--file') ?? 'video/out/interpres-demo.mp4';
  const results: Result[] = [...probe(file), ...(process.argv.includes('--final') ? finalLimits(file) : []), ...loud(file)];
  const b = black(file, edl);
  results.push(b.result);
  const sil = silences(file, edl);
  const tr = await transcript(file, file.replace(/\.mp4$/, '-transcript.txt'));
  results.push(...narrationCheck(edl, tr.words));
  const sheet = file.replace(/\.mp4$/, '-contact.png');
  const n = await contactSheet(file, sheet, edl.durationMs);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.check}: ${r.detail}`);
  console.log(`black spans: ${JSON.stringify(b.spans)}`);
  console.log('silences (-45 dB, 2.5 s):');
  for (const s of sil) console.log(`  ${(s.start / 1000).toFixed(2)}-${(s.end / 1000).toFixed(2)} s: ${s.what}`);
  console.log(`transcript ${tr.id} (${tr.speechModel}), contact sheet ${sheet} (${n} frames)`);
  writeFileSync(file.replace(/\.mp4$/, '-checks.json'), JSON.stringify({ file, results, black: b.spans, silences: sil, transcript: { id: tr.id, speechModel: tr.speechModel } }, null, 1));
}
