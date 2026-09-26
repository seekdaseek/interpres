/**
 * Microphone in, agent voice out, both at the Voice Agent API's wire format:
 * 24 kHz mono PCM16, little-endian, base64 inside JSON.
 *
 * Written for interpres. The approach - resample inside AudioWorklets because a
 * browser may ignore the sample rate an AudioContext asks for, and play through
 * a ring buffer that can be flushed on barge-in - is the one AssemblyAI's docs
 * and starter describe; the starter ships without a licence, so none of its code
 * is reused here.
 */

export const WIRE_RATE = 24_000;
/** 40 ms per outgoing frame: 25 socket messages a second, not one per render quantum. */
export const FRAME_SAMPLES = (WIRE_RATE * 40) / 1000;

export const CAPTURE_SOURCE = `
const WIRE = ${WIRE_RATE};
const FRAME = ${FRAME_SAMPLES};
class InterpresMic extends AudioWorkletProcessor {
  constructor() {
    super();
    // Input samples per output sample. 1 when the browser honoured 24 kHz.
    this.step = sampleRate / WIRE;
    // Position of the next output sample, in input samples, relative to the
    // start of the current block. -1 means "between the previous block's last
    // sample and this block's first".
    this.pos = 0;
    this.prev = 0;
    this.frame = new Int16Array(FRAME);
    this.fill = 0;
  }
  emit(v) {
    const s = v < -1 ? -1 : v > 1 ? 1 : v;
    this.frame[this.fill++] = s < 0 ? s * 32768 : s * 32767;
    if (this.fill === FRAME) {
      const out = this.frame;
      this.port.postMessage(out.buffer, [out.buffer]);
      this.frame = new Int16Array(FRAME);
      this.fill = 0;
    }
  }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x || x.length === 0) return true;
    const n = x.length;
    let pos = this.pos;
    while (pos < n - 1) {
      const i = Math.floor(pos);
      const f = pos - i;
      const a = i < 0 ? this.prev : x[i];
      const b = x[i + 1];
      this.emit(a + (b - a) * f);
      pos += this.step;
    }
    this.pos = pos - n;
    this.prev = x[n - 1];
    return true;
  }
}
registerProcessor('interpres-mic', InterpresMic);
`;

export const PLAYBACK_SOURCE = `
const WIRE = ${WIRE_RATE};
class InterpresSpeaker extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(sampleRate * 30);
    this.r = 0;
    this.w = 0;
    this.count = 0;
    this.step = WIRE / sampleRate;   // wire samples per output sample
    this.pos = 0;
    this.prev = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.r = this.w = this.count = 0;
        this.pos = 0;
        this.prev = 0;
        return;
      }
      const pcm = new Int16Array(e.data);
      const n = pcm.length;
      // An empty chunk would leave prev undefined and poison every later sample.
      if (n === 0) return;
      if (!this.playing && this.count === 0) { this.pos = 0; this.prev = 0; }
      let pos = this.pos;
      while (pos < n - 1) {
        const i = Math.floor(pos);
        const f = pos - i;
        const a = i < 0 ? this.prev : pcm[i] / 32768;
        const b = pcm[i + 1] / 32768;
        this.push(a + (b - a) * f);
        pos += this.step;
      }
      this.pos = pos - n;
      this.prev = pcm[n - 1] / 32768;
    };
  }
  push(v) {
    if (this.count === this.ring.length) return;   // full: drop, never overwrite
    this.ring[this.w] = v;
    this.w = (this.w + 1) % this.ring.length;
    this.count++;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    let wrote = false;
    for (let k = 0; k < ch0.length; k++) {
      if (this.count > 0) {
        ch0[k] = this.ring[this.r];
        this.r = (this.r + 1) % this.ring.length;
        this.count--;
        wrote = true;
      } else {
        ch0[k] = 0;
      }
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    if (wrote !== this.playing) {
      this.playing = wrote;
      this.port.postMessage(wrote ? 'playing' : 'idle');
    }
    return true;
  }
}
registerProcessor('interpres-speaker', InterpresSpeaker);
`;

async function loadWorklet(ctx: AudioContext, source: string, name: string): Promise<AudioWorkletNode> {
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  return new AudioWorkletNode(ctx, name);
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export type AudioIo = {
  /** Called with each 40 ms frame of microphone PCM16. */
  onFrame: (pcm: ArrayBuffer) => void;
  /** Called when playback starts or goes quiet. */
  onPlaying: (playing: boolean) => void;
};

export class AudioEngine {
  private capture?: AudioContext;
  private playback?: AudioContext;
  private mic?: MediaStream;
  private speaker?: AudioWorkletNode;
  private micNode?: AudioWorkletNode;
  /** What the browser actually gave us, for the diagnostics line. */
  captureRate = 0;
  playbackRate = 0;

  /** Must run inside a user gesture, or Safari leaves the contexts suspended. */
  async start(io: AudioIo): Promise<void> {
    this.capture = new AudioContext({ sampleRate: WIRE_RATE });
    this.playback = new AudioContext({ sampleRate: WIRE_RATE });
    await Promise.all([this.capture.resume(), this.playback.resume()]);
    this.captureRate = this.capture.sampleRate;
    this.playbackRate = this.playback.sampleRate;

    this.speaker = await loadWorklet(this.playback, PLAYBACK_SOURCE, 'interpres-speaker');
    this.speaker.port.onmessage = (e) => io.onPlaying(e.data === 'playing');
    this.speaker.connect(this.playback.destination);

    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Echo cancellation is what lets the agent talk through laptop
        // speakers without hearing itself and interrupting.
        echoCancellation: true,
        // The API runs its own noise suppression (voice_focus); doing it twice
        // only removes speech.
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.micNode = await loadWorklet(this.capture, CAPTURE_SOURCE, 'interpres-mic');
    this.micNode.port.onmessage = (e) => io.onFrame(e.data as ArrayBuffer);
    this.capture.createMediaStreamSource(this.mic).connect(this.micNode);
  }

  play(pcm: ArrayBuffer): void {
    this.speaker?.port.postMessage(pcm, [pcm]);
  }

  /** Barge-in: drop everything queued so the agent stops mid-word. */
  flush(): void {
    this.speaker?.port.postMessage('flush');
  }

  async stop(): Promise<void> {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.micNode?.disconnect();
    this.speaker?.disconnect();
    await Promise.allSettled([this.capture?.close(), this.playback?.close()]);
    this.capture = this.playback = undefined;
    this.mic = undefined;
  }
}
