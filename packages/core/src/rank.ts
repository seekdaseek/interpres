/**
 * BM25-lite keyword ranking over a tool catalog.
 *
 * No embeddings: a spoken query is short, the corpus is one MCP server's tool
 * list (tens of documents), and an embedding model would add a network hop and
 * a dependency to a path that runs while the caller is waiting.
 */
import type { ConvertedTool } from './types.ts';
import { humanise } from './convert.ts';

const K1 = 1.2;
const B = 0.75;

/** Field weights. A hit in the tool's name means more than one in its prose. */
const W_NAME = 3;
const W_TITLE = 2;
const W_DESC = 1;

/** Added in proportion to how much of the query the tool's name covers. */
const NAME_COVERAGE_BONUS = 4;

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from', 'how', 'i',
  'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'the', 'this', 'to', 'want',
  'was', 'what', 'when', 'where', 'which', 'with', 'you', 'your',
]);

export function tokenize(text: string): string[] {
  return humanise(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * A very light stemmer: plurals and common verb endings.
 *
 * The final trailing-`e` strip is what makes the family agree. Without it
 * "dispute" keeps its `e` while "disputed" loses `ed` to become "disput", so a
 * caller saying "dispute" would not match a tool whose text says "disputed".
 * Dropping the `e` last sends dispute / disputes / disputed all to "disput".
 */
export function stem(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 4 && t.endsWith('ses')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  else if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

type Doc = {
  tool: ConvertedTool;
  /** Weighted term presence, one contribution per field. */
  tf: Map<string, number>;
  length: number;
  /** Stemmed terms appearing in the tool's own name. */
  nameTerms: Set<string>;
};

export type RankedTool = { tool: ConvertedTool; score: number };

function buildDoc(t: ConvertedTool): Doc {
  // Presence per field, not raw frequency. These "documents" are a name and a
  // paragraph, and a description that happens to say "dispute" five times must
  // not outrank the tool actually called `dispute`. Each field contributes its
  // weight once per term, so a precise name match always beats incidental prose.
  const fields: Array<[text: string, weight: number]> = [
    [`${t.report.mcpName} ${t.tool.name}`, W_NAME],
    [t.tool.description, W_DESC],
  ];
  const props = t.tool.parameters.properties ?? {};
  const propWords: string[] = [];
  for (const [key, schema] of Object.entries(props)) {
    propWords.push(key);
    if (Array.isArray(schema.enum)) {
      for (const v of schema.enum) if (typeof v === 'string') propWords.push(v);
    }
  }
  if (propWords.length > 0) fields.push([propWords.join(' '), W_TITLE]);

  const tf = new Map<string, number>();
  let length = 0;
  for (const [text, weight] of fields) {
    const present = new Set(tokenize(text).map(stem));
    for (const term of present) {
      tf.set(term, (tf.get(term) ?? 0) + weight);
      length += weight;
    }
  }
  const nameTerms = new Set(tokenize(`${t.report.mcpName} ${t.tool.name}`).map(stem));
  return { tool: t, tf, length: Math.max(length, 1), nameTerms };
}

/**
 * Rank a catalog against a spoken query. Returns every tool, best first, so the
 * caller decides how many to reveal.
 */
export function rankTools(catalog: ConvertedTool[], query: string): RankedTool[] {
  const docs = catalog.map(buildDoc);
  const n = docs.length;
  if (n === 0) return [];
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / n;

  const terms = [...new Set(tokenize(query).map(stem))];
  if (terms.length === 0) return docs.map((d) => ({ tool: d.tool, score: 0 }));

  const df = new Map<string, number>();
  for (const term of terms) {
    df.set(term, docs.filter((d) => d.tf.has(term)).length);
  }

  const ranked = docs.map((d) => {
    let score = 0;
    for (const term of terms) {
      const f = d.tf.get(term);
      if (!f) continue;
      const dfT = df.get(term) ?? 0;
      // Standard BM25 idf, floored: a term in every document still counts for
      // a little rather than going negative and penalising a genuine match.
      const idf = Math.max(Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5)), 0.05);
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.length / avgLen))));
    }
    // How much of the query the tool's own name accounts for. "post a job"
    // fully covers `post_job`; a tool that merely mentions jobs covers none.
    const covered = terms.filter((t) => d.nameTerms.has(t)).length;
    score += NAME_COVERAGE_BONUS * (covered / terms.length);
    return { tool: d.tool, score };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable and deterministic: the sweep and the tests must not depend on the
    // order the server happened to list its tools in.
    return a.tool.report.mcpName.localeCompare(b.tool.report.mcpName);
  });
  return ranked;
}
