/**
 * A raw capture (scripts/video/capture.ts) onto one clock, and its checks.
 *
 * - t0 is the first screencast frame. Every event, frame and audio sample is
 *   placed relative to it, in ms.
 * - Each audio context's frames map to the epoch clock through a least-squares
 *   line fitted to its getOutputTimestamp samples (taken every 250 ms), so the
 *   stems land where they were heard. The caller stem is 48 kHz; the agent
 *   stem is recorded in the page's own 24 kHz context and upsampled to 48 kHz
 *   with ffmpeg's swr (this ffmpeg has no libsoxr). Both are 32-bit float WAV.
 * - Sync: the first white screencast frame of each flash against the beep's
 *   onset in the caller stem. The capture fails the check if they differ by
 *   more than one output frame (33 ms).
 * - Scene checks from brief F, F2.4, and each exchange's voice-to-voice: the
 *   caller's last audible sample to the agent's first, both from the stems.
 *
 *   node scripts/video/assemble.ts video/captures/<scene>-<stamp>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PROPER_NOUN_VARIANTS, callerLines } from './config.ts';
import { matchWords } from './stt.ts';
import { SAMPLE_ADDRESS } from './capture.ts';

export type Ev = { t: number; type: string; [k: string]: unknown };
export const RATE = 48_000;
const FRAME_MS = 1000 / 30;

/** 32-bit float mono WAV. */
export function wavF32(samples: Float32Array, rate: number): Buffer {
  const h = Buffer.alloc(44);
  const bytes = samples.length * 4;
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, bytes)]);
}

