/**
 * The renderer: an edit list (scripts/video/edl.ts) and the saved captures in,
 * the video out. Frames are drawn with @napi-rs/canvas and piped as raw RGBA
 * into ffmpeg's libx264; the sound is mixed here from the narration clips and
 * the capture stems, level-matched stem by stem, then brought to -16 LUFS by
 * one gain and a 4x-oversampled peak limiter (see mix()).
 *
 * Look (brief F, F2.6): a 1920x1080 canvas in #0b0d10 with the deck cover's
 * radial gradient; every scene in one 1632x918 box at (144, 24); live scenes
 * get a 40 px #12161b title bar with three muted dots and an address pill
 * showing the page's real URL from the log, and the page at 1632x878 under
 * it; slides and the cover are scaled into the box. Captions are burned into
 * the band below, IBM Plex Sans Medium 36 px; labels JetBrains Mono 20 px.
 * Punch-ins zoom the page only, never the title bar.
 *
 *   node scripts/video/render.ts --edl video/out/edl.json --out video/out/interpres-demo.mp4
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import type { Image, SKRSContext2D, Canvas } from '@napi-rs/canvas';
import { KIT } from './edl.ts';
import type { Edl, Shot, Caption } from './edl.ts';
import { readF32Wav, wavF32 } from './assemble.ts';

export const W = 1920;
export const H = 1080;
export const BOX = { x: 144, y: 24, w: 1632, h: 918 };
export const BAR = 40;
export const PAGE = { x: 144, y: 64, w: 1632, h: 878 };
const SRC = { w: 2176, h: 1170 };
const RATE = 48_000;
const COLORS = { bg: '#0b0d10', bar: '#12161b', text: '#e8eaed', caller: '#6ee7b7', agent: '#a78bfa', label: '#8d96a3', dot: '#3a414b', pill: '#0b0d10', frame: '#222932' };

GlobalFonts.registerFromPath(`${KIT}/fonts/ibm-plex-sans-latin-500-normal.ttf`, 'Plex Medium');
GlobalFonts.registerFromPath(`${KIT}/fonts/jetbrains-mono-latin-400-normal.ttf`, 'JB Mono');

// ------------------------------------------------------------------ helpers

type Rect = { x: number; y: number; w: number; h: number };
type LogEv = { t: number; type: string; [k: string]: unknown };
type Frame = { i: number; t: number; file: string };

const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

/** The deck cover's radial gradient, measured from slides/cover.png (see BUILDLOG). */
function background(): Canvas {
  const cv = createCanvas(W, H);
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  const inner = [0x16, 0x23, 0x29];
  const outer = [0x0b, 0x0d, 0x10];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = Math.min(1, Math.hypot((x - 1580) / 1400, (y - 60) / 860));
      const k = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) img.data[k + c] = Math.round(inner[c]! + (outer[c]! - inner[c]!) * t);
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

function roundRect(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number | number[]): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

class Captures {
  private frames = new Map<string, Frame[]>();
  private logs = new Map<string, LogEv[]>();
  private cache = new Map<string, Image>();
  private order: string[] = [];

  frameAt(capture: string, t: number): Frame {
    if (!this.frames.has(capture)) this.frames.set(capture, JSON.parse(readFileSync(`video/captures/${capture}/frames.json`, 'utf8')));
    const fr = this.frames.get(capture)!;
    let lo = 0; let hi = fr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fr[mid]!.t <= t) lo = mid; else hi = mid - 1; }
    return fr[lo]!;
  }

  log(capture: string): LogEv[] {
    if (!this.logs.has(capture)) this.logs.set(capture, JSON.parse(readFileSync(`video/captures/${capture}/capture.json`, 'utf8')).log);
    return this.logs.get(capture)!;
  }

  async image(path: string): Promise<Image> {
    const hit = this.cache.get(path);
    if (hit) return hit;
    const img = await loadImage(readFileSync(path));
    this.cache.set(path, img);
    this.order.push(path);
    if (this.order.length > 12) this.cache.delete(this.order.shift()!);
    return img;
  }

  /** The page's URL at capture time t, from the log. */
  url(capture: string, t: number): string {
    let href = 'https://interpres.ochinimus.app/';
    for (const e of this.log(capture)) { if (e.t > t) break; if (e.type === 'url') href = String(e.href); }
    return href;
  }

  /** The cursor at capture time t, and any click ripple. */
  cursor(capture: string, t: number): { x: number; y: number; ripple: { x: number; y: number; age: number } | null } | null {
    const log = this.log(capture);
    let prev: LogEv | null = null;
    let next: LogEv | null = null;
    let click: LogEv | null = null;
    for (const e of log) {
      if (e.type === 'mouse') { if (e.t <= t) prev = e; else { next = e; break; } }
    }
    for (const e of log) { if (e.type === 'mousedown' && e.t <= t && t - e.t < 450) click = e; }
    if (!prev && !next) return null;
    const a = prev ?? next!;
    let x = Number(a.x); let y = Number(a.y);
    if (prev && next && Number(next.t) - Number(prev.t) < 120) {
      const k = (t - prev.t) / (next.t - prev.t);
      x = Number(prev.x) + (Number(next.x) - Number(prev.x)) * k;
      y = Number(prev.y) + (Number(next.y) - Number(prev.y)) * k;
    }
    return { x, y, ripple: click ? { x: Number(click.x), y: Number(click.y), age: t - click.t } : null };
  }
}

