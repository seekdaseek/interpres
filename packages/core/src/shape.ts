/**
 * Turning an MCP tool result into something an agent can say out loud.
 *
 * MCP tools answer to a text-model reader: JSON blobs, markdown tables,
 * paginated lists. Read aloud, that is unusable. So anything large or clearly
 * structured goes through the LLM Gateway and comes back as at most 600
 * characters of plain speech, while the raw result is kept for the UI.
 *
 * The LLM call is injected rather than made here, so every decision in this
 * module is unit-testable without a network.
 */

import { extractiveSummary } from './extract.ts';

export type McpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { text?: string; uri?: string; mimeType?: string };
  [k: string]: unknown;
};

export type McpCallResult = {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
};

/** Above this many characters, a result is shaped rather than passed through. */
export const SHAPE_OVER_CHARS = 2048;
/** The ceiling on what the agent is handed to speak. */
export const SPOKEN_MAX_CHARS = 600;

export type Shaper = (input: {
  text: string;
  /** What the caller asked, when known; sharpens the summary a lot. */
  question?: string;
  toolName: string;
  maxChars: number;
}) => Promise<string>;

export type ShapeResult = {
  /** JSON string for `tool.result.result` - the API requires a string. */
  result: string;
  /** What we handed the agent, before JSON encoding. */
  spoken: string;
  /** The untouched text, for the UI's raw pane. */
  raw: string;
  shaped: boolean;
  /** `empty`, `passthrough`, `truncated`, `local`, or `llm`. */
  method: string;
  /**
   * What happened to the Gateway refinement, for results that needed shaping:
   * `used`, `timeout`, `error`, `circuit_open`, `no_shaper`. `not_needed` for
   * results that were already speakable and never went near the Gateway.
   */
  refine: RefineOutcome;
  /** Milliseconds spent waiting on the Gateway; never more than the deadline. */
  refineMs: number;
  isError: boolean;
  rawChars: number;
  spokenChars: number;
};

export type RefineOutcome = 'used' | 'timeout' | 'error' | 'circuit_open' | 'no_shaper' | 'not_needed';

/**
 * The Gateway gets this long to improve on the local answer, and no longer.
 * The local answer is already computed when the clock starts, so the worst
 * case for speech is this many milliseconds - never an open-ended wait.
 */
export const REFINE_DEADLINE_MS = 1500;

