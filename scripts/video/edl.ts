/**
 * The edit list: every shot, cut, narration line, caption, punch-in and label
 * of the demo video, on the output clock, built from the saved captures. Nothing
 * here is hand-timed: in and out points, cuts and punch-ins come from each
 * capture's log (capture.json), its stems and their transcripts.
 *
 * Rules it enforces (brief F, F2.5 and F2.6):
 * - nothing is cut, sped up or slowed down between the caller's last word and
 *   the agent's first word after it;
 * - every cut is a visible 200 ms crossfade, scenes change with 300 ms ones;
 * - scene A's greeting stays whole if it is 7 s or less; later greetings are cut;
 * - an answer longer than 14 s is cut at the last sentence end between 6 s and
 *   14 s into it, and its caption ends with "…";
 * - narration never overlaps the caller or the agent (checked, not assumed).
 *
 *   node scripts/video/edl.ts [--only A] [--out video/out/edl.json]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { PROPER_NOUN_VARIANTS, callerLines, narration } from './config.ts';
import { normaliseSpeech } from './stt.ts';
import { readF32Wav } from './assemble.ts';
import { MANIFEST } from './voices.ts';
import { NARRATION_WORDS, TRANSCRIPTS } from './transcribe.ts';

export const FPS = 30;
export const SCENE_XFADE = 300;
export const CUT_XFADE = 200;
export const KIT = '/Users/ochinimus/Desktop/interpres-video-kit';
export const COVER = '/Users/ochinimus/Desktop/interpres-cover.png';
export const IDENTIFIERS_PNG = 'video/out/identifiers.png';
export const CHOICE_FILE = 'data/video/takes.json';

type Word = { text: string; start: number; end: number };
type Rect = { x: number; y: number; w: number; h: number };
type LogEv = { t: number; type: string; [k: string]: unknown };

export type Segment = { at: number; from: number; to: number };
export type Shot =
  | { kind: 'still'; image: string; start: number; end: number; name: string }
  | { kind: 'live'; capture: string; start: number; end: number; name: string; segments: Segment[] };
export type Caption = { start: number; end: number; who: 'narration' | 'caller' | 'agent'; lines: string[] };
export type Edl = {
  fps: number;
  durationMs: number;
  shots: Shot[];
  narration: Array<{ id: string; at: number; ms: number; file: string }>;
  audio: Array<{ capture: string; stem: 'caller' | 'agent'; from: number; to: number; at: number; fadeIn: number; fadeOut: number }>;
  captions: Caption[];
  punchIns: Array<{ capture: string; start: number; hold: number; rect: Rect; zoom: number; reason: string }>;
  labels: Array<{ start: number; end: number; text: string }>;
  endCard: { start: number; end: number; lines: string[] } | null;
  cuts: Array<{ shot: string; at: number; fromMs: number; toMs: number; reason: string }>;
  exchanges: Array<{ capture: string; id: string; voiceToVoiceMs: number | null; callerEndAt: number; agentStartAt: number | null }>;
  checks: Array<{ check: string; ok: boolean; detail: string }>;
};

// ------------------------------------------------------------------ captions

const MAX_CHARS = 42;

/** Wrap into at most two lines of 42 characters, as even as the words allow; null if it will not fit. */
export function wrap(words: string[], max = MAX_CHARS): string[] | null {
  const text = words.join(' ');
  if (text.length <= max) return [text];
  let best: string[] | null = null;
  let bestLen = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' ');
    const b = words.slice(k).join(' ');
    if (a.length > max || b.length > max) continue;
    // Prefer the most even split; a break after a comma or full stop wins a tie.
    const score = Math.max(a.length, b.length) - (/[,.;:?!]$/.test(words[k - 1]!) ? 8 : 0);
    if (score < bestLen) { bestLen = score; best = [a, b]; }
  }
  return best;
}

/**
 * Words with times into captions of at most two lines: sentence by sentence,
 * a short sentence joined to the next when both fit, a long one split at its
 * clauses into even parts. The speaker label ("Caller:") opens the first
 * caption of each utterance; the captions that continue it follow straight on.
 */
