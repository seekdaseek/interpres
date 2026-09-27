/**
 * F2.3: capture one live scene of the demo video from the public site, as a
 * normal visitor: Playwright Chromium (not the browser pane), 1088x585 CSS px at
 * device scale 2, every voice session opened through the page's own Talk
 * button with the page's own token.
 *
 * - Frames: CDP Page.startScreencast, JPEG quality 92, every frame
 *   acknowledged and saved with its timestamp. Constant 30 fps is rebuilt later
 *   by holding the last frame (render.ts). Playwright's recordVideo is not used.
 * - Audio: two recorders on one clock (scripts/video/instrument.js): the caller
 *   stem is what the fake mic sends, the agent stem is everything the page plays.
 * - Sync: a white frame and a 20 ms beep at the same instant, at the start and
 *   at the end of every capture (assemble.ts measures both; the edit cuts them).
 * - The harness waits for each narration line to end before the next audible
 *   action, so narration never overlaps the caller or the agent.
 *
 *   node --env-file=.env scripts/video/capture.ts --scene A|B|C [--dry]
 *
 * --dry stops before the Talk button (no session, no token): a harness test.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import { parseWav } from '../lib/audio.ts';
import { CAPTURE_URL } from './config.ts';
import { MANIFEST } from './voices.ts';

export const VIEWPORT = { width: 1088, height: 585 };
export const SCALE = 2;
export const CAPTURE_DIR = 'video/captures';
export const SAMPLE_ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

type Ev = { t: number; type: string; [k: string]: unknown };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** The passing clip of every line, and its length. */
function lines(): Record<string, { file: string; ms: number; voice: string; text: string }> {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { lines: Record<string, { file: string; voice: string; text: string; pass: boolean; attempts: Array<{ ms: number }> }> };
  return Object.fromEntries(Object.entries(m.lines).map(([id, e]) => [id, { file: e.file, ms: e.attempts.at(-1)!.ms, voice: e.voice, text: e.text }]));
}

export class Capture {
  readonly dir: string;
  readonly events: Ev[] = [];
  page!: Page;
  private ctx!: BrowserContext;
  private cdp!: CDPSession;
  private frameCount = 0;
  private mouse = { x: VIEWPORT.width * 0.62, y: VIEWPORT.height * 0.55 };
  private closed = false;
  private readonly rawIndex: Array<{ stem: string; ctx: number; frame: number; rate: number; file: string; offset: number; n: number }> = [];
  private readonly rawOffsets = new Map<string, number>();
  readonly lines = lines();

  readonly scene: string;
  readonly dry: boolean;

  constructor(scene: string, dry: boolean) {
    this.scene = scene;
    this.dry = dry;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    this.dir = `${CAPTURE_DIR}/${scene}-${stamp}${dry ? '-dry' : ''}`;
    mkdirSync(`${this.dir}/frames`, { recursive: true });
    mkdirSync(`${this.dir}/raw`, { recursive: true });
  }

  /** Harness-side marks, stamped on the page's clock so there is one clock. */
  async mark(type: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.page.evaluate(([ty, d]) => (window as unknown as { __cap: { log: (t: string, d: unknown) => void } }).__cap.log(ty as string, d), [type, data] as const);
  }