// ------------------------------------------------------------------ drawing

function drawCursor(g: SKRSContext2D, x: number, y: number, s: number): void {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(0, 21); g.lineTo(5, 16.5); g.lineTo(8.5, 24.5); g.lineTo(12, 23); g.lineTo(8.6, 15.2); g.lineTo(15, 15.2); g.closePath();
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#0b0d10';
  g.lineWidth = 1.6;
  g.fill();
  g.stroke();
  g.restore();
}

/** Zoom factor and focus (source px) of the page at output time t. */
function zoomAt(edl: Edl, capture: string, t: number): { z: number; fx: number; fy: number } {
  for (const p of edl.punchIns) {
    if (p.capture !== capture) continue;
    const u0 = (t - p.start) / 400;
    const u1 = (t - (p.start + 400 + p.hold)) / 400;
    if (t < p.start || t > p.start + 800 + p.hold) continue;
    const k = u1 > 0 ? 1 - ease(u1) : ease(u0);
    return { z: 1 + (p.zoom - 1) * k, fx: (p.rect.x + p.rect.w / 2) * 2, fy: (p.rect.y + p.rect.h / 2) * 2 };
  }
  return { z: 1, fx: SRC.w / 2, fy: SRC.h / 2 };
}

/** The source window for a zoom around a focus, kept inside the frame. */
function window(z: number, fx: number, fy: number): Rect {
  const w = SRC.w / z;
  const h = SRC.h / z;
  const x = Math.min(SRC.w - w, Math.max(0, fx - w / 2));
  const y = Math.min(SRC.h - h, Math.max(0, fy - h / 2));
  return { x, y, w, h };
}

