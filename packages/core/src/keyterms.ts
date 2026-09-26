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
import { isCommonWord } from './common-words.ts';

export const KEYTERMS_MAX = 100;
export const TRANSCRIPTION_PROMPT_MAX = 1750;

/** Does this look like an identifier rather than prose? */
export function isIdentifierLike(s: string): boolean {
  if (s.length < 2 || s.length > 40) return false;
  if (/\s/.test(s)) return false;
  return /\d/.test(s) || /[A-Z]/.test(s) || /[_\-.:/]/.test(s);
}

/** Written the way speech-to-text writes them. */
const ACRONYMS = new Set([
  'ai', 'api', 'mcp', 'url', 'id', 'ui', 'ux', 'sdk', 'llm', 'sql', 'pdf', 'csv', 'json', 'html', 'http', 'ios', 'gpu',
  'cpu', 'nft', 'dao', 'evm', 'sol', 'btc', 'eth', 'usdc', 'usd', 'eu', 'uk', 'faq', 'crm', 'seo', 'sms', 'otp', 'kyc',
  'rag', 'tts', 'stt', 'afg', 'b2b', 'b2c', 'iot', 'cli', 'ssh', 'dns', 'vpn', 'ocr', 'etl', 'kpi', 'roi', 'sla', 'erp',
]);

/** The docs: "Each individual keyterm string must be 50 characters or less" - longer ones are ignored. */
export const KEYTERM_MAX_CHARS = 50;
/** The docs: "Don't add whole sentences or phrases." A product name of up to three words is kept. */
export const KEYTERM_MAX_WORDS = 3;

const URLISH = /^[a-z][a-z0-9+.-]*:\/\/|^www\./i;
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDER_HOST = /\bexample\.(com|org|net)\b/i;
const HEXISH = /^(0x)?[0-9a-f]{12,}$/i;
const BASE58ISH = /^[1-9A-HJ-NP-Za-km-z]{24,}$/;

/**
 * One raw term -> the form speech-to-text would write, or null to drop it.
 *
 * Dropped: URLs and placeholder hosts, emails, dotted or slashed IDs, hex and
 * base58 strings, anything of two characters or fewer, single common English
 * words, phrases over three words, and anything over 50 characters. A slug of
 * alphabetic parts is spelled out: `store-assistant` -> `store assistant`,
 * `ai-visibility` -> `AI visibility`.
 */
export function speechForm(raw: string): string | null {
  const t = raw.trim();
  if (t === '' || URLISH.test(t) || EMAILISH.test(t) || PLACEHOLDER_HOST.test(t)) return null;
  if (/[/\\]/.test(t) || t.includes('.')) return null;           // dotted or slashed IDs
  if (HEXISH.test(t) || (BASE58ISH.test(t) && /\d/.test(t))) return null;

  let form = t;
  const parts = t.split(/[-_]+/);
  if (parts.length > 1 && parts.every((p) => /^[A-Za-z]+$/.test(p))) {
    form = parts.map((p) => (ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p.toLowerCase())).join(' ');
  }
  const words = form.split(/\s+/);
  if (words.length > KEYTERM_MAX_WORDS || form.length > KEYTERM_MAX_CHARS) return null;
  if (words.length === 1) {
    if (form.length <= 2) return null;
    if (isCommonWord(form)) return null;
  } else if (words.every((w) => w.length <= 2)) {
    return null;
  }
  return form;
}

/**
 * Brand-like tokens from a server's own name, kept verbatim: `AssemblyAI`,
 * `AFG`, `Advisors`. Splitting `AssemblyAI` into "assembly" and "ai" throws
 * away the one spelling the docs themselves use as their keyterm example.
 */
export function brandTokens(label: string | undefined): string[] {
  if (!label) return [];
  const out: string[] = [];
  for (const tok of label.split(/[^A-Za-z0-9]+/)) {
    if (tok.length < 3) continue;
    const brandish = /[a-z][A-Z]/.test(tok) || /^[A-Z0-9]{3,}$/.test(tok);
    if (brandish || !isCommonWord(tok)) out.push(brandish ? tok : tok.toLowerCase());
  }
  return out;
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
 *   1. enum values - product names and fixed choices the caller says literally
 *   2. brand tokens from the server's name and title
 *   3. distinctive words from the tool names
 *   4. short codes from `examples`
 *
 * Every candidate goes through `speechForm`; the result is deduped
 * case-insensitively, first spelling wins, and capped at `max`.
 */
export function buildKeyterms(
  tools: ConvertedTool[],
  server: McpServerInfo | undefined,
  max: number = KEYTERMS_MAX,
): string[] {
  const enumSet: string[] = [];
  const exampleSet: string[] = [];
  for (const t of tools) {
    collectFromSchema(t.tool.parameters, enumSet, 0, 'enum');
    collectFromSchema(t.tool.parameters, exampleSet, 0, 'examples');
  }
  const brands = [...brandTokens(server?.title), ...brandTokens(server?.name)];
  const nameWords: string[] = [];
  for (const t of tools) for (const w of humanise(t.report.mcpName).split(' ')) nameWords.push(w);

  const out: string[] = [];
  const seen = new Set<string>();
  const brandKeys = brands.map((b) => b.toLowerCase());
  for (const raw of [...enumSet, ...brands, ...nameWords, ...exampleSet]) {
    const term = speechForm(raw);
    if (term === null) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    // A fragment of a kept brand adds nothing: "assembly" once "AssemblyAI" is in.
    if (!term.includes(' ') && brandKeys.some((b) => b !== key && b.includes(key))) continue;
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