  async open(): Promise<void> {
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      // Without the forced scale the screencast sends 1088x585 frames whatever the emulated scale.
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', `--force-device-scale-factor=${SCALE}`],
    });
    this.ctx = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      locale: 'en-US',
    });
    await this.ctx.grantPermissions(['clipboard-read', 'clipboard-write', 'microphone'], { origin: new URL(CAPTURE_URL).origin });
    this.page = await this.ctx.newPage();
    const page = this.page;
    await page.exposeBinding('__capLog', (_s, e: Ev) => { this.events.push(e); });
    await page.exposeBinding('__capClock', (_s, c: Record<string, unknown>) => { this.events.push({ t: Number(c.timeOrigin) + Number(c.performanceTime), type: 'clock', ...c }); });
    await page.exposeBinding('__capAudio', (_s, stem: string, ctxId: number, frame: number, rate: number, b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      const file = `raw/${stem}-${ctxId}.f32`;
      const offset = this.rawOffsets.get(file) ?? 0;
      appendFileSync(`${this.dir}/${file}`, buf);
      this.rawOffsets.set(file, offset + buf.length);
      this.rawIndex.push({ stem, ctx: ctxId, frame, rate, file, offset, n: buf.length / 4 });
    });
    page.on('console', (m) => { if (m.type() === 'error') this.events.push({ t: Date.now(), type: 'console.error', text: m.text().slice(0, 300) }); });
    page.on('pageerror', (e) => this.events.push({ t: Date.now(), type: 'console.error', text: String(e).slice(0, 300) }));
    await page.addInitScript({ content: readFileSync('scripts/video/instrument.js', 'utf8') });

    this.cdp = await this.ctx.newCDPSession(page);
    this.cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number; offsetTop: number; pageScaleFactor: number; deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number } }) => {
      const i = this.frameCount++;
      const file = `frames/${String(i).padStart(6, '0')}.jpg`;
      writeFileSync(`${this.dir}/${file}`, Buffer.from(f.data, 'base64'));
      this.events.push({ t: (f.metadata.timestamp ?? Date.now() / 1000) * 1000, type: 'frame', i, file, scrollY: f.metadata.scrollOffsetY, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight });
      if (!this.closed) void this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await page.goto(CAPTURE_URL, { waitUntil: 'networkidle' });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEWPORT.width * SCALE, maxHeight: VIEWPORT.height * SCALE, everyNthFrame: 1 });
    // The harness context and its recorder, before anything is recorded.
    const ready = await page.evaluate(() => (window as unknown as { __cap: { ready: () => Promise<unknown> } }).__cap.ready());
    await this.mark('capture.start', { scene: this.scene, dry: this.dry, ready, userAgent: await page.evaluate(() => navigator.userAgent) });
    // Page clock vs this process's clock, for the record.
    const a = Date.now();
    const p = await page.evaluate(() => performance.timeOrigin + performance.now());
    const b = Date.now();
    this.events.push({ t: p, type: 'clock.node', nodeMid: (a + b) / 2, roundTripMs: b - a });
    await this.loadClips();
    await sleep(800);
  }

  private async loadClips(): Promise<void> {
    for (const id of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) {
      const l = this.lines[id];
      if (!l) continue;
      const bytes = readFileSync(l.file);
      await this.mark('clip.loaded', { id, voice: l.voice, sha256: createHash('sha256').update(bytes).digest('hex'), ms: l.ms });
      const w = parseWav(bytes);
      await this.page.evaluate(([cid, b64, rate]) => (window as unknown as { __cap: { loadClip: (a: string, b: string, c: number) => Promise<unknown> } }).__cap.loadClip(cid as string, b64 as string, rate as number), [id, Buffer.from(w.pcm).toString('base64'), w.sampleRate] as const);
    }
  }

  async sync(label: string): Promise<void> {
    await this.page.evaluate((l) => (window as unknown as { __cap: { sync: (l: string) => Promise<unknown> } }).__cap.sync(l), label);
    await sleep(600);
  }

  // ------------------------------------------------------------------ input

  /** A visible, eased cursor path at about 60 steps a second. */
  async move(x: number, y: number, ms = 650): Promise<void> {
    const from = { ...this.mouse };
    const steps = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      await this.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await sleep(ms / steps);
    }
    this.mouse = { x, y };
  }

  /** Centre of an element, in viewport CSS px; throws if it is not on screen. */
  async centre(selector: string): Promise<{ x: number; y: number }> {
    const box = await this.page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`${selector} has no box`);
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (c.y < 0 || c.y > VIEWPORT.height) throw new Error(`${selector} is off screen (y ${Math.round(c.y)})`);
    return c;
  }

  async hover(selector: string, ms = 650): Promise<void> {
    const c = await this.centre(selector);
    await this.move(c.x, c.y, ms);
  }

  async clickAt(selector: string, opts: { ms?: number; dx?: number; count?: number } = {}): Promise<void> {
    const c = await this.centre(selector);
    await this.move(c.x + (opts.dx ?? 0), c.y, opts.ms ?? 650);
    await sleep(120);
    for (let i = 0; i < (opts.count ?? 1); i++) {
      await this.page.mouse.down({ clickCount: i + 1 });
      await sleep(70);
      await this.page.mouse.up({ clickCount: i + 1 });
      if (i + 1 < (opts.count ?? 1)) await sleep(60);
    }
    await sleep(150);
  }

  /** Real keystrokes, 70-110 ms apart. */
  async type(text: string): Promise<void> {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await sleep(rand(70, 110));
    }
  }

  /** Scroll so the element's top sits `margin` CSS px below the viewport top, with wheel steps. */
  async scrollTo(selector: string, margin = 12, ms = 900): Promise<void> {
    const target = await this.page.evaluate(([sel, m]) => {
      const el = document.querySelector(sel as string);
      if (!el) return null;
      return Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, el.getBoundingClientRect().top + scrollY - (m as number)));
    }, [selector, margin] as const);
    if (target === null) throw new Error(`${selector} not found`);
    for (let guard = 0; guard < 4; guard++) {
      const y = await this.page.evaluate(() => scrollY);
      const dy = target - y;
      if (Math.abs(dy) < 2) break;
      const steps = Math.max(6, Math.round(ms / 45));
      for (let i = 0; i < steps; i++) {
        await this.page.mouse.wheel(0, dy / steps);
        await sleep(ms / steps);
      }
      await sleep(250);
    }
    await this.mark('harness.scrolled', { selector, y: await this.page.evaluate(() => scrollY) });
  }

  // ------------------------------------------------------------------ waits

  since(t: number): Ev[] { return this.events.filter((e) => e.t >= t); }

  async until<T>(what: string, fn: () => T | undefined | null | false, timeoutMs: number): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await sleep(50);
    }
  }

  last(type: string, pred: (e: Ev) => boolean = () => true): Ev | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.type === type && pred(this.events[i]!)) return this.events[i];
    return undefined;
  }

  status(): string { return String(((this.last('dom.ui')?.v ?? {}) as { status?: string }).status ?? ''); }

  async pageNow(): Promise<number> { return this.page.evaluate(() => performance.timeOrigin + performance.now()); }

  /** The agent is done: every tool call answered, the last reply finished, and its audio drained. */
  async agentDone(since: number, timeoutMs = 60_000): Promise<void> {
    await this.until('the agent to finish', () => {
      const ev = this.since(since);
      const calls = ev.filter((e) => e.type === 'ws.in' && e.msg === 'tool.call').map((e) => e.call_id);
      const results = new Set(ev.filter((e) => e.type === 'ws.out' && e.msg === 'tool.result').map((e) => e.call_id));
      if (calls.some((c) => !results.has(c))) return false;
      const done = ev.filter((e) => e.type === 'ws.in' && e.msg === 'reply.done');
      if (done.length === 0) return false;
      const lastDone = done.at(-1)!.t;
      const lastResult = Math.max(0, ...ev.filter((e) => e.type === 'ws.out' && e.msg === 'tool.result').map((e) => e.t));
      if (lastDone < lastResult) return false;
      const startedAfter = ev.some((e) => e.type === 'ws.in' && e.msg === 'reply.started' && e.t > lastDone);
      if (startedAfter) return false;
      const listening = ev.some((e) => e.type === 'dom.ui' && e.t >= lastDone && (e.v as { status: string }).status === 'Listening');
      // Playback can drain before reply.done lands; then the status is already Listening.
      const drained = this.status() === 'Listening' && Date.now() - lastDone > 1500;
      return (listening && Date.now() - lastDone > 900) || drained;
    }, timeoutMs);
    await sleep(300);
  }

  async greetingDone(): Promise<void> {
    const ready = await this.until('session.ready', () => this.last('ws.in', (e) => e.msg === 'session.ready'), 20_000);
    await this.until('the greeting to play out', () => {
      const d = this.events.find((e) => e.type === 'ws.in' && e.msg === 'reply.done' && e.t >= ready.t);
      if (!d) return false;
      const after = this.events.some((e) => e.type === 'dom.ui' && e.t >= d.t && (e.v as { status: string }).status === 'Listening');
      return after || (this.status() === 'Listening' && Date.now() - d.t > 1500);
    }, 30_000);
  }

  /** A narration line starts now; nothing audible happens until it has ended. */
  async narration(id: string): Promise<number> {
    const l = this.lines[id];
    if (!l) throw new Error(`no narration ${id}`);
    await this.mark('narration', { id, ms: l.ms });
    return Date.now() + l.ms;
  }

  async waitNarration(end: number, margin = 400): Promise<void> {
    const left = end + margin - Date.now();
    if (left > 0) await sleep(left);
  }

  async say(id: string): Promise<number> {
    const t = await this.pageNow();
    await this.mark('say', { id });
    await this.page.evaluate((cid) => (window as unknown as { __cap: { playClip: (a: string) => Promise<unknown> } }).__cap.playClip(cid), id);
    return t;
  }

  async talk(label: string): Promise<void> {
    // The Talk button may have scrolled away (scene C scrolls to the tool calls): bring it back first.
    const box = await this.page.locator('#mic').first().boundingBox();
    if (!box || box.y < 0 || box.y + box.height > VIEWPORT.height) await this.scrollTo('#talk', 12, 700);
    await this.clickAt('#mic', { ms: 600 });
    await this.mark('harness.talk', { label });
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.cdp.send('Page.stopScreencast'); } catch { /* gone */ }
    await sleep(300);
    writeFileSync(`${this.dir}/raw/index.json`, JSON.stringify(this.rawIndex));
    writeFileSync(`${this.dir}/events.json`, JSON.stringify(this.events));
    await this.ctx.browser()?.close();
  }
}

