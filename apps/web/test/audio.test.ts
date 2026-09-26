import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CAPTURE_SOURCE, PLAYBACK_SOURCE, FRAME_SAMPLES, WIRE_RATE, toBase64, fromBase64 } from '../src/audio.ts';

/**
 * Run the real worklet source in a sandbox that stands in for AudioWorkletGlobalScope,
 * so these tests exercise the exact code the browser loads.
 */
function loadProcessor(source: string, name: string, sampleRate: number) {
  const registry = new Map<string, new () => any>();
  const posted: unknown[] = [];
  class FakePort {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    postMessage(data: unknown) { posted.push(data); }
  }
  class AudioWorkletProcessor { port = new FakePort(); }
  const sandbox = {
    sampleRate,
    AudioWorkletProcessor,
    registerProcessor: (n: string, cls: new () => any) => registry.set(n, cls),
    Int16Array, Float32Array, Math,
  };
  vm.runInNewContext(source, sandbox);
  const Cls = registry.get(name);
  assert.ok(Cls, `${name} must register`);
  const proc = new Cls!();
  return { proc, posted };
}

/** Push `seconds` of a sine through the capture worklet in 128-sample blocks. */
function capture(rate: number, seconds: number, freq = 440) {
  const { proc, posted } = loadProcessor(CAPTURE_SOURCE, 'interpres-mic', rate);
  const total = Math.round(rate * seconds);
  for (let start = 0; start < total; start += 128) {
    const block = new Float32Array(Math.min(128, total - start));
    for (let k = 0; k < block.length; k++) block[k] = 0.5 * Math.sin((2 * Math.PI * freq * (start + k)) / rate);
    proc.process([[block]]);
  }
  const frames = posted.map((b) => new Int16Array(b as ArrayBuffer));
  const samples = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) { samples.set(f, o); o += f.length; }
  return { frames, samples };
}

function zeroCrossings(x: ArrayLike<number>): number {
  let c = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) c++;
  return c;
}

test('capture posts fixed 40 ms frames of 960 samples', () => {
  const { frames } = capture(24_000, 1);
  assert.equal(FRAME_SAMPLES, 960);
  assert.ok(frames.length >= 24, `expected ~25 frames in 1 s, got ${frames.length}`);
  for (const f of frames) assert.equal(f.length, 960);
});

for (const rate of [24_000, 44_100, 48_000, 16_000]) {
  test(`capture at ${rate} Hz produces 24 kHz output at the right rate and pitch`, () => {
    const seconds = 2;
    const { samples } = capture(rate, seconds);
    const expected = WIRE_RATE * seconds;
    // Whole frames only are posted, so up to one frame can still be pending.
    assert.ok(Math.abs(samples.length - expected) <= FRAME_SAMPLES + 2, `${samples.length} samples for ${expected} expected`);
    // A 440 Hz tone crosses zero 880 times a second. If the resampler got the
    // ratio wrong, the pitch - and so this count - would move.
    const perSecond = zeroCrossings(samples) / (samples.length / WIRE_RATE);
    assert.ok(Math.abs(perSecond - 880) < 10, `pitch drifted: ${perSecond.toFixed(1)} crossings/s, want 880`);
    // Amplitude survives: a 0.5 sine peaks near 16384.
    const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(peak > 15_000 && peak < 17_500, `peak ${peak}`);
  });
}

test('capture clamps instead of wrapping around on overdriven input', () => {
  const { proc, posted } = loadProcessor(CAPTURE_SOURCE, 'interpres-mic', 24_000);
  const loud = new Float32Array(128).fill(3);
  for (let i = 0; i < 10; i++) proc.process([[loud]]);
  const s = new Int16Array(posted[0] as ArrayBuffer);
  assert.ok(s.slice(1).every((v) => v === 32767), 'overdrive must clip to full scale, not wrap negative');
});