export function chunk(words: Word[], who: Caption['who'], prefix = ''): Caption[] {
  let labelled = false;
  const withPrefix = (ws: Word[], first = !labelled) => [...(prefix && first ? [prefix] : []), ...ws.map((w) => w.text)];
  const fits = (ws: Word[]) => wrap(withPrefix(ws)) !== null;
  // Sentences.
  const sentences: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) { cur.push(w); if (/[.?!…]$/.test(w.text)) { sentences.push(cur); cur = []; } }
  if (cur.length) sentences.push(cur);
  // Pieces that each fit two lines: split long sentences evenly, preferring clause ends.
  const pieces: Word[][] = [];
  for (const sen of sentences) {
    if (fits(sen)) { pieces.push(sen); continue; }
    const lens = sen.map((w) => w.text.length + 1);
    const cum = lens.map((_, i) => lens.slice(0, i + 1).reduce((a, b) => a + b, 0));
    const total = cum.at(-1)!;
    let done = false;
    for (let parts = 2; parts <= 12 && !done; parts++) {
      // Each break at the clause end nearest its ideal place, else at the nearest word.
      const cuts: number[] = [];
      for (let k = 1; k < parts; k++) {
        const ideal = (total * k) / parts;
        const lo = cuts.at(-1) ?? -1;
        const clauses = sen.map((w, i) => i).filter((i) => i > lo && i < sen.length - 1 && /[,;:]$/.test(sen[i]!.text) && Math.abs(cum[i]! - ideal) <= total / parts * 0.45);
        const best = clauses.sort((a, b) => Math.abs(cum[a]! - ideal) - Math.abs(cum[b]! - ideal))[0]
          ?? sen.map((_, i) => i).filter((i) => i > lo && i < sen.length - 1).sort((a, b) => Math.abs(cum[a]! - ideal) - Math.abs(cum[b]! - ideal))[0];
        if (best === undefined) break;
        cuts.push(best);
      }
      const out: Word[][] = [];
      let from = 0;
      for (const c of [...cuts, sen.length - 1]) { out.push(sen.slice(from, c + 1)); from = c + 1; }
      if (out.length === parts && out.every((o) => o.length > 0 && fits(o))) { pieces.push(...out); done = true; }
    }
    if (!done) throw new Error(`cannot caption: ${sen.map((w) => w.text).join(' ').slice(0, 60)}`);
  }
  // Join short neighbours when the pair still fits.
  const joined: Word[][] = [];
  for (const p of pieces) {
    const last = joined.at(-1);
    if (last && fits([...last, ...p]) && [...last, ...p].map((w) => w.text).join(' ').length <= 60) joined[joined.length - 1] = [...last, ...p];
    else joined.push(p);
  }
  return joined.map((ws, i) => ({ start: ws[0]!.start, end: ws.at(-1)!.end, who, lines: wrap(withPrefix(ws, i === 0))! }));
}

/**
 * The script's own words, timed by the transcript's: both sides are reduced to
 * normalised tokens (stt.ts), accepted proper-noun spellings are mapped back,
 * and each script word takes the span of the transcript words its tokens fell in.
 */
export function alignScript(script: string, words: Word[]): Word[] {
  const sw = script.split(/\s+/).filter(Boolean);
  const sFlat = sw.flatMap((w, i) => normaliseSpeech(w).map((x) => ({ x, i })));
  let wFlat = words.flatMap((w, j) => normaliseSpeech(w.text).map((x) => ({ x, j0: j, j1: j })));
  for (const [word, alts] of Object.entries(PROPER_NOUN_VARIANTS)) {
    for (const alt of alts) {
      const a = normaliseSpeech(alt);
      for (let k = 0; k + a.length <= wFlat.length; k++) {
        if (a.every((t, m) => wFlat[k + m]!.x === t) && a.join(' ') !== word) {
          wFlat = [...wFlat.slice(0, k), { x: word, j0: wFlat[k]!.j0, j1: wFlat[k + a.length - 1]!.j1 }, ...wFlat.slice(k + a.length)];
        }
      }
    }
  }
  if (sFlat.length !== wFlat.length || sFlat.some((s, k) => s.x !== wFlat[k]!.x)) {
    throw new Error(`the script and its transcript do not align: "${script.slice(0, 50)}…"`);
  }
  return sw.map((text, i) => {
    const ks = sFlat.map((s, k) => (s.i === i ? k : -1)).filter((k) => k >= 0);
    if (ks.length === 0) {
      // A word with no tokens (a lone dash): borrow its neighbour's time.
      const prev = sFlat.findLast((s) => s.i < i);
      const w = prev ? words[wFlat[sFlat.indexOf(prev)]!.j1]! : words[0]!;
      return { text, start: w.end, end: w.end };
    }
    return { text, start: words[wFlat[ks[0]!]!.j0]!.start, end: words[wFlat[ks.at(-1)!]!.j1]!.end };
  });
}

/** Long hex identifiers in groups of four characters, as the page's gate card prints them. */
export function groupIds(text: string): string {
  return text.replace(/\b0x[0-9a-fA-F]{8,}\b/g, (id) => id.match(/.{1,4}/g)!.join(' '));
}