// ------------------------------------------------------------------ scenes

async function sceneA(c: Capture): Promise<void> {
  // The shot starts well clear of the sync flash.
  await sleep(2000);
  const n3 = await c.narration('N3');
  await c.clickAt('#url', { ms: 800 });
  await c.type('goji.agency');
  await sleep(250);
  await c.page.keyboard.press('Enter');
  await c.until('"Found in the official MCP registry"', () => c.last('dom.hint', (e) => /Found in the official MCP registry/.test(String((e.v as { text: string }).text))), 30_000);
  // Long enough for the punch-in on "Found" to ease in, hold and ease out before the page moves.
  await sleep(4200);
  await c.scrollTo('#talk');
  await c.hover('#mic', 700);
  await c.waitNarration(n3);
  if (c.dry) return;
  await c.talk('start');
  await c.greetingDone();
  await sleep(600);
  const q1 = await c.say('Q1');
  await c.agentDone(q1);
  await sleep(500);
  const n4 = await c.narration('N4');
  await c.waitNarration(n4, 600);
  await c.talk('end');
  await sleep(1500);
}

async function sceneB(c: Capture): Promise<void> {
  await sleep(2000);
  const n5 = await c.narration('N5');
  await c.scrollTo('#registry', 90, 1000);
  await c.clickAt('#search', { ms: 700 });
  await c.type('books');
  await c.until('the Most Recommended Books result', () => {
    const ui = c.last('dom.ui')?.v as { results?: Array<{ text: string }> } | undefined;
    return ui?.results?.[0] && /Most Recommended Books/i.test(ui.results[0].text);
  }, 15_000);
  await sleep(900);
  await c.clickAt('#results .result', { ms: 700 });
  await c.until('the Books server', () => c.last('dom.ui', (e) => /recommended/i.test(String((e.v as { server: string }).server))), 20_000);
  await sleep(1200);
  await c.scrollTo('#talk', 12, 800);
  await c.hover('#mic', 700);
  await c.waitNarration(n5);
  if (c.dry) return;
  await c.talk('start');
  await c.greetingDone();
  await sleep(600);
  const q2 = await c.say('Q2');
  await c.agentDone(q2);
  await sleep(1200);
  await c.talk('end');
  await sleep(1500);
}

