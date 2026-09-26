/**
 * "Watch a real session": one recorded e2e-audio session, played back.
 *
 * The audio is Session History's own recording of that session. The caller is
 * a macOS `say` voice (synthetic, labelled as such), never a person. Each line
 * and tool call appears at its real time, placed on the recording's clock by
 * scripts/replay-build.ts. It is also what the page shows when /api/token
 * refuses, so the demo never goes dark while someone is looking.
 */
import REPLAY from './replay/replay.json' with { type: 'json' };

export type ReplayEvent =
  | { at: number; kind: 'user'; end: number; text: string }
  | { at: number; kind: 'agent'; end: number; text: string }
  | { at: number; kind: 'call'; id: string; name: string; args: Record<string, unknown> }
  | { at: number; kind: 'result'; id: string; name: string; ms: number; ok: boolean; spoken: string; method: string };

export type ReplayData = {
  sessionId: string;
  recordedAt: string;
  durationSeconds: number;
  server: { label: string; url: string };
  tools: string[];
  voice: string;
  audio: string;
  events: ReplayEvent[];
};

export const replay = REPLAY as unknown as ReplayData;

const audioUrls = import.meta.glob('./replay/*.m4a', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
export const replayAudioUrl = audioUrls[`./replay/${replay.audio}`] ?? '';

/** What the player draws with: the live page's own panes. */
export type ReplayUi = {
  reset(): void;
  line(who: 'you' | 'agent'): HTMLElement;
  toolStart(id: string, name: string, args: Record<string, unknown>): void;
  toolDone(id: string, name: string, spoken: string, method: string, ms: number, ok: boolean): void;
};

export class ReplayPlayer {
  private readonly audio: HTMLAudioElement;
  private readonly ui: ReplayUi;
  /** Event index -> its line element (null for tool events), once it has appeared. */
  private readonly shown = new Map<number, HTMLElement | null>();
  private last = 0;
  private raf = 0;

  constructor(audio: HTMLAudioElement, ui: ReplayUi) {
    this.audio = audio;
    this.ui = ui;
    if (audio.getAttribute('src') !== replayAudioUrl) audio.src = replayAudioUrl;
    const frame = () => {
      this.render(audio.currentTime);
      if (!audio.paused) this.raf = requestAnimationFrame(frame);
    };
    audio.onplay = () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(frame); };
    audio.onseeked = () => this.render(audio.currentTime);
    audio.ontimeupdate = () => this.render(audio.currentTime);
  }

  /** Draw everything that has happened by `t` seconds into the recording. */
  render(t: number): void {
    if (t < this.last - 0.25) {
      // Seeked backwards: draw again from the start.
      this.ui.reset();
      this.shown.clear();
    }
    this.last = t;
    replay.events.forEach((e, i) => {
      if (e.at > t) return;
      if (!this.shown.has(i)) {
        if (e.kind === 'user' || e.kind === 'agent') this.shown.set(i, this.ui.line(e.kind === 'user' ? 'you' : 'agent'));
        else if (e.kind === 'call') { this.ui.toolStart(e.id, e.name, e.args); this.shown.set(i, null); }
        else { this.ui.toolDone(e.id, e.name, e.spoken, e.method, e.ms, e.ok); this.shown.set(i, null); }
      }
      const el = this.shown.get(i);
      if (el && (e.kind === 'user' || e.kind === 'agent')) {
        // Words appear across the span the voice is actually heard.
        const words = e.text.split(/\s+/);
        const frac = Math.min(1, Math.max(0, (t - e.at) / Math.max(0.1, e.end - e.at)));
        el.querySelector('.text')!.textContent = words.slice(0, Math.max(1, Math.ceil(words.length * frac))).join(' ');
        el.classList.toggle('live', frac < 1);
      }
    });
  }

  async play(): Promise<boolean> {
    try {
      await this.audio.play();
      return true;
    } catch {
      return false;   // autoplay refused: the controls are there to press
    }
  }

  stop(): void {
    this.audio.pause();
    cancelAnimationFrame(this.raf);
  }
}
