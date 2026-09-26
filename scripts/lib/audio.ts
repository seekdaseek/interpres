/**
 * Real speech for the audio proof: synthesise with macOS `say`, convert to the
 * Voice Agent API's input format with `afconvert`, and stream it at real-time
 * pace the way a microphone would.
 *
 * Target format, from the docs' Audio format page: `audio/pcm`, 24,000 Hz,
 * 16-bit signed integer, little-endian, mono, base64 inside `input.audio`.
 *
 * afconvert flags were read off `afconvert -h` on this machine:
 *   -f WAVE           file format
 *   -d LEI16@24000    little-endian signed 16-bit PCM at 24 kHz
 *   -c 1              one channel
 *   --no-filler       "don't page-align audio data in the output file"
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const SAMPLE_RATE = 24_000;
export const BYTES_PER_SAMPLE = 2;
/** 40 ms per chunk: inside the 20-50 ms window, 1,920 bytes each. */
export const CHUNK_MS = 40;
export const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000;

export type WavPcm = { pcm: Buffer; sampleRate: number; channels: number; bitsPerSample: number; format: number };

/**
 * Pull the PCM out of a WAV by walking its RIFF chunks. A fixed 44-byte header
 * is an assumption afconvert does not promise - without `--no-filler` it adds
 * a page-alignment chunk before `data` - so the chunks are read, not skipped.
 */
export function parseWav(buf: Buffer): WavPcm {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt: Omit<WavPcm, 'pcm'> | undefined;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      return { ...fmt, pcm: buf.subarray(body, body + size) };
    }
    offset = body + size + (size % 2);   // chunks are word-aligned
  }
  throw new Error('no data chunk');
}

/** Refuse anything that is not exactly what the API expects. */
export function assertApiFormat(w: WavPcm): void {
  const problems: string[] = [];
  if (w.format !== 1) problems.push(`format ${w.format}, want 1 (PCM)`);
  if (w.channels !== 1) problems.push(`${w.channels} channels, want 1`);
  if (w.sampleRate !== SAMPLE_RATE) problems.push(`${w.sampleRate} Hz, want ${SAMPLE_RATE}`);
  if (w.bitsPerSample !== 16) problems.push(`${w.bitsPerSample}-bit, want 16`);
  if (problems.length > 0) throw new Error(`audio is not API-ready: ${problems.join('; ')}`);
}

export type Synth = { pcm: Buffer; durationMs: number; afinfo: string };

/** Speak `text` into 24 kHz mono PCM16 LE. Also returns afinfo's verdict. */
export async function synthesize(text: string, opts: { voice?: string; rate?: number } = {}): Promise<Synth> {
  const dir = await mkdtemp(join(tmpdir(), 'interpres-say-'));
  try {
    const aiff = join(dir, 'q.aiff');
    const wav = join(dir, 'q.wav');
    const sayArgs = ['-o', aiff];
    if (opts.voice) sayArgs.push('-v', opts.voice);
    if (opts.rate) sayArgs.push('-r', String(opts.rate));
    sayArgs.push(text);
    await run('say', sayArgs);
    await run('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SAMPLE_RATE}`, '-c', '1', '--no-filler', aiff, wav]);
    const { stdout } = await run('afinfo', [wav]);
    const wavPcm = parseWav(await readFile(wav));
    assertApiFormat(wavPcm);
    return {
      pcm: Buffer.from(wavPcm.pcm),
      durationMs: Math.round((wavPcm.pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000),
      afinfo: stdout.split('\n').filter((l) => /Data format|estimated duration/.test(l)).map((l) => l.trim()).join(' | '),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function silence(ms: number): Buffer {
  const bytes = Math.round((SAMPLE_RATE * BYTES_PER_SAMPLE * ms) / 1000);
  return Buffer.alloc(bytes - (bytes % BYTES_PER_SAMPLE));
}

/**
 * A continuous, real-time microphone stand-in.
 *
 * Once started it sends one 40 ms chunk every 40 ms for the life of the session,
 * silence when nothing is queued - which is what a live mic does, and what keeps
 * the test honest about idle audio during the agent's own speech.
 *
 * Pacing is anchored to a start time rather than chained, so small timer delays
 * do not accumulate. If the loop falls more than a chunk behind (a GC pause, a
 * busy event loop), it re-anchors instead of catching up: catching up means a
 * burst faster than real time, and the API rejects that as
 * `audio_rate_violation`.
 */
export class AudioPump {
  private readonly send: (base64: string) => void;
  private queue: Array<{ buf: Buffer; done?: () => void }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private anchor = 0;
  private n = 0;
  chunksSent = 0;
  reanchors = 0;
  running = false;

  constructor(send: (base64: string) => void) {
    this.send = send;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.anchor = performance.now();
    this.n = 0;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    for (const q of this.queue) q.done?.();
    this.queue = [];
  }

  /** Queue audio; resolves when its last byte has been sent. */
  enqueue(pcm: Buffer): Promise<void> {
    return new Promise((resolve) => this.queue.push({ buf: pcm, done: resolve }));
  }

  private nextChunk(): Buffer {
    const out = Buffer.alloc(CHUNK_BYTES);
    let filled = 0;
    while (filled < CHUNK_BYTES && this.queue.length > 0) {
      const head = this.queue[0]!;
      const take = Math.min(CHUNK_BYTES - filled, head.buf.length);
      head.buf.copy(out, filled, 0, take);
      filled += take;
      head.buf = head.buf.subarray(take);
      if (head.buf.length === 0) {
        this.queue.shift();
        // Resolve after this chunk is actually sent, not merely taken.
        const done = head.done;
        if (done) queueMicrotask(done);
      }
    }
    return out;   // any unfilled tail is already zeros: silence
  }

  private tick = (): void => {
    if (!this.running) return;
    this.send(this.nextChunk().toString('base64'));
    this.chunksSent++;
    this.n++;
    const now = performance.now();
    let due = this.anchor + this.n * CHUNK_MS;
    if (now - due > CHUNK_MS) {
      this.anchor = now - (this.n - 1) * CHUNK_MS;
      due = this.anchor + this.n * CHUNK_MS;
      this.reanchors++;
    }
    this.timer = setTimeout(this.tick, Math.max(0, due - now));
  };
}