async function sceneC(c: Capture): Promise<void> {
  await sleep(2000);
  await c.clickAt('#presets .preset:nth-child(2)', { ms: 800 });
  await c.until('the AFG server', () => c.last('dom.ui', (e) => /AFG/.test(String((e.v as { server: string }).server))), 20_000);
  await sleep(1200);
  await c.scrollTo('#talk', 12, 900);
  if (c.dry) {
    await c.scrollTo('#paste-row', 12, 700);
    await pasteSample(c);
    await sleep(900);
    await c.scrollTo('#panes', 30, 800);
    return;
  }
  await c.talk('start');
  await c.greetingDone();
  await sleep(600);
  // Scene 6, C1: the swap.
  const q3 = await c.say('Q3');
  await c.agentDone(q3);
  await sleep(800);
  // Scene 7, C3: the sample address spoken, with the paste box empty. The gate holds it.
  const q5 = await c.say('Q5');
  await c.agentDone(q5);
  await sleep(500);
  const n8 = await c.narration('N8');
  await c.waitNarration(n8, 600);
  // Scene 8: the identifiers slide covers the first 4 s of N7, then the paste.
  const n7 = await c.narration('N7');
  await sleep(4600);
  await c.scrollTo('#paste-row', 12, 700);
  await pasteSample(c);
  // Still under N7: bring the tool calls into view for Q4 (the pasted value shows in its call card).
  await sleep(900);
  await c.scrollTo('#panes', 30, 800);
  await c.waitNarration(n7);
  // Scene 9, C2: the pasted wallet.
  const q4 = await c.say('Q4');
  await c.agentDone(q4);
  await sleep(1200);
  await c.talk('end');
  await sleep(1500);
}