/**
 * The caption's words, timed from the stem transcript: ordinary words take the
 * transcript's own times one for one. A spelled-out identifier comes back as
 * one token whose timestamps cover a fraction of the letters, so its groups
 * are spread evenly from the word before it to the caller's last sound: a
 * synthetic voice spells at a steady pace.
 */
export function timeCallerWords(text: string, stem: Word[], start: number, end: number): Word[] {
  const cap = text.split(/\s+/).filter(Boolean);
  if (stem.length === cap.length) return stem.map((w, i) => ({ text: cap[i]!, start: w.start, end: w.end }));
  const idAt = cap.findIndex((w) => /^0x[0-9a-fA-F]{2}$/.test(w));
  const stemId = stem.findIndex((w) => /0x[0-9a-fA-F]{8,}/i.test(w.text));
  if (idAt < 0 || stemId < 0 || stemId !== idAt || stem.length - stemId - 1 !== 0) return spread(text, start, end);
  // The words before the identifier, one for one; then the groups, evenly to the end.
  const before = stem.slice(0, stemId).map((w, i) => ({ text: cap[i]!, start: w.start, end: w.end }));
  const idStart = stem[stemId]!.start;
  return [...before, ...spread(cap.slice(idAt).join(' '), idStart, end)];
}

/** Spread a known text evenly over [start, end] when no word times fit it. */
function spread(text: string, start: number, end: number): Word[] {
  const ws = text.split(/\s+/).filter(Boolean);
  const total = ws.reduce((p, w) => p + w.length + 1, 0);
  let at = start;
  return ws.map((w) => { const d = ((w.length + 1) / total) * (end - start); const r = { text: w, start: Math.round(at), end: Math.round(at + d) }; at += d; return r; });
}

// ------------------------------------------------------------------ audio spans

/** Spans where a stem is audible, merging gaps shorter than `gapMs`. */
export function spans(d: Float32Array, rate: number, thr = 0.01, gapMs = 350): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const win = Math.round(rate * 0.01);
  let on = -1;
  let lastLoud = -1;
  for (let i = 0; i < d.length; i += win) {
    let peak = 0;
    for (let k = i; k < Math.min(d.length, i + win); k++) peak = Math.max(peak, Math.abs(d[k]!));
    const loud = peak > thr;
    if (loud) { if (on < 0) on = i; lastLoud = i + win; }
    if (on >= 0 && !loud && (i - lastLoud) / rate * 1000 > gapMs) { out.push({ start: (on / rate) * 1000, end: (lastLoud / rate) * 1000 }); on = -1; }
  }
  if (on >= 0) out.push({ start: (on / rate) * 1000, end: (lastLoud / rate) * 1000 });
  return out;
}

// ------------------------------------------------------------------ captures

type CaptureData = {
  name: string;
  dir: string;
  log: LogEv[];
  exchanges: Array<{ id: string; callerStartMs: number | null; callerEndMs: number; agentStartMs: number | null; voiceToVoiceMs: number | null; heard: string | null }>;
  sync: Array<{ label: string; flashMs: number | null }>;
  agentSpans: Array<{ start: number; end: number }>;
  callerSpans: Array<{ start: number; end: number }>;
  /** Caller spans split at every gap of 60 ms or more: the gaps between spoken letters. */
  callerFine: Array<{ start: number; end: number }>;
  agentWords: Word[];
  callerWords: Word[];
  lengthMs: number;
};

export function loadCapture(name: string): CaptureData {
  const dir = `video/captures/${name}`;
  const c = JSON.parse(readFileSync(`${dir}/capture.json`, 'utf8'));
  const agent = readF32Wav(`${dir}/stems/agent.wav`);
  const caller = readF32Wav(`${dir}/stems/caller.wav`);
  const tw = (stem: string): Word[] => {
    const f = `${TRANSCRIPTS}/${name}-${stem}.json`;
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).words as Word[]) : [];
  };
  return {
    name, dir, log: c.log, exchanges: c.exchanges, sync: c.sync, lengthMs: c.lengthMs,
    agentSpans: spans(agent.data, agent.rate), callerSpans: spans(caller.data, caller.rate, 0.01, 350), callerFine: spans(caller.data, caller.rate, 0.01, 60),
    agentWords: tw('agent'), callerWords: tw('caller'),
  };
}

const first = (c: CaptureData, pred: (e: LogEv) => boolean) => c.log.find(pred);
const mark = (c: CaptureData, type: string, key: string, val: string) => first(c, (e) => e.type === type && e[key] === val);

/** The agent's speech in [from, to), as spans. */
const agentIn = (c: CaptureData, from: number, to: number) => c.agentSpans.filter((s) => s.end > from && s.start < to);