test('capture ignores an empty or missing input block', () => {
  const { proc, posted } = loadProcessor(CAPTURE_SOURCE, 'interpres-mic', 48_000);
  assert.equal(proc.process([[]]), true);
  assert.equal(proc.process([]), true);
  assert.equal(posted.length, 0);
});

// ---------------------------------------------------------------- playback

function pcmTone(seconds: number, freq = 440): ArrayBuffer {
  const n = WIRE_RATE * seconds;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(16000 * Math.sin((2 * Math.PI * freq * i) / WIRE_RATE));
  return out.buffer;
}

function drain(proc: any, blocks: number, channels = 2): Float32Array {
  const out: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const chans = Array.from({ length: channels }, () => new Float32Array(128));
    proc.process([], [chans]);
    out.push(...chans[0]!);
  }
  return Float32Array.from(out);
}

for (const rate of [24_000, 48_000, 44_100]) {
  test(`playback at ${rate} Hz keeps the agent's pitch`, () => {
    const { proc } = loadProcessor(PLAYBACK_SOURCE, 'interpres-speaker', rate);
    proc.port.onmessage!({ data: pcmTone(1) });
    const blocks = Math.floor((rate * 0.9) / 128);
    const out = drain(proc, blocks);
    const perSecond = zeroCrossings(out) / (out.length / rate);
    assert.ok(Math.abs(perSecond - 880) < 10, `pitch drifted: ${perSecond.toFixed(1)}/s`);
    assert.ok(out.every((v) => Number.isFinite(v)), 'no NaN may reach the speaker');
  });
}

test('flush empties the buffer at once: barge-in stops the agent mid-word', () => {
  const { proc } = loadProcessor(PLAYBACK_SOURCE, 'interpres-speaker', 48_000);
  proc.port.onmessage!({ data: pcmTone(2) });
  drain(proc, 10);
  proc.port.onmessage!({ data: 'flush' });
  const after = drain(proc, 20);
  assert.ok(after.every((v) => v === 0), 'nothing may play after a flush');
});

test('an empty chunk cannot poison the stream', () => {
  const { proc } = loadProcessor(PLAYBACK_SOURCE, 'interpres-speaker', 48_000);
  proc.port.onmessage!({ data: new Int16Array(0).buffer });
  proc.port.onmessage!({ data: pcmTone(0.5) });
  const out = drain(proc, 100);
  assert.ok(out.every((v) => Number.isFinite(v)));
  assert.ok(out.some((v) => v !== 0), 'the real audio after it must still play');
});

test('mono is copied to every output channel', () => {
  const { proc } = loadProcessor(PLAYBACK_SOURCE, 'interpres-speaker', 24_000);
  proc.port.onmessage!({ data: pcmTone(0.1) });
  const chans = [new Float32Array(128), new Float32Array(128)];
  proc.process([], [chans]);
  assert.deepEqual(Array.from(chans[1]!), Array.from(chans[0]!));
});

test('playback reports when it starts and when it goes quiet', () => {
  const { proc, posted } = loadProcessor(PLAYBACK_SOURCE, 'interpres-speaker', 24_000);
  proc.port.onmessage!({ data: pcmTone(0.02) });
  drain(proc, 10);
  assert.deepEqual(posted, ['playing', 'idle']);
});

test('a full buffer drops new audio rather than overwriting what is playing', () => {
  const { proc } = loadProcessor(PLAYBACK_SOURCE, 'interpres-speaker', 24_000);
  for (let i = 0; i < 40; i++) proc.port.onmessage!({ data: pcmTone(1) });   // 40 s into a 30 s ring
  assert.equal(proc.count, proc.ring.length);
});

test('base64 round-trips PCM exactly', () => {
  const pcm = new Int16Array([0, 1, -1, 32767, -32768, 12345, -12345]);
  const back = new Int16Array(fromBase64(toBase64(pcm.buffer)));
  assert.deepEqual(Array.from(back), Array.from(pcm));
});