/** A real copy and paste; if the paste does not land, the page's own fill-in fallback. */
async function pasteSample(c: Capture): Promise<void> {
  await c.clickAt('#sample-btn', { ms: 700 });
  await sleep(700);
  await c.clickAt('#paste', { ms: 600 });
  await c.page.keyboard.press('ControlOrMeta+V');
  await sleep(500);
  const value = await c.page.evaluate(() => (document.querySelector('#paste') as HTMLInputElement).value);
  if (value === SAMPLE_ADDRESS) { await c.mark('harness.paste', { path: 'clipboard' }); return; }
  await c.mark('harness.paste', { path: 'clipboard failed', value: value.slice(0, 60) });
  throw new Error(`the paste box holds "${value.slice(0, 60)}" after copy and paste`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const scene = arg('--scene') ?? '';
  const run = { A: sceneA, B: sceneB, C: sceneC }[scene];
  if (!run) { console.error('--scene A|B|C [--dry]'); process.exit(2); }
  const c = new Capture(scene, process.argv.includes('--dry'));
  console.log(`capture ${c.dir}`);
  let error: unknown = null;
  try {
    await c.open();
    await c.sync('start');
    await run(c);
    await sleep(800);
    await c.sync('end');
    await sleep(800);
  } catch (err) {
    error = err;
    console.error(`capture failed: ${err instanceof Error ? err.message : err}`);
    try { await c.mark('capture.error', { message: String(err instanceof Error ? err.message : err) }); } catch { /* page gone */ }
  } finally {
    await c.close();
  }
  console.log(`${c.events.filter((e) => e.type === 'frame').length} frames, ${c.events.length} events -> ${c.dir}`);
  if (existsSync(`${c.dir}/events.json`)) console.log(`next: node scripts/video/assemble.ts ${c.dir}`);
  if (error) process.exit(1);
}