// ------------------------------------------------------------------ build

type Plan = { name: string; capture: string; from: number; to: number; cuts: Array<{ from: number; to: number; reason: string }>; stillAfter?: boolean };

export function build(opts: { only?: string } = {}): Edl {
  const takes = JSON.parse(readFileSync(CHOICE_FILE, 'utf8')) as Record<string, string>;
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')).lines as Record<string, { file: string; attempts: Array<{ ms: number }> }>;
  const nWords = JSON.parse(readFileSync(NARRATION_WORDS, 'utf8')) as Record<string, { script: string; words: Word[] }>;
  const script = narration();
  const nMs = (id: string) => manifest[id]!.attempts.at(-1)!.ms;
  const checks: Edl['checks'] = [];
  const check = (name: string, ok: boolean, detail = '') => checks.push({ check: name, ok, detail });

  const caps = new Map<string, CaptureData>();
  const cap = (scene: string) => {
    const name = takes[scene];
    if (!name) throw new Error(`no take chosen for scene ${scene} in ${CHOICE_FILE}`);
    if (!caps.has(name)) caps.set(name, loadCapture(name));
    return caps.get(name)!;
  };

  const shots: Shot[] = [];
  const narr: Edl['narration'] = [];
  const audio: Edl['audio'] = [];
  const captions: Caption[] = [];
  const punchIns: Edl['punchIns'] = [];
  const labels: Edl['labels'] = [];
  const cuts: Edl['cuts'] = [];
  const exchanges: Edl['exchanges'] = [];
  let t = 0;
  const LIVE_LABEL = 'live session · scripted caller';

  const addNarration = (id: string, at: number) => {
    narr.push({ id, at, ms: nMs(id), file: manifest[id]!.file });
    const words = alignScript(script[id]!, nWords[id]!.words).map((w) => ({ ...w, start: w.start + at, end: w.end + at }));
    captions.push(...chunk(words, 'narration'));
  };

  const still = (name: string, image: string, lines: string[], opts2: { lead?: number; tail?: number; label?: string; minMs?: number } = {}) => {
    const start = shots.length === 0 ? 0 : t - SCENE_XFADE;
    let at = start + (opts2.lead ?? 500);
    for (const id of lines) { addNarration(id, at); at += nMs(id) + 400; }
    const end = Math.max(at - 400 + (opts2.tail ?? 700), start + (opts2.minMs ?? 0));
    shots.push({ kind: 'still', image, start, end, name });
    if (opts2.label) labels.push({ start, end, text: opts2.label });
    t = end;
    return { start, end };
  };

  /** A live shot from a capture plan: segments, audio, captions, narration, punch-ins. */
  const live = (p: Plan, lead: { narrationIds: string[] }) => {
    const c = caps.get(p.capture)!;
    const start = shots.length === 0 ? 0 : t - SCENE_XFADE;
    // Segments: the plan's range minus its cuts, joined by 200 ms crossfades.
    const keep: Array<{ from: number; to: number }> = [];
    let from = p.from;
    for (const cut of [...p.cuts].sort((a, b) => a.from - b.from)) { keep.push({ from, to: cut.from + CUT_XFADE / 2 }); from = cut.to - CUT_XFADE / 2; }
    keep.push({ from, to: p.to });
    const segments: Segment[] = [];
    let at = start;
    for (const [i, k] of keep.entries()) {
      segments.push({ at, from: k.from, to: k.to });
      at += k.to - k.from - (i < keep.length - 1 ? CUT_XFADE : 0);
    }
    const end = at;
    for (const [i, cut] of [...p.cuts].sort((a, b) => a.from - b.from).entries()) cuts.push({ shot: p.name, at: segments[i + 1]!.at, fromMs: cut.from, toMs: cut.to, reason: cut.reason });
    shots.push({ kind: 'live', capture: p.capture, start, end, name: p.name, segments });
    labels.push({ start, end, text: LIVE_LABEL });
    t = end;
    const toOut = (ct: number): number | null => {
      for (const s of segments) if (ct >= s.from && ct <= s.to) return s.at + (ct - s.from);
      return null;
    };
    // Audio: both stems over every segment, faded over the crossfades.
    for (const [i, s] of segments.entries()) {
      for (const stem of ['caller', 'agent'] as const) {
        audio.push({ capture: p.capture, stem, from: s.from, to: s.to, at: s.at, fadeIn: i === 0 ? SCENE_XFADE : CUT_XFADE, fadeOut: i === segments.length - 1 ? SCENE_XFADE : CUT_XFADE });
      }
    }
    // Narration marked during the capture.
    for (const id of lead.narrationIds) {
      const m = mark(c, 'narration', 'id', id);
      if (!m) throw new Error(`${p.capture}: no ${id} mark`);
      const o = toOut(m.t);
      if (o === null) throw new Error(`${p.capture}: ${id} falls in a cut`);
      addNarration(id, o);
      // Narration must not overlap the caller or the agent.
      const clash = [...agentIn(c, m.t, m.t + nMs(id)), ...c.callerSpans.filter((s) => s.end > m.t && s.start < m.t + nMs(id))];
      check(`${id} overlaps no caller or agent audio`, clash.length === 0, clash.map((s) => `${Math.round(s.start)}-${Math.round(s.end)}`).join(', '));
    }
    // Caller captions: the live transcript, timed by the stem in capture time, then mapped;
    // a cut inside a caller's line splits its caption, and both sides show the cut with "…".
    for (const x of c.exchanges) {
      const cs = x.callerStartMs ?? x.callerEndMs;
      const s1 = toOut(x.callerEndMs);
      if (toOut(cs) === null && s1 === null) continue;
      // An identifier is shown in groups of four, the way the page's own gate card shows it, so it can wrap.
      const text = groupIds(x.heard ?? callerLines()[x.id]!);
      const inClip = c.callerWords.filter((w) => w.start >= cs - 300 && w.end <= x.callerEndMs + 300);
      const capWords = timeCallerWords(text, inClip, cs, x.callerEndMs);
      const runs: Word[][] = [[]];
      for (const w of capWords) {
        const o0 = toOut(w.start);
        const o1 = toOut(w.end);
        if (o0 === null || o1 === null) { if (runs.at(-1)!.length) runs.push([]); continue; }
        runs.at(-1)!.push({ text: w.text, start: o0, end: o1 });
      }
      const kept = runs.filter((r) => r.length > 0);
      kept.forEach((r, i) => {
        if (i < kept.length - 1) r[r.length - 1] = { ...r.at(-1)!, text: `${r.at(-1)!.text.replace(/[.?!,]$/, '')}…` };
        if (i > 0) r[0] = { ...r[0]!, text: `…${r[0]!.text}` };
        captions.push(...chunk(r, 'caller', i === 0 ? 'Caller:' : ''));
      });
      const a = x.agentStartMs === null ? null : toOut(x.agentStartMs);
      if (s1 === null) { check(`${x.id}: the caller's last word is in the edit`, false, 'it falls in a cut'); continue; }
      exchanges.push({ capture: p.capture, id: x.id, voiceToVoiceMs: x.voiceToVoiceMs, callerEndAt: s1, agentStartAt: a });
      // The latency window must survive the edit untouched.
      const inOneSegment = segments.some((s) => x.callerEndMs >= s.from && (x.agentStartMs ?? x.callerEndMs) <= s.to);
      check(`${x.id}: nothing cut between the caller's last word and the agent's first`, inOneSegment, `${Math.round(x.callerEndMs)}-${Math.round(x.agentStartMs ?? -1)} ms`);
    }
    // Agent captions: the stem's transcript, utterance by utterance, inside the kept segments.
    const agentWords = c.agentWords.map((w) => ({ ...w, o0: toOut(w.start), o1: toOut(w.end) }));
    let run: Word[] = [];
    const flushRun = (cutAfter: boolean) => {
      if (run.length === 0) return;
      const chunks = chunk(run, 'agent', 'Agent:');
      if (cutAfter && chunks.length > 0) {
        const lastC = chunks.at(-1)!;
        lastC.lines[lastC.lines.length - 1] = `${lastC.lines.at(-1)!.replace(/[.?!,]$/, '')}…`;
      }
      captions.push(...chunks);
      run = [];
    };
    for (let i = 0; i < agentWords.length; i++) {
      const w = agentWords[i]!;
      if (w.o0 === null || w.o1 === null) {
        // Inside the shot's range the word fell in a cut: what came before it ends with "…".
        // Outside the range it simply belongs to another shot.
        flushRun(w.start > p.from && w.end < p.to);
        continue;
      }
      const prev = run.at(-1);
      if (prev && w.o0 - prev.end > 900) flushRun(false);
      run.push({ text: w.text, start: w.o0, end: w.o1 });
    }
    flushRun(false);
    return { start, end, toOut, c, segments };
  };

  const only = opts.only;
  // 1-2: cover and the gap.
  if (!only) {
    still('cover', COVER, ['N1'], { lead: 600, tail: 800, label: 'every voice: AssemblyAI Voice Agent API' });
    still('gap', `${KIT}/slides/gap.png`, ['N2']);
  }
  // 3: live A.
  if (!only || only === 'A') {
    const c = cap('A');
    const n3 = mark(c, 'narration', 'id', 'N3')!;
    const talkEnd = first(c, (e) => e.type === 'harness.talk' && e.label === 'end')!;
    const q1 = c.exchanges.find((x) => x.id === 'Q1')!;
    const greeting = agentIn(c, mark(c, 'harness.talk', 'label', 'start')!.t, q1.callerStartMs ?? q1.callerEndMs);
    const greetingMs = greeting.length ? greeting.at(-1)!.end - greeting[0]!.start : 0;
    check('scene A greeting is 7 s or less, kept whole', greetingMs <= 7000, `${Math.round(greetingMs)} ms`);
    const p: Plan = { name: 'A', capture: c.name, from: n3.t - 1000, to: talkEnd.t + 700, cuts: [] };
    const tail = answerCut(c, q1, mark(c, 'narration', 'id', 'N4')!.t);
    if (tail) p.cuts.push(tail);
    caps.set(c.name, c);
    const L = live(p, { narrationIds: ['N3', 'N4'] });
    // Punch-ins: "Found", and the tool call under N4.
    const hint = first(c, (e) => e.type === 'dom.hint' && /Found in the official MCP registry/.test(String((e.v as { text: string }).text)))!;
    punch(punchIns, c, L.toOut, hint.t + 250, (hint.v as { rect: Rect }).rect, '"Found in the official MCP registry"');
    const n4 = mark(c, 'narration', 'id', 'N4')!;
    const call = callCard(c, n4.t, 'goji_explain_term');
    if (call) punch(punchIns, c, L.toOut, n4.t + 100, call.rect, 'the goji_explain_term call, under N4');
  }
  // 4: live B.
  if (!only || only === 'B') {
    const c = cap('B');
    const n5 = mark(c, 'narration', 'id', 'N5')!;
    const talkStart = mark(c, 'harness.talk', 'label', 'start')!;
    const talkEnd = mark(c, 'harness.talk', 'label', 'end')!;
    const q2 = c.exchanges.find((x) => x.id === 'Q2')!;
    const p: Plan = { name: 'B', capture: c.name, from: n5.t - 1000, to: talkEnd.t + 700, cuts: [] };
    const g = agentIn(c, talkStart.t, q2.callerStartMs ?? q2.callerEndMs);
    if (g.length) p.cuts.push({ from: talkStart.t + 900, to: (q2.callerStartMs ?? q2.callerEndMs) - 500, reason: 'the greeting (greetings after scene A may be cut)' });
    const tail = answerCut(c, q2, talkEnd.t);
    if (tail) p.cuts.push(tail);
    const L = live(p, { narrationIds: ['N5'] });
    const call = callCard(c, q2.callerEndMs, 'get_book_recommenders');
    if (call) punch(punchIns, c, L.toOut, call.t + 200, call.rect, 'the get_book_recommenders call');
  }
  if (!only) still('phases', `${KIT}/slides/phases.png`, ['N6']);
  // 6-9, round F3 order: C1 (Q3, the swap) and C3 (Q5 spoken, held, N8) in one shot; the
  // identifiers slide over the first 4 s of N7; then the paste and C2 (Q4) in a second shot.
  if (!only || only === 'C') {
    const c = cap('C');
    const presetClick = first(c, (e) => e.type === 'mousedown')!;
    const talkStart = mark(c, 'harness.talk', 'label', 'start')!;
    const n7 = mark(c, 'narration', 'id', 'N7')!;
    const n8 = mark(c, 'narration', 'id', 'N8')!;
    // The take's End press never happened (the harness error at the end, see BUILDLOG):
    // then the shot ends 1.2 s after the agent's last word, still inside the capture.
    const talkEnd = mark(c, 'harness.talk', 'label', 'end') ?? { t: Math.min(c.lengthMs - 800, (c.agentSpans.at(-1)?.end ?? c.lengthMs) + 500), type: 'derived' };
    const [q3, q5, q4] = ['Q3', 'Q5', 'Q4'].map((id) => c.exchanges.find((x) => x.id === id)!);
    const p1: Plan = { name: 'C1+C3', capture: c.name, from: presetClick.t - 1500, to: n7.t + SCENE_XFADE / 2, cuts: [] };
    p1.cuts.push({ from: talkStart.t + 900, to: (q3!.callerStartMs ?? q3!.callerEndMs) - 500, reason: 'the greeting (greetings after scene A may be cut)' });
    const t3 = answerCut(c, q3!, q5!.callerStartMs ?? n8.t);
    if (t3) p1.cuts.push(t3);
    const t5 = answerCut(c, q5!, n8.t);
    if (t5) p1.cuts.push(t5);
    // Q5 runs over 10 s: keep its first 4 s and its last 3 s, cut between two letters.
    const q5s = q5!.callerStartMs ?? q5!.callerEndMs;
    if (q5!.callerEndMs - q5s > 10_000) {
      const within = c.callerFine.filter((sp) => sp.start >= q5s - 100 && sp.end <= q5!.callerEndMs + 100);
      const before = within.filter((sp) => sp.end <= q5s + 4000).at(-1);
      const after = within.find((sp) => sp.start >= q5!.callerEndMs - 3000);
      if (!before || !after || after.start - before.end <= 1000) check('the cut inside Q5 finds a gap between letters', false, `${within.length} fine spans`);
      else p1.cuts.push({ from: before.end + 120, to: after.start - 120, reason: `inside Q5, which runs ${((q5!.callerEndMs - q5s) / 1000).toFixed(1)} s: its first 4 s and last 3 s kept, cut between two letters` });
    }
    const L1 = live(p1, { narrationIds: ['N8'] });
    const ft = callCard(c, q3!.callerEndMs, 'find_tools', true);
    if (ft) punch(punchIns, c, L1.toOut, ft.t + 200, ft.rect, 'find_tools and the swap');
    const gate = first(c, (e) => e.type === 'dom.gate' && e.t > (q5!.callerStartMs ?? 0) && (e.v as { shown: boolean; kind: string }).shown && (e.v as { kind: string }).kind === 'paste');
    if (gate) {
      // The page centres the paste box when it holds a call: take the card's rect once it has settled.
      const settled = [...c.log].filter((e) => e.type === 'dom.gate' && e.t >= gate.t && e.t <= gate.t + 1500).at(-1) ?? gate;
      punch(punchIns, c, L1.toOut, settled.t + 150, (settled.v as { rect: Rect }).rect, 'needs_paste');
    }
    // 8: the identifiers slide, with N7 starting on it.
    const slideStart = t - SCENE_XFADE;
    const n7Out = L1.toOut(n7.t)!;
    shots.push({ kind: 'still', image: IDENTIFIERS_PNG, start: slideStart, end: slideStart + 4000 + SCENE_XFADE, name: 'identifiers' });
    t = slideStart + 4000 + SCENE_XFADE;
    addNarration('N7', n7Out);
    // 9: the paste, then C2.
    const p2: Plan = { name: 'C2', capture: c.name, from: n7.t + (t - SCENE_XFADE - n7Out), to: talkEnd.t + 700, cuts: [] };
    const t4 = answerCut(c, q4!, talkEnd.t);
    if (t4) p2.cuts.push(t4);
    const L2 = live(p2, { narrationIds: [] });
    const rep = callCard(c, q4!.callerEndMs, 'afg_get_reputation');
    if (rep) punch(punchIns, c, L2.toOut, rep.t + 200, rep.argsRect ?? rep.rect, 'afg_get_reputation and its argument');
  }
  if (!only) {
    still('registry', `${KIT}/slides/registry.png`, ['N9']);
    still('spoken', `${KIT}/slides/spoken.png`, ['N10']);
    still('speed', `${KIT}/slides/speed.png`, ['N11']);
  }
  let endCard: Edl['endCard'] = null;
  if (!only) {
    const s = still('try', `${KIT}/slides/try.png`, ['N12'], { tail: 800 });
    const endStart = s.end;
    const lastShot = shots.at(-1)!;
    lastShot.end = endStart + 4000;
    t = lastShot.end;
    endCard = { start: endStart, end: endStart + 4000, lines: endCardLines() };
  }

  // Captions: at least 1 s each, never past the next one, and held a little after speech.
  captions.sort((a, b) => a.start - b.start);
  for (let i = 0; i < captions.length; i++) {
    const cc = captions[i]!;
    const next = captions[i + 1];
    const want = Math.max(cc.end + 600, cc.start + 1000);
    cc.end = next ? Math.min(want, next.start) : want;
    if (cc.end - cc.start < 1000) check('every caption is on screen for at least 1 s', false, `${cc.lines.join(' / ')} (${Math.round(cc.end - cc.start)} ms)`);
  }
  check('captions fit 2 lines of 42 characters', captions.every((c) => c.lines.length <= 2 && c.lines.every((l) => [...l].length <= MAX_CHARS + 1)), '');
  // Punch-ins must not overlap.
  punchIns.sort((a, b) => a.start - b.start);
  for (let i = 1; i < punchIns.length; i++) {
    const prev = punchIns[i - 1]!;
    const cur = punchIns[i]!;
    if (cur.start < prev.start + prev.hold + 800) { cur.start = prev.start + prev.hold + 800; }
  }
  const durationMs = Math.round(t);
  return { fps: FPS, durationMs, shots, narration: narr, audio, captions, punchIns, labels, endCard, cuts, exchanges, checks };
}