async function drawLive(g: SKRSContext2D, caps: Captures, edl: Edl, capture: string, ct: number, outT: number): Promise<void> {
  // Window frame and title bar.
  g.save();
  roundRect(g, BOX.x, BOX.y, BOX.w, BOX.h, 12);
  g.clip();
  g.fillStyle = COLORS.bar;
  g.fillRect(BOX.x, BOX.y, BOX.w, BAR);
  for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(BOX.x + 22 + i * 20, BOX.y + BAR / 2, 6, 0, Math.PI * 2); g.fillStyle = COLORS.dot; g.fill(); }
  const url = caps.url(capture, ct);
  g.font = '20px "JB Mono"';
  const tw = Math.min(g.measureText(url).width, BOX.w - 220);
  const pw = tw + 36;
  roundRect(g, BOX.x + (BOX.w - pw) / 2, BOX.y + 5, pw, BAR - 10, 15);
  g.fillStyle = COLORS.pill;
  g.fill();
  g.fillStyle = COLORS.label;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillText(url, BOX.x + BOX.w / 2, BOX.y + BAR / 2 + 1, BOX.w - 220);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  // The page, zoomed only inside its own area.
  const fr = caps.frameAt(capture, ct);
  const img = await caps.image(`video/captures/${capture}/${fr.file}`);
  const { z, fx, fy } = zoomAt(edl, capture, outT);
  const win = window(z, fx, fy);
  g.save();
  g.beginPath();
  g.rect(PAGE.x, PAGE.y, PAGE.w, PAGE.h);
  g.clip();
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, win.x, win.y, win.w, win.h, PAGE.x, PAGE.y, PAGE.w, PAGE.h);
  const cur = caps.cursor(capture, ct);
  const map = (cx: number, cy: number) => ({ x: PAGE.x + (cx * 2 - win.x) * (PAGE.w / win.w), y: PAGE.y + (cy * 2 - win.y) * (PAGE.h / win.h) });
  if (cur?.ripple) {
    const p = map(cur.ripple.x, cur.ripple.y);
    const k = cur.ripple.age / 450;
    g.beginPath();
    g.arc(p.x, p.y, (10 + 26 * k) * z, 0, Math.PI * 2);
    g.fillStyle = `rgba(255,255,255,${0.35 * (1 - k)})`;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`;
    g.stroke();
  }
  if (cur) { const p = map(cur.x, cur.y); drawCursor(g, p.x, p.y, 1.5 * z); }
  g.restore();
  g.restore();
  g.lineWidth = 1;
  g.strokeStyle = COLORS.frame;
  roundRect(g, BOX.x + 0.5, BOX.y + 0.5, BOX.w - 1, BOX.h - 1, 12);
  g.stroke();
}

async function drawShot(g: SKRSContext2D, caps: Captures, edl: Edl, shot: Shot, t: number, stills: Map<string, Image>): Promise<void> {
  if (shot.kind === 'still') {
    g.drawImage(stills.get(shot.image)!, BOX.x, BOX.y, BOX.w, BOX.h);
    return;
  }
  // Inside a live shot: one segment, or two across a 200 ms cut.
  const active = shot.segments.filter((s) => t >= s.at && t < s.at + (s.to - s.from));
  if (active.length === 0) {
    const s = t < shot.segments[0]!.at ? shot.segments[0]! : shot.segments.at(-1)!;
    await drawLive(g, caps, edl, shot.capture, Math.max(s.from, Math.min(s.to, s.from + (t - s.at))), t);
    return;
  }
  if (active.length === 1) { const s = active[0]!; await drawLive(g, caps, edl, shot.capture, s.from + (t - s.at), t); return; }
  const [a, b] = active as [typeof active[0], typeof active[0]];
  const k = (t - b.at) / 200;
  const layer = createCanvas(W, H);
  const lg = layer.getContext('2d');
  await drawLive(g, caps, edl, shot.capture, a.from + (t - a.at), t);
  await drawLive(lg, caps, edl, shot.capture, b.from + (t - b.at), t);
  g.globalAlpha = Math.max(0, Math.min(1, k));
  g.drawImage(layer, 0, 0);
  g.globalAlpha = 1;
}

function drawCaption(g: SKRSContext2D, c: Caption): void {
  g.font = '36px "Plex Medium"';
  g.textBaseline = 'alphabetic';
  const baselines = c.lines.length === 1 ? [1030] : [986, 1030];
  c.lines.forEach((line, i) => {
    const y = baselines[i]!;
    const lw = g.measureText(line).width;
    let x = (W - lw) / 2;
    const label = i === 0 && c.who !== 'narration' ? (c.who === 'caller' ? 'Caller:' : 'Agent:') : null;
    if (label && line.startsWith(label)) {
      g.fillStyle = c.who === 'caller' ? COLORS.caller : COLORS.agent;
      g.fillText(label, x, y);
      x += g.measureText(label).width;
      g.fillStyle = COLORS.text;
      g.fillText(line.slice(label.length), x, y);
    } else {
      g.fillStyle = COLORS.text;
      g.fillText(line, x, y);
    }
  });
}

// ------------------------------------------------------------------ audio

/** Integrated loudness and true peak, read off ffmpeg's ebur128 summary. */
export function measure(path: string): { i: number; tp: number; lra: number } {
  const text = ffmpegStderr(['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const sum = text.slice(text.lastIndexOf('Summary:'));
  const num = (re: RegExp) => { const m = sum.match(re); return m ? Number(m[1]) : NaN; };
  return { i: num(/I:\s+(-?[\d.]+) LUFS/), tp: num(/Peak:\s+(-?[\d.]+) dBFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/) };
}

/** ffmpeg's stderr, where its analysis filters print (execFileSync would return stdout). */
export function ffmpegStderr(args: string[]): string {
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.slice(0, 6).join(' ')} exited ${r.status}: ${String(r.stderr).slice(-300)}`);
  return String(r.stderr);
}