export function readF32Wav(path: string): { rate: number; data: Float32Array } {
  const b = readFileSync(path);
  let off = 12;
  let rate = 0;
  let fmt = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { fmt = b.readUInt16LE(off + 8); rate = b.readUInt32LE(off + 12); }
    if (id === 'data') {
      if (fmt !== 3) throw new Error(`${path}: not float WAV`);
      const copy = Buffer.from(b.subarray(off + 8, off + 8 + size));
      return { rate, data: new Float32Array(copy.buffer, copy.byteOffset, size / 4) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data`);
}

type Fit = { a: number; b: number; n: number; residualMs: number };

/** epoch ms = a + b * contextTime(s) * 1000, least squares over the clock samples. */
function fitClock(samples: Array<{ contextTime: number; epoch: number }>): Fit {
  const n = samples.length;
  if (n < 2) throw new Error('fewer than two clock samples');
  const xs = samples.map((s) => s.contextTime * 1000);
  const ys = samples.map((s) => s.epoch);
  const mx = xs.reduce((p, x) => p + x, 0) / n;
  const my = ys.reduce((p, y) => p + y, 0) / n;
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i]! - mx) ** 2; sxy += (xs[i]! - mx) * (ys[i]! - my); }
  const b = sxx > 0 ? sxy / sxx : 1;
  const a = my - b * mx;
  const residualMs = Math.max(...xs.map((x, i) => Math.abs(a + b * x - ys[i]!)));
  return { a, b, n, residualMs };
}

type RawChunk = { stem: string; ctx: number; frame: number; rate: number; file: string; offset: number; n: number };

/** One stem on the capture timeline at its recording rate, sample 0 at t0. */
function placeStem(dir: string, stem: string, chunks: RawChunk[], fits: Map<number, Fit>, t0: number, lengthMs: number): { rate: number; data: Float32Array } | null {
  const mine = chunks.filter((c) => c.stem === stem).sort((x, y) => (x.ctx - y.ctx) || (x.frame - y.frame));
  if (mine.length === 0) return null;
  const rate = mine[0]!.rate;
  const out = new Float32Array(Math.ceil((lengthMs / 1000) * rate) + rate);
  const files = new Map<string, Buffer>();
  let prevEnd = -1;
  let prevCtx = -1;
  for (const c of mine) {
    const fit = fits.get(c.ctx);
    if (!fit) throw new Error(`${stem} ctx ${c.ctx}: no clock samples`);
    if (!files.has(c.file)) files.set(c.file, readFileSync(`${dir}/${c.file}`));
    const buf = files.get(c.file)!;
    const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset + c.offset, buf.byteOffset + c.offset + c.n * 4));
    let at = Math.round(((fit.a + fit.b * (c.frame / c.rate) * 1000) - t0) * rate / 1000);
    // Consecutive chunks of one context are contiguous; keep them so, whatever the rounding says.
    if (c.ctx === prevCtx && Math.abs(at - prevEnd) <= 2) at = prevEnd;
    for (let i = 0; i < f32.length; i++) { const k = at + i; if (k >= 0 && k < out.length) out[k] = f32[i]!; }
    prevEnd = at + f32.length;
    prevCtx = c.ctx;
  }
  return { rate, data: out };
}

/** First index at or after `from` whose magnitude passes `thr`. */
function onset(d: Float32Array, from: number, to: number, thr: number): number | null {
  for (let i = Math.max(0, from); i < Math.min(d.length, to); i++) if (Math.abs(d[i]!) > thr) return i;
  return null;
}

/** Last index before `to` whose magnitude passes `thr`. */
function offsetEnd(d: Float32Array, from: number, to: number, thr: number): number | null {
  for (let i = Math.min(d.length, to) - 1; i >= Math.max(0, from); i--) if (Math.abs(d[i]!) > thr) return i;
  return null;
}

async function brightness(file: string): Promise<number> {
  const img = await loadImage(readFileSync(file));
  const cv = createCanvas(48, 26);
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0, 48, 26);
  const px = g.getImageData(0, 0, 48, 26).data;
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
  return s / (px.length / 4);
}

/** A JPEG's pixel size, from its SOF marker. */
function jpegSize(path: string): string {
  const b = readFileSync(path);
  for (let i = 2; i < b.length - 9; i++) {
    if (b[i] === 0xff && (b[i + 1] === 0xc0 || b[i + 1] === 0xc2)) return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)} px`;
  }
  return 'unknown';
}

/** A caller clip as made (24 kHz PCM16), as floats. */
function clipPcm(id: string): Float32Array {
  const m = JSON.parse(readFileSync('data/video/voices.json', 'utf8')) as { lines: Record<string, { file: string }> };
  const b = readFileSync(m.lines[id]!.file);
  const pcm = b.subarray(44);
  const out = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(2 * i) / 32768;
  return out;
}

/** Where a clip sits in a recording (best correlation in a window), and how exactly it arrived. */
export function matchClip(rec: Float32Array, clip: Float32Array, from: number, to: number): { lag: number; snrDb: number; maxErr: number; bitExact: boolean } {
  let best = -Infinity; let lag = Math.max(0, from);
  for (let l = Math.max(0, from); l < Math.min(to, rec.length - clip.length); l++) {
    let acc = 0;
    for (let i = 0; i < clip.length; i += 11) acc += rec[l + i]! * clip[i]!;
    if (acc > best) { best = acc; lag = l; }
  }
  let sig = 0; let err = 0; let maxErr = 0;
  for (let i = 0; i < clip.length; i++) { const d = (rec[lag + i] ?? 0) - clip[i]!; sig += clip[i]! * clip[i]!; err += d * d; maxErr = Math.max(maxErr, Math.abs(d)); }
  const snrDb = err === 0 ? Infinity : 10 * Math.log10(sig / err);
  return { lag, snrDb: Number.isFinite(snrDb) ? Math.round(snrDb * 10) / 10 : 999, maxErr, bitExact: maxErr === 0 };
}

export async function assemble(dir: string): Promise<Record<string, unknown>> {
  const events = (JSON.parse(readFileSync(`${dir}/events.json`, 'utf8')) as Ev[]).sort((x, y) => x.t - y.t);
  const chunks = JSON.parse(readFileSync(`${dir}/raw/index.json`, 'utf8')) as RawChunk[];
  const frames = events.filter((e) => e.type === 'frame').map((e) => ({ i: Number(e.i), t: e.t, file: String(e.file), scrollY: e.scrollY }));
  if (frames.length === 0) throw new Error('no frames');
  const t0 = frames[0]!.t;
  const tEnd = Math.max(frames.at(-1)!.t, ...events.map((e) => e.t));
  const lengthMs = tEnd - t0;

  // Clock fits, one per audio context.
  const fits = new Map<number, Fit>();
  const byCtx = new Map<number, Array<{ contextTime: number; epoch: number }>>();
  for (const e of events.filter((x) => x.type === 'clock')) {
    const k = Number(e.ctx);
    if (!byCtx.has(k)) byCtx.set(k, []);
    byCtx.get(k)!.push({ contextTime: Number(e.contextTime), epoch: Number(e.timeOrigin) + Number(e.performanceTime) });
  }
  for (const [k, s] of byCtx) fits.set(k, fitClock(s));

  mkdirSync(`${dir}/stems`, { recursive: true });
  /** A stem at its recorded rate, and at 48 kHz (swr upsampling when it was recorded lower). */
  const stem = (name: string) => {
    const native = placeStem(dir, name, chunks, fits, t0, lengthMs);
    if (!native) return null;
    writeFileSync(`${dir}/stems/${name}-${native.rate}.wav`, wavF32(native.data, native.rate));
    if (native.rate === RATE) { writeFileSync(`${dir}/stems/${name}.wav`, wavF32(native.data, RATE)); return { native, data: native.data }; }
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${dir}/stems/${name}-${native.rate}.wav`, '-af', `aresample=${RATE}:filter_size=128:phase_shift=12:cutoff=0.97`, '-c:a', 'pcm_f32le', `${dir}/stems/${name}.wav`]);
    return { native, data: readF32Wav(`${dir}/stems/${name}.wav`).data };
  };
  const callerS = stem('caller');
  if (!callerS) throw new Error('no caller stem');
  const caller = { rate: RATE, data: callerS.data };
  const agentS = stem('agent');
  const agent24 = agentS?.native ?? null;
  let agent: Float32Array = agentS?.data ?? new Float32Array(caller.data.length);
  if (!agentS) writeFileSync(`${dir}/stems/agent.wav`, wavF32(agent, RATE));
  const pagemic = placeStem(dir, 'pagemic', chunks, fits, t0, lengthMs);
  const at = (t: number) => Math.round(((t - t0) * RATE) / 1000);
  const ms = (i: number) => (i * 1000) / RATE;

  // Sync: flash frame against beep onset.
  const sync: Array<{ label: string; flashMs: number | null; beepMs: number | null; offsetMs: number | null; ok: boolean }> = [];
  for (const b of events.filter((e) => e.type === 'sync.beep')) {
    const label = String(b.label);
    const fit = fits.get(0)!;
    const expect = fit.a + fit.b * Number(b.contextTime) * 1000;
    const i = onset(caller.data, at(expect) - RATE * 0.4, at(expect) + RATE * 0.6, 0.05);
    const on = events.find((e) => e.type === 'sync.flash.on' && e.label === label);
    let flash: number | null = null;
    if (on) {
      for (const f of frames.filter((x) => x.t >= on.t - 300 && x.t <= on.t + 600)) {
        if ((await brightness(`${dir}/${f.file}`)) > 200) { flash = f.t; break; }
      }
    }
    const beepMs = i === null ? null : t0 + ms(i);
    const off = beepMs !== null && flash !== null ? beepMs - flash : null;
    sync.push({ label, flashMs: flash === null ? null : flash - t0, beepMs: beepMs === null ? null : beepMs - t0, offsetMs: off === null ? null : Math.round(off * 10) / 10, ok: off !== null && Math.abs(off) <= FRAME_MS });
  }

  // Exchanges: each caller clip, the voice-to-voice after it.
  const clipStarts = events.filter((e) => e.type === 'clip.start');
  const exchanges = clipStarts.map((c) => {
    const fit = fits.get(0)!;
    const startT = fit.a + fit.b * Number(c.contextTime) * 1000;
    const endT = startT + Number(c.seconds) * 1000;
    const s = onset(caller.data, at(startT) - 2400, at(endT), 0.01);
    const e = offsetEnd(caller.data, at(startT), at(endT) + 4800, 0.01);
    const lastWord = e === null ? endT : t0 + ms(e);
    const firstAgent = onset(agent, at(lastWord), agent.length, 0.01);
    const heardEv = events.find((x) => x.type === 'ws.in' && x.msg === 'transcript.user' && x.t >= startT);
    return {
      id: String(c.id),
      callerStartMs: s === null ? null : ms(s),
      callerEndMs: lastWord - t0,
      agentStartMs: firstAgent === null ? null : ms(firstAgent),
      voiceToVoiceMs: firstAgent === null ? null : Math.round(t0 + ms(firstAgent) - lastWord),
      heard: heardEv ? String(heardEv.text) : null,
    };
  });

  // What the page's own mic path received, against each clip as made.
  const fidelity = pagemic ? clipStarts.map((c) => {
    const fit = fits.get(0)!;
    const startT = fit.a + fit.b * Number(c.contextTime) * 1000;
    const clip = clipPcm(String(c.id));
    const r = pagemic.rate;
    const expect = Math.round(((startT - t0) / 1000) * r);
    return { id: String(c.id), ...matchClip(pagemic.data, clip, expect - Math.round(r * 0.3), expect + Math.round(r * 0.5)) };
  }) : [];

  const rel = (e: Ev) => Math.round(e.t - t0);
  const log = events.filter((e) => e.type !== 'frame' && e.type !== 'clock').map((e) => ({ ...e, t: rel(e) }));
  const sessionId = String(events.find((e) => e.type === 'ws.in' && e.msg === 'session.ready')?.session_id ?? '');
  const summary: Record<string, unknown> = {
    capture: basename(dir),
    scene: String(events.find((e) => e.type === 'capture.start')?.scene ?? ''),
    sessionId,
    t0,
    lengthMs: Math.round(lengthMs),
    frames: frames.length,
    frameSize: jpegSize(`${dir}/${frames[0]!.file}`),
    clockFits: Object.fromEntries([...fits].map(([k, f]) => [k, { samples: f.n, driftPpm: Math.round((f.b - 1) * 1e6), maxResidualMs: Math.round(f.residualMs * 100) / 100 }])),
    stems: {
      caller: `recorded at ${callerS.native.rate} Hz in the harness context${callerS.native.rate === RATE ? '' : `, upsampled to ${RATE} Hz`}, ${(caller.data.length / RATE).toFixed(1)} s`,
      agent: agent24 ? `recorded at ${agent24.rate} Hz in the page's context, upsampled to ${RATE} Hz` : 'none (no session)',
      pagemic: pagemic ? `the page's mic input, recorded at ${pagemic.rate} Hz, evidence only` : 'not recorded',
    },
    pageMicFidelity: fidelity,
    sync,
    exchanges,
    consoleErrors: events.filter((e) => e.type === 'console.error' || e.type === 'page.error' || e.type === 'page.rejection').map((e) => String(e.text ?? e.message)),
  };
  summary.checks = sceneChecks(String(summary.scene), events, exchanges, sync, summary.consoleErrors as string[]);
  summary.spokenAddresses = spokenAddresses(events, sessionId);
  writeFileSync(`${dir}/frames.json`, JSON.stringify(frames.map((f) => ({ ...f, t: Math.round((f.t - t0) * 10) / 10 }))));
  writeFileSync(`${dir}/capture.json`, JSON.stringify({ ...summary, log }, null, 1));
  return summary;
}