/** The last sentence end 6-14 s into an answer longer than 14 s; the cut runs to the answer's end. */
function answerCut(c: CaptureData, x: { id: string; agentStartMs: number | null }, before: number): { from: number; to: number; reason: string } | null {
  if (x.agentStartMs === null) return null;
  const sp = agentIn(c, x.agentStartMs, before);
  if (sp.length === 0) return null;
  const answerEnd = sp.at(-1)!.end;
  if (answerEnd - x.agentStartMs <= 14_000) return null;
  const ends = c.agentWords.filter((w) => /[.?!]$/.test(w.text) && w.end >= x.agentStartMs! + 6000 && w.end <= x.agentStartMs! + 14_000);
  const e = ends.at(-1);
  if (!e) throw new Error(`${c.name} ${x.id}: an answer over 14 s with no sentence end between 6 s and 14 s`);
  // Only a tail with words in it is a tail: trailing silence is not cut.
  if (!c.agentWords.some((w) => w.start > e.end && w.end <= answerEnd + 50)) return null;
  return { from: e.end + 150, to: answerEnd + 400, reason: `the tail of ${x.id}'s answer, cut at a sentence end ${((e.end - x.agentStartMs) / 1000).toFixed(1)} s in` };
}

/** The first snapshot, after `since`, in which a tool's call card exists (settled one: its rect). */
function callCard(c: CaptureData, since: number, name: string, spoken = false): { t: number; rect: Rect; argsRect?: Rect } | null {
  const find = (e: LogEv) => (e.v as Array<{ name: string; rect: Rect; argsRect: Rect | null; spoken: string }>).find((x) => x.name === name && (!spoken || x.spoken !== ''));
  // The first snapshot after `since` that shows the card...
  for (const e of c.log) {
    if (e.type !== 'dom.calls' || e.t < since) continue;
    const card = find(e);
    if (card) return { t: e.t, rect: card.rect, argsRect: card.argsRect ?? undefined };
  }
  // ...or, when nothing changed after it, the card as it stood at `since`.
  const before = c.log.filter((e) => e.type === 'dom.calls' && e.t < since).at(-1);
  const card = before ? find(before) : undefined;
  return card ? { t: since, rect: card.rect, argsRect: card.argsRect ?? undefined } : null;
}