/** The mix: narration and both stems per the edit list, level-matched, then -16 LUFS. */
export function mix(edl: Edl, outWav: string): { gains: Record<string, number>; before: Record<string, number>; loudnorm: Record<string, string> } {
  mkdirSync('video/cache', { recursive: true });
  const n = Math.ceil((edl.durationMs / 1000) * RATE);
  const tracks: Record<'narration' | 'caller' | 'agent', Float32Array> = { narration: new Float32Array(n), caller: new Float32Array(n), agent: new Float32Array(n) };
  for (const x of edl.narration) {
    const cache = `video/cache/${x.id}-${RATE}.wav`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', x.file, '-af', `aresample=${RATE}:filter_size=128:phase_shift=12:cutoff=0.97`, '-c:a', 'pcm_f32le', cache]);
    const d = readF32Wav(cache).data;
    const at = Math.round((x.at / 1000) * RATE);
    for (let i = 0; i < d.length && at + i < n; i++) tracks.narration[at + i]! += d[i]!;
  }
  const stems = new Map<string, Float32Array>();
  for (const a of edl.audio) {
    const key = `${a.capture}/${a.stem}`;
    if (!stems.has(key)) stems.set(key, readF32Wav(`video/captures/${a.capture}/stems/${a.stem}.wav`).data);
    const d = stems.get(key)!;
    const from = Math.round((a.from / 1000) * RATE);
    const len = Math.round(((a.to - a.from) / 1000) * RATE);
    const at = Math.round((a.at / 1000) * RATE);
    const fi = Math.round((a.fadeIn / 1000) * RATE);
    const fo = Math.round((a.fadeOut / 1000) * RATE);
    for (let i = 0; i < len; i++) {
      const k = at + i;
      if (k < 0 || k >= n) continue;
      let gain = 1;
      if (i < fi) gain = i / fi;
      if (i > len - fo) gain = Math.min(gain, (len - i) / fo);
      tracks[a.stem][k]! += (d[from + i] ?? 0) * gain;
    }
  }
  // Level-match: each stem's speech to the same integrated loudness.
  const gains: Record<string, number> = {};
  const before: Record<string, number> = {};
  const target = -20;
  for (const [name, d] of Object.entries(tracks)) {
    const tmp = `video/cache/stem-${name}.wav`;
    writeFileSync(tmp, wavF32(d, RATE));
    const m = measure(tmp);
    before[name] = m.i;
    gains[name] = Number.isFinite(m.i) ? 10 ** ((target - m.i) / 20) : 1;
  }
  const sum = new Float32Array(n);
  for (const [name, d] of Object.entries(tracks)) { const k = gains[name]!; for (let i = 0; i < n; i++) sum[i]! += d[i]! * k; }
  const pre = 'video/cache/mix-pre.wav';
  writeFileSync(pre, wavF32(sum, RATE));
  // -16 LUFS integrated with true peak at or under -1.5 dBTP. Speech here peaks
  // about 20 dB over its loudness, so a linear gain alone would clip and
  // loudnorm would fall back to its dynamic (AGC) mode. Instead: one gain, and
  // a limiter run at 4x the rate so it catches the peaks between samples;
  // the gain is corrected until the integrated loudness lands.
  // First a gentle compressor (3:1 above -28 dBFS), which takes the speech's
  // peak-to-loudness ratio from about 20 dB to about 17, so the limiter after
  // it only trims what is left.
  const COMP = 'acompressor=threshold=-28dB:ratio=3:attack=8:release=150:knee=6';
  const comp = 'video/cache/mix-comp.wav';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', pre, '-af', COMP, '-c:a', 'pcm_f32le', comp]);
  const m0 = measure(comp);
  // The output is stereo with both channels the same, which EBU R128 measures
  // 3.01 dB louder than the mono it was made from: aim the gain accordingly.
  let gainDb = -16 - (m0.i + 3.01);
  const passes: Array<{ gainDb: number; i: number; tp: number; limiterMaxReductionDb: number }> = [];
  for (let k = 0; k < 4; k++) {
    // Dual mono at 0 dB per channel: ffmpeg's -ac 2 would pan each channel down 3 dB.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', comp, '-af', `volume=${gainDb.toFixed(2)}dB,aresample=192000,alimiter=limit=0.767:attack=2:release=60:level=disabled,aresample=${RATE},pan=stereo|c0=c0|c1=c0`, '-c:a', 'pcm_f32le', outWav]);
    const m1 = measure(outWav);
    // How hard the limiter worked: the true peak it was given, over its -2.3 dBFS ceiling.
    passes.push({ gainDb: Math.round(gainDb * 100) / 100, i: m1.i, tp: m1.tp, limiterMaxReductionDb: Math.max(0, Math.round((m0.tp + gainDb + 2.3) * 10) / 10) });
    if (Math.abs(m1.i + 16) <= 0.15) break;
    gainDb += -16 - m1.i;
  }
  const j: Record<string, string> = { pre_i: String(m0.i), pre_tp: String(m0.tp), compressor: COMP, limiter: 'alimiter limit 0.767 (-2.3 dBFS), attack 2 ms, release 60 ms, at 192 kHz', passes: JSON.stringify(passes) };
  return { gains, before, loudnorm: j };
}

// ------------------------------------------------------------------ render