/** Flatten MCP content blocks into one piece of text. */
export function flattenContent(result: McpCallResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text);
    else if (typeof block.resource?.text === 'string') parts.push(block.resource.text);
    else if (block.type === 'image') parts.push('[an image, which cannot be spoken]');
    else if (block.type === 'audio') parts.push('[an audio clip, which cannot be spoken]');
    else if (typeof block.type === 'string') parts.push(`[${block.type} content]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join('\n').trim();
}

/**
 * Does this read as data rather than prose? A short JSON object is under the
 * size threshold but is still unspeakable, so size alone is not enough.
 */
export function looksStructured(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (/^[[{]/.test(t) && /[\]}]$/.test(t)) return true;
  const lines = t.split('\n');
  // A markdown table: several lines carrying pipes.
  if (lines.filter((l) => (l.match(/\|/g) ?? []).length >= 2).length >= 2) return true;
  // A separator row is conclusive.
  if (/^\s*\|?[\s:-]*-{3,}[\s:|-]*$/m.test(t)) return true;
  // Key: value on most lines, as in a dumped record.
  if (lines.length >= 4 && lines.filter((l) => /^\s*"?[\w.-]+"?\s*[:=]/.test(l)).length >= lines.length * 0.6) {
    return true;
  }
  // Punctuation-dense, the signature of serialised data.
  const punct = (t.match(/[{}[\]":,]/g) ?? []).length;
  if (punct / t.length > 0.08) return true;
  return false;
}

/** Cut to a sentence boundary where possible, never mid-word. */
export function truncateSpoken(text: string, max: number = SPOKEN_MAX_CHARS): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const slice = t.slice(0, max - 1);
  const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (sentence > max * 0.4) return slice.slice(0, sentence + 1);
  const word = slice.lastIndexOf(' ');
  return `${(word > 0 ? slice.slice(0, word) : slice).trimEnd()}...`;
}

export const SHAPER_SYSTEM_PROMPT = [
  'You turn a tool result into one or two sentences for a voice assistant to say out loud.',
  'Rules: use only facts present in the result - never add, infer or round anything.',
  'No JSON, no markdown, no lists, no field names, no URLs. Spell out what a person would say.',
  'If the result is empty or says nothing was found, say exactly that.',
  'If the result holds more items than you can say, give the count and the first two or three.',
  'Answer in at most 600 characters. Plain sentences only.',
].join(' ');

export function buildShaperUserPrompt(toolName: string, text: string, question?: string): string {
  const parts = [`Tool: ${toolName}`];
  if (question && question.trim() !== '') parts.push(`The person asked: ${question.trim()}`);
  parts.push(`Result:\n${text}`);
  return parts.join('\n');
}

/**
 * Shape one MCP tool result.
 *
 * Local first, always. The extractive answer is computed before the Gateway is
 * asked anything, and the Gateway then has `refineDeadlineMs` to beat it. It
 * cannot delay speech past that deadline, cannot fail a turn, and is not asked
 * at all while `shaperAvailable()` says no - which is how the server's circuit
 * breaker keeps a rate-limited Gateway out of the path for a minute at a time.
 *
 * Never throws.
 */
export async function shapeResult(
  toolName: string,
  result: McpCallResult,
  opts: {
    shaper?: Shaper;
    /** Consulted before every call; false skips the Gateway without waiting. */
    shaperAvailable?: () => boolean;
    question?: string;
    maxChars?: number;
    shapeOverChars?: number;
    refineDeadlineMs?: number;
  } = {},
): Promise<ShapeResult> {
  const maxChars = opts.maxChars ?? SPOKEN_MAX_CHARS;
  const shapeOver = opts.shapeOverChars ?? SHAPE_OVER_CHARS;
  const deadline = opts.refineDeadlineMs ?? REFINE_DEADLINE_MS;
  const raw = flattenContent(result);
  const isError = result.isError === true;

  const base = { raw, rawChars: raw.length, isError, refineMs: 0 };
  const done = (spoken: string, method: string, shaped: boolean, refine: RefineOutcome, refineMs = 0, asError = false): ShapeResult => ({
    ...base,
    result: JSON.stringify(asError ? { error: spoken } : { result: spoken }),
    spoken,
    shaped,
    method,
    refine,
    refineMs,
    spokenChars: spoken.length,
  });

  if (raw === '') {
    const spoken = isError ? 'The tool reported an error but gave no detail.' : 'The tool returned nothing.';
    return done(spoken, 'empty', false, 'not_needed', 0, isError);
  }

  // An error is short and the model reads it verbatim, so keep the server's own
  // words: the docs want the failing field named, not a paraphrase.
  if (isError) {
    const spoken = truncateSpoken(raw, maxChars);
    return done(spoken, spoken === raw ? 'passthrough' : 'truncated', spoken !== raw, 'not_needed', 0, true);
  }

  if (!(raw.length > shapeOver || looksStructured(raw))) {
    const spoken = truncateSpoken(raw, maxChars);
    return done(spoken, spoken === raw ? 'passthrough' : 'truncated', false, 'not_needed');
  }

  // Local first. Everything after this line can only replace it, never delay it
  // past the deadline.
  const local = localShape(raw, opts.question, maxChars);

  if (!opts.shaper) return done(local, 'local', true, 'no_shaper');
  if (opts.shaperAvailable && !opts.shaperAvailable()) return done(local, 'local', true, 'circuit_open');

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), deadline);
  });
  const call = opts
    .shaper({ text: raw, question: opts.question, toolName, maxChars })
    .then((text) => ({ kind: 'ok' as const, text }))
    // A late rejection must not surface as an unhandled one once the race is lost.
    .catch(() => ({ kind: 'error' as const }));

  const outcome = await Promise.race([call, timeout]);
  clearTimeout(timer);
  const refineMs = Date.now() - started;

  if (outcome.kind === 'ok') {
    const spoken = truncateSpoken(outcome.text, maxChars);
    if (spoken !== '') return done(spoken, 'llm', true, 'used', refineMs);
    return done(local, 'local', true, 'error', refineMs);
  }
  return done(local, 'local', true, outcome.kind === 'timeout' ? 'timeout' : 'error', refineMs);
}

/**
 * The local shaping path: the answer every shaped result starts from. JSON is
 * flattened to words first, then the extractive summariser picks the sentences
 * that answer the question.
 */
export function localShape(raw: string, question: string | undefined, maxChars: number): string {
  const flattened = looksJson(raw) ? stripStructure(raw) : raw;
  const extracted = extractiveSummary(flattened, question, maxChars);
  if (extracted.text.trim() !== '') return truncateSpoken(extracted.text, maxChars);
  return truncateSpoken(stripStructure(raw), maxChars);
}

function looksJson(text: string): boolean {
  const t = text.trim();
  return /^[[{]/.test(t) && /[\]}]$/.test(t);
}

/**
 * Last-resort local flattening: pull the human-readable words out of something
 * structured so the fallback is not a wall of braces read aloud.
 */
export function stripStructure(text: string): string {
  let t = text;
  try {
    const parsed: unknown = JSON.parse(t);
    const bits: string[] = [];
    const walk = (node: unknown, depth: number): void => {
      if (depth > 6 || bits.length > 60) return;
      if (typeof node === 'string') { if (node.trim() !== '') bits.push(node.trim()); return; }
      if (typeof node === 'number' || typeof node === 'boolean') { bits.push(String(node)); return; }
      if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') bits.push(`${k.replace(/[_-]+/g, ' ')} ${String(v)}`);
          else walk(v, depth + 1);
        }
      }
    };
    walk(parsed, 0);
    if (bits.length > 0) t = bits.join('. ');
  } catch {
    // Not JSON. Strip markdown table pipes and heading markers instead.
    t = t.replace(/^\s*\|?[\s:-]*-{3,}[\s:|-]*$/gm, ' ').replace(/\|/g, ' ').replace(/^#+\s*/gm, '');
  }
  return t.replace(/\s+/g, ' ').trim();
}