type Check = { check: string; ok: boolean; detail: string };

function sceneChecks(scene: string, events: Ev[], exchanges: Array<{ id: string; heard: string | null }>, sync: Array<{ ok: boolean }>, errors: string[]): Check[] {
  const out: Check[] = [];
  const add = (check: string, ok: boolean, detail: string) => out.push({ check, ok, detail });
  const lines = callerLines();
  const calls = events.filter((e) => e.type === 'ws.in' && e.msg === 'tool.call');
  const mcp = events.filter((e) => e.type === 'fetch.start' && e.path === '/api/mcp/call');
  const mcpDone = events.filter((e) => e.type === 'fetch.done' && e.path === '/api/mcp/call');
  const saidAt = (id: string) => events.find((e) => e.type === 'say' && e.id === id)?.t ?? Infinity;
  const nextSay = (id: string) => Math.min(...events.filter((e) => e.type === 'say' && e.t > saidAt(id)).map((e) => e.t), Infinity);
  const heard = (id: string) => {
    const x = exchanges.find((e) => e.id === id);
    const m = matchWords(lines[id]!, x?.heard ?? '', PROPER_NOUN_VARIANTS);
    add(`${id} heard as said`, m.ok, `heard "${x?.heard ?? '(nothing)'}"`);
  };
  const answered = (id: string) => {
    const t = saidAt(id);
    const a = events.filter((e) => e.type === 'ws.in' && e.msg === 'transcript.agent' && e.t > t && e.t < nextSay(id) && String(e.text).trim() !== '');
    add(`${id}: the agent answers`, a.length > 0, a.map((e) => String(e.text)).join(' ').slice(0, 160));
    return a;
  };
  const inTurn = (id: string) => calls.filter((c) => c.t > saidAt(id) && c.t < nextSay(id));
  if (scene === 'A') {
    const hint = [...events].reverse().find((e) => e.type === 'dom.hint' && /Found in the official MCP registry/.test(String((e.v as { text: string }).text)));
    add('discovery connects to https://mcp.goji.agency/mcp', !!hint && String((hint.v as { text: string }).text).includes('https://mcp.goji.agency/mcp'), hint ? String((hint.v as { text: string }).text) : 'no hint');
    heard('Q1');
    const g = inTurn('Q1').filter((c) => c.name === 'goji_explain_term');
    const ok = mcpDone.filter((d) => d.t > saidAt('Q1') && d.status === 200);
    add('goji_explain_term called once and succeeds', g.length === 1 && ok.length >= 1, `${g.length} call(s) ${JSON.stringify(g.map((c) => c.arguments))}; /api/mcp/call ${mcpDone.map((d) => d.status).join(',')}`);
    answered('Q1');
  }
  if (scene === 'B') {
    const click = events.find((e) => e.type === 'fetch.start' && e.path === '/api/mcp/connect');
    const ui = [...events].reverse().find((e) => e.type === 'dom.ui' && click && e.t <= click.t);
    const first = (ui?.v as { results?: Array<{ text: string }> } | undefined)?.results?.[0]?.text ?? '';
    add('the first result is Most Recommended Books', /Most Recommended Books/i.test(first), first);
    const server = [...events].reverse().find((e) => e.type === 'dom.ui' && /recommended/i.test(String((e.v as { server: string }).server)));
    add('it connects', !!server, server ? String((server.v as { server: string }).server) : 'no server name');
    heard('Q2');
    const g = inTurn('Q2').filter((c) => c.name === 'get_book_recommenders');
    const ok = mcpDone.filter((d) => d.t > saidAt('Q2') && d.status === 200);
    add('get_book_recommenders succeeds', g.length >= 1 && ok.length >= 1, `${g.length} call(s); /api/mcp/call ${mcpDone.map((d) => d.status).join(',')}`);
    answered('Q2');
  }
  if (scene === 'C') {
    heard('Q3');
    const ft = inTurn('Q3').filter((c) => c.name === 'find_tools');
    const chips = [...events].reverse().find((e) => e.type === 'dom.chips' && e.t > saidAt('Q3') && e.t < nextSay('Q3'));
    const isNew = ((chips?.v as { chips?: Array<{ name: string; isNew: boolean }> } | undefined)?.chips ?? []).some((c) => c.name === 'afg_speccheck' && c.isNew);
    add('C1: find_tools is called', ft.length >= 1, JSON.stringify(ft.map((c) => c.arguments)));
    add('C1: the swap card lists afg_speccheck as new', isNew, JSON.stringify((chips?.v as { chips?: unknown[] } | undefined)?.chips ?? []));
    answered('Q3');
    heard('Q4');
    const rep = inTurn('Q4').filter((c) => c.name === 'afg_get_reputation');
    const repMcp = mcp.filter((f) => f.t > saidAt('Q4') && f.t < nextSay('Q4') && (f.body as { tool?: string } | undefined)?.tool === 'afg_get_reputation');
    const exact = rep.length === 1 && JSON.stringify(rep[0]!.arguments) === JSON.stringify({ address: SAMPLE_ADDRESS }) && repMcp.length === 1 && (repMcp[0]!.body as { arguments: { address: string } }).arguments.address === SAMPLE_ADDRESS;
    add('C2: afg_get_reputation called exactly once, with exactly the pasted value', exact, `${rep.length} call(s) ${JSON.stringify(rep.map((c) => c.arguments))}; ${repMcp.length} /api/mcp/call`);
    answered('Q4');
    const q5 = saidAt('Q5');
    const gate = events.find((e) => e.type === 'dom.gate' && e.t > q5 && (e.v as { shown: boolean; kind: string }).shown && (e.v as { kind: string }).kind === 'paste');
    add('C3: needs_paste appears', !!gate, gate ? `${String((gate.v as { kindText: string }).kindText)} | ${String((gate.v as { value: string }).value)}` : 'no paste card');
    const after = mcp.filter((f) => f.t > q5);
    add('C3: zero /api/mcp/call from Q5 to the end of the session', after.length === 0, `${after.length} request(s)`);
    const a = answered('Q5');
    add('C3: the agent asks for a paste', a.some((e) => /paste/i.test(String(e.text))), '');
  }
  add('no console errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  add('sync within one frame', sync.length > 0 && sync.every((s) => s.ok), '');
  return out;
}

/** Scene C's spoken-address take, in the shape scripts/spoken-identifiers.ts reads. */
function spokenAddresses(events: Ev[], sessionId: string): unknown[] {
  const q5 = events.find((e) => e.type === 'say' && e.id === 'Q5');
  if (!q5) return [];
  const heardEv = events.find((e) => e.type === 'ws.in' && e.msg === 'transcript.user' && e.t > q5.t);
  const mcpCalls = events.filter((e) => e.type === 'fetch.start' && e.path === '/api/mcp/call' && e.t > q5.t).map((e) => ({ arguments: (e.body as { arguments?: unknown } | undefined)?.arguments }));
  return [{ sessionId, said: callerLines().Q5, heard: heardEv ? String(heardEv.text) : '', mcpCalls }];
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dir = process.argv[2];
  if (!dir || !existsSync(`${dir}/events.json`)) { console.error('usage: node scripts/video/assemble.ts video/captures/<dir>'); process.exit(2); }
  const s = await assemble(dir);
  const { log: _log, ...rest } = { ...s, log: undefined };
  console.log(JSON.stringify({ ...rest, exchanges: s.exchanges, checks: s.checks }, null, 1));
}
