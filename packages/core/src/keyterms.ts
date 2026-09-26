/**
 * Building `input.keyterms` and `input.transcription_prompt` from an MCP
 * server's catalog.
 *
 * Both bias speech-to-text toward vocabulary the caller is about to use, and
 * both are mutable mid-session, so the phase planner rebuilds them whenever it
 * changes the visible tools.
 *
 * Documented limits: keyterms is "up to 100 strings", takes effect on the next
 * user utterance; transcription_prompt is "max 1750 characters".
 */
import type { ConvertedTool, JsonSchema, McpServerInfo } from './types.ts';
import { humanise } from './convert.ts';

export const KEYTERMS_MAX = 100;
export const TRANSCRIPTION_PROMPT_MAX = 1750;

/**
 * Words too common to be worth biasing. Boosting "the" costs one of our 100
 * slots and buys nothing.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'call', 'can', 'do', 'for', 'from',
  'get', 'has', 'have', 'in', 'is', 'it', 'its', 'list', 'new', 'no', 'not', 'of', 'on', 'one',
  'or', 'set', 'that', 'the', 'this', 'to', 'up', 'use', 'used', 'with', 'you', 'your', 'all',
  'via', 'per', 'out', 'if', 'when', 'what', 'which', 'only', 'more', 'than', 'then', 'into',
]);

/** Does this look like an identifier rather than prose? */
export function isIdentifierLike(s: string): boolean {
  if (s.length < 2 || s.length > 40) return false;
  if (/\s/.test(s)) return false;
  return /\d/.test(s) || /[A-Z]/.test(s) || /[_\-.:/]/.test(s);
}

function collectFromSchema(
  schema: JsonSchema | undefined,
  into: string[],
  depth = 0,
  which: 'enum' | 'examples' = 'enum',
): void {
  if (!schema || depth > 8) return;
  if (which === 'enum' && Array.isArray(schema.enum)) {
    for (const v of schema.enum) if (typeof v === 'string' && v.trim() !== '') into.push(v);
  }
  if (which === 'examples' && Array.isArray(schema.examples)) {
    for (const v of schema.examples) if (typeof v === 'string' && isIdentifierLike(v)) into.push(v);
  }
  if (schema.properties) {
    for (const v of Object.values(schema.properties)) collectFromSchema(v, into, depth + 1, which);
  }
  if (schema.items && !Array.isArray(schema.items)) {
    collectFromSchema(schema.items, into, depth + 1, which);
  }
}

/**
 * Keyterms for the tools currently visible, in priority order:
 *   1. enum values - the caller says these literally
 *   2. identifier-like examples
 *   3. distinctive words from the tool names
 *   4. distinctive words from the server's name and title
 *
 * Deduped case-insensitively, first spelling wins, capped at `max`.
 */
export function buildKeyterms(
  tools: ConvertedTool[],
  server: McpServerInfo | undefined,
  max: number = KEYTERMS_MAX,
): string[] {
  // Enum values first, then identifier-like examples. An enum value that also
  // looks like an identifier (`code_fix_test_suite_pass`) is still an enum, so
  // the two buckets are filled from the two collectors, not re-sorted by shape.
  const enumSet: string[] = [];
  const exampleSet: string[] = [];
  for (const t of tools) {
    collectFromSchema(t.tool.parameters, enumSet, 0, 'enum');
    collectFromSchema(t.tool.parameters, exampleSet, 0, 'examples');
  }

  const nameWords: string[] = [];
  for (const t of tools) {
    for (const w of humanise(t.report.mcpName).split(' ')) {
      if (w.length >= 3 && !STOPWORDS.has(w)) nameWords.push(w);
    }
  }
  const serverWords: string[] = [];
  for (const raw of [server?.title, server?.name].filter((x): x is string => typeof x === 'string')) {
    for (const w of humanise(raw).split(' ')) {
      if (w.length >= 3 && !STOPWORDS.has(w)) serverWords.push(w);
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of [...enumSet, ...exampleSet, ...nameWords, ...serverWords]) {
    const key = term.toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * `input.transcription_prompt`: a plain-prose hint about what the caller is
 * about to talk about. Capped at 1750 characters, truncated on a word boundary.
 */
export function buildTranscriptionPrompt(
  tools: ConvertedTool[],
  server: McpServerInfo | undefined,
  instructions?: string,
  max: number = TRANSCRIPTION_PROMPT_MAX,
): string {
  const label = (server?.title ?? server?.name ?? 'an MCP server').trim();
  const parts: string[] = [
    `The caller is talking to ${label} by voice.`,
  ];
  if (instructions && instructions.trim() !== '') {
    // The server's own `instructions` from `initialize` describe its domain
    // better than anything we could infer.
    parts.push(instructions.trim().replace(/\s+/g, ' '));
  }
  const actions = tools.map((t) => humanise(t.report.mcpName)).filter(Boolean);
  if (actions.length > 0) {
    parts.push(`Expect requests about: ${actions.join('; ')}.`);
  }
  const joined = parts.join(' ');
  if (joined.length <= max) return joined;
  const slice = joined.slice(0, max - 1);
  const cut = slice.lastIndexOf(' ');
  return (cut > max * 0.5 ? slice.slice(0, cut) : slice).trimEnd();
}