export async function render(edl: Edl, out: string, opts: { from?: number; to?: number } = {}): Promise<{ frames: number; mix: ReturnType<typeof mix> }> {
  mkdirSync('video/out', { recursive: true });
  const wav = out.replace(/\.mp4$/, '.wav');
  const m = mix(edl, wav);
  const caps = new Captures();
  const bg = background();
  const stills = new Map<string, Image>();
  for (const s of edl.shots) if (s.kind === 'still' && !stills.has(s.image)) {
    if (!existsSync(s.image)) throw new Error(`missing still ${s.image}`);
    stills.set(s.image, await loadImage(readFileSync(s.image)));
  }
  const total = Math.round((edl.durationMs / 1000) * edl.fps);
  const f0 = opts.from ?? 0;
  const f1 = opts.to ?? total;
  const ff = spawn('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(edl.fps), '-i', 'pipe:0',
    '-ss', String(f0 / edl.fps), '-i', wav,
    '-map', '0:v', '-map', '1:a',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '18', '-g', '60',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', String(edl.fps), '-fps_mode', 'cfr',
    // AudioToolbox AAC-LC at a constant 192 kbps: ffmpeg's own encoder ran 142 kbps on this speech.
    '-c:a', 'aac_at', '-aac_at_mode', 'cbr', '-b:a', '192k', '-ar', String(RATE), '-ac', '2',
    '-t', String((f1 - f0) / edl.fps),
    '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<void>((res, rej) => ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`)))));
  const cv = createCanvas(W, H);
  const g = cv.getContext('2d');
  const layer = createCanvas(W, H);
  const lg = layer.getContext('2d');
  const t0 = Date.now();
  for (let f = f0; f < f1; f++) {
    const t = (f * 1000) / edl.fps;
    g.globalAlpha = 1;
    g.drawImage(bg, 0, 0);
    const active = edl.shots.filter((s) => t >= s.start && t < s.end);
    if (active.length === 0 && edl.shots.length) active.push(t < edl.shots[0]!.start ? edl.shots[0]! : edl.shots.at(-1)!);
    await drawShot(g, caps, edl, active[0]!, t, stills);
    if (active.length > 1) {
      const b = active[1]!;
      const k = Math.max(0, Math.min(1, (t - b.start) / (active[0]!.end - b.start)));
      lg.drawImage(bg, 0, 0);
      await drawShot(lg, caps, edl, b, t, stills);
      g.globalAlpha = k;
      g.drawImage(layer, 0, 0);
      g.globalAlpha = 1;
    }
    for (const l of edl.labels) {
      if (t < l.start || t >= l.end) continue;
      const a = Math.min(1, (t - l.start) / 300, (l.end - t) / 300);
      g.globalAlpha = Math.max(0, a);
      g.font = '20px "JB Mono"';
      g.fillStyle = COLORS.label;
      g.fillText(l.text, BOX.x, 1068);
      g.globalAlpha = 1;
    }
    const cap = edl.captions.find((c) => t >= c.start && t < c.end);
    if (cap) drawCaption(g, cap);
    if (edl.endCard && t >= edl.endCard.start && t < edl.endCard.end) {
      g.globalAlpha = Math.min(1, (t - edl.endCard.start) / 300);
      g.font = '26px "Plex Medium"';
      g.fillStyle = COLORS.text;
      g.textAlign = 'center';
      edl.endCard.lines.forEach((line, i) => g.fillText(line, W / 2, 984 + i * 36));
      g.textAlign = 'left';
      g.globalAlpha = 1;
    }
    const px = g.getImageData(0, 0, W, H).data;
    if (!ff.stdin.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength))) await new Promise((r) => ff.stdin.once('drain', r));
    if ((f - f0) % 300 === 0) process.stdout.write(`\r  frame ${f - f0}/${f1 - f0} (${((f - f0) / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1)} fps)`);
  }
  ff.stdin.end();
  await done;
  process.stdout.write('\n');
  return { frames: f1 - f0, mix: m };
}

/** The captions as SubRip, labels included. */
export function srt(edl: Edl): string {
  const ts = (ms: number) => {
    const h = Math.floor(ms / 3_600_000); const mi = Math.floor((ms % 3_600_000) / 60_000); const s = Math.floor((ms % 60_000) / 1000); const r = Math.round(ms % 1000);
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
  };
  return edl.captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.lines.join('\n')}\n`).join('\n');
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const edl = JSON.parse(readFileSync(arg('--edl') ?? 'video/out/edl.json', 'utf8')) as Edl;
  const out = arg('--out') ?? 'video/out/interpres-demo.mp4';
  const r = await render(edl, out);
  writeFileSync(out.replace(/\.mp4$/, '.srt'), srt(edl));
  console.log(JSON.stringify({ out, frames: r.frames, mix: r.mix }, null, 1));
}