function punch(list: Edl['punchIns'], c: CaptureData, toOut: (t: number) => number | null, at: number, rect: Rect, reason: string): void {
  const o = toOut(at);
  if (o === null) throw new Error(`${c.name}: the punch-in for ${reason} falls in a cut`);
  list.push({ capture: c.name, start: o, hold: 3000, rect, zoom: 1.4, reason });
}

function endCardLines(): string[] {
  const takes = JSON.parse(readFileSync(CHOICE_FILE, 'utf8')) as Record<string, string>;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = [...new Set(Object.values(takes).map((n) => n.match(/-(\d{8})T/)?.[1] ?? ''))].filter(Boolean).sort();
  const same = days.every((d) => d.slice(0, 6) === days[0]!.slice(0, 6));
  const label = same
    ? `${days.map((d) => Number(d.slice(6))).join(' and ')} ${MONTHS[Number(days[0]!.slice(4, 6)) - 1]} ${days[0]!.slice(0, 4)}`
    : days.map((d) => `${Number(d.slice(6))} ${MONTHS[Number(d.slice(4, 6)) - 1]} ${d.slice(0, 4)}`).join(' and ');
  return [
    `Recorded live on interpres.ochinimus.app on ${label} (UTC).`,
    'Every voice is an AssemblyAI Voice Agent voice; the caller is scripted.',
    'Session IDs: docs/VIDEO.md',
  ];
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const edl = build({ only: arg('--only') });
  const out = arg('--out') ?? `video/out/edl${arg('--only') ? `-${arg('--only')}` : ''}.json`;
  mkdirSync('video/out', { recursive: true });
  writeFileSync(out, JSON.stringify(edl, null, 1));
  console.log(`${out}: ${(edl.durationMs / 1000).toFixed(1)} s, ${edl.shots.length} shots, ${edl.cuts.length} cuts, ${edl.captions.length} captions, ${edl.punchIns.length} punch-ins`);
  for (const c of edl.cuts) console.log(`  cut ${c.shot} at ${(c.at / 1000).toFixed(2)} s: ${c.reason}`);
  for (const c of edl.checks) if (!c.ok) console.log(`  CHECK FAILED: ${c.check} ${c.detail}`);
  void readdirSync;
}
