/**
 * Starter questions: three things a person could say to a server they have just
 * connected to. The LLM Gateway writes them at connect time, off the speech
 * path; when it cannot answer, templates built from the tools' own descriptions
 * stand in, and the page says which it got.
 *
 * Only read-only tools feed either one: a starter must never suggest a change.
 */
import { classifyWrite, findIdentifiers, nameTokens, sharedPrefixTokens } from './gate.ts';
import type { McpTool } from './types.ts';

export const STARTER_COUNT = 3;
export const STARTER_MAX_CHARS = 110;

export type StarterTool = {
  name: string;
  description: string;
  /** The name's words after any prefix every tool shares. */
  words: string[];
};

function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const stop = t.search(/[.!?](\s|$)/);
  return stop > 0 ? t.slice(0, stop) : t;
}

/** The catalog's read-only tools, with the first sentence of each description. */
export function readOnlyTools(tools: McpTool[]): StarterTool[] {
  const shared = sharedPrefixTokens(tools.map((t) => t.name));
  return tools
    .filter((t) => !classifyWrite(t, shared).write)
    .map((t) => ({ name: t.name, description: firstSentence(t.description ?? t.title ?? ''), words: nameTokens(t.name).slice(shared) }));
}

export const STARTER_SYSTEM_PROMPT = [
  'You write starter questions for a voice assistant that answers by calling tools.',
  'Write exactly three short questions a person could say out loud to it.',
  'Each question must be answerable by calling one of the listed tools.',
  'Plain spoken English, at most 12 words each, no URLs, no IDs, no quotation marks.',
  'Reply with JSON only: {"questions": ["...", "...", "..."]}',
].join(' ');

export function buildStarterPrompt(serverName: string, instructions: string | undefined, tools: StarterTool[]): string {
  const lines = [`Server: ${serverName}`];
  if (instructions && instructions.trim() !== '') lines.push(`What it says about itself: ${instructions.trim().slice(0, 600)}`);
  lines.push('Tools:');
  for (const t of tools.slice(0, 30)) lines.push(`- ${t.name}: ${t.description.slice(0, 160)}`);
  return lines.join('\n');
}

/** Short, speakable, and nothing a person would have to read out character by character. */
export function usableStarter(q: string): boolean {
  return q.length >= 8 && q.length <= STARTER_MAX_CHARS && !/https?:\/\/|www\./i.test(q) && findIdentifiers(q).length === 0;
}

/** The model's questions when they are usable; null sends the caller to the templates. */
export function parseStarters(content: string): string[] | null {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const qs = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(qs)) return null;
  const good = qs
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim().replace(/^["'“]+|["'”]+$/g, ''))
    .filter(usableStarter);
  return good.length > 0 ? [...new Set(good)].slice(0, STARTER_COUNT) : null;
}

/** "Returns every book..." -> "return every book...": descriptions lead with a verb. */
const THIRD_PERSON: Record<string, string> = {
  returns: 'return', gets: 'get', lists: 'list', searches: 'search', finds: 'find', retrieves: 'retrieve',
  fetches: 'fetch', provides: 'provide', shows: 'show', checks: 'check', gives: 'give', reads: 'read',
  describes: 'describe', explains: 'explain', calculates: 'calculate', converts: 'convert', compares: 'compare',
  counts: 'count', summarizes: 'summarize', summarises: 'summarise', looks: 'look', estimates: 'estimate',
  recommends: 'recommend', suggests: 'suggest', ranks: 'rank', matches: 'match', answers: 'answer',
};
const IMPERATIVE = new Set([...Object.values(THIRD_PERSON), 'search', 'find', 'list', 'get', 'show', 'look']);

function fromDescription(t: StarterTool): string | null {
  // Without asides, and up to the first clause break, it stays sayable.
  const clause = t.description.replace(/\s*\([^)]*\)/g, '').split(/[,:;—–]| - /)[0]!.trim();
  const words = clause.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const first = words[0]!.toLowerCase();
  const verb = THIRD_PERSON[first] ?? (IMPERATIVE.has(first) ? first : null);
  if (verb === null) return null;
  const q = `Can you ${[verb, ...words.slice(1)].join(' ')}?`;
  return usableStarter(q) ? q : null;
}

/** "catalog_list_services" -> "Can you list services?": the name, from its first verb on. */
function fromName(t: StarterTool): string | null {
  const at = t.words.findIndex((w) => IMPERATIVE.has(w));
  if (at < 0 || at === t.words.length - 1) return null;
  const q = `Can you ${t.words.slice(at).join(' ')}?`;
  return usableStarter(q) ? q : null;
}

function templateFor(t: StarterTool): string | null {
  return fromDescription(t) ?? fromName(t);
}

/** Built from the read-only tools' own descriptions, for when the Gateway cannot answer. */
export function templateStarters(tools: StarterTool[]): string[] {
  const out: string[] = [];
  for (const t of tools) {
    const q = templateFor(t);
    if (q !== null && !out.includes(q)) out.push(q);
    if (out.length === STARTER_COUNT) break;
  }
  if (out.length === 0) out.push('What can you do?');
  return out;
}
