/**
 * A local, deterministic shaper: turn a wall of tool output into a few spoken
 * sentences, with no network call.
 *
 * This exists because the LLM Gateway is not dependable enough to be the only
 * path. Measured on 2026-09-26 with this account's key, 4 of 6 shaping calls
 * came back `429 "too many requests for this action"`. A demo whose answers
 * degrade into read-aloud markdown two times in three is not a demo, so the
 * local path has to be good on its own and the LLM is the refinement.
 *
 * It is extractive, not abstractive: every sentence it speaks appears in the
 * tool output. Nothing is invented, which is the same guarantee the
 * anti-fabrication clause asks of the agent.
 */

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your',
]);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Strip everything that has no spoken form. URLs read aloud are unusable, and
 * markdown punctuation is noise a TTS voice will either mangle or recite.
 */
export function despeakify(text: string): string {
  return text
    .replace(/<[^>]{1,200}>/g, ' ')                      // html tags
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')           // markdown links, keep the label
    .replace(/\bhttps?:\/\/\S+/gi, ' ')                  // bare URLs
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, ' ')           // addresses
    .replace(/```[\s\S]*?```/g, ' ')                     // fenced code
    .replace(/`([^`]*)`/g, '$1')                         // inline code
    .replace(/^\s*\|?[\s:-]*-{3,}[\s:|-]*$/gm, ' ')      // table rules
    .replace(/\|/g, ' . ')                               // table cells become clauses
    // Metadata labels that search-style MCP servers emit around each record.
    // Dropping the label keeps the prose that follows it.
    //
    // A lookbehind, not a captured prefix: matching the preceding newline would
    // consume it, and the trailing `\s*` then ate the newline the NEXT label
    // needed to match. `Link:` was stripped and `Page:` right after it was not.
    .replace(/(?<![A-Za-z])(Title|Content|Link|Url|URL|Source|Page|Path|Section|Score|Rank)\s*:\s*/g, '')
    .replace(/#{1,6}\s*/g, '')                            // headings, anywhere
    .replace(/\*\*|__|~~|\*/g, '')                        // emphasis
    .replace(/^\s*[-*+]\s+/gm, '')                        // bullets
    .replace(/[{}[\]<>]/g, ' ')
    .replace(/\s*\n\s*/g, ' \n ')
    .replace(/\s+\.\s+\./g, ' .')                        // runs of empty clauses
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Split into sentence-ish units, keeping line breaks as boundaries. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

/** Is this sentence worth saying out loud at all? */
function speakable(s: string): boolean {
  if (s.length < 20) return false;
  const letters = (s.match(/[a-z]/gi) ?? []).length;
  // Mostly punctuation or identifiers: a key dump, a hash, a path.
  if (letters / s.length < 0.6) return false;
  const words = s.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  // Five real words is about where a table cell stops and a sentence starts.
  if (words.length < 5) return false;
  // A leftover table row, which reads as a list of nouns rather than a sentence.
  if ((s.match(/\s\.\s/g) ?? []).length >= 2) return false;
  return true;
}

export type Extracted = { text: string; sentencesUsed: number; sentencesSeen: number };

/**
 * Pick the sentences that answer `question` and fit inside `maxChars`.
 *
 * Scoring: overlap with the question's terms, plus a small bonus for appearing
 * early (tool output tends to lead with its answer) and for rarity across the
 * document, so a phrase repeated in every record does not win on volume alone.
 */
export function extractiveSummary(raw: string, question: string | undefined, maxChars: number): Extracted {
  const cleaned = despeakify(raw);
  const all = sentences(cleaned);
  const candidates = all.filter(speakable);
  if (candidates.length === 0) {
    const fallback = cleaned.replace(/\s+/g, ' ').trim().slice(0, maxChars);
    return { text: fallback, sentencesUsed: 0, sentencesSeen: all.length };
  }

  const q = new Set(question ? terms(question) : []);
  // Document frequency, so boilerplate repeated in every record is discounted.
  const df = new Map<string, number>();
  for (const s of candidates) {
    for (const t of new Set(terms(s))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = candidates.length;

  const scored = candidates.map((s, i) => {
    const ts = terms(s);
    if (ts.length === 0) return { s, i, score: 0 };
    let hit = 0;
    let weight = 0;
    for (const t of new Set(ts)) {
      const rarity = Math.log(1 + n / (df.get(t) ?? 1));
      weight += rarity;
      if (q.has(t)) hit += rarity;
    }
    // Overlap dominates; rarity and position break ties.
    const overlap = q.size > 0 ? hit / Math.max(weight, 1e-6) : 0;
    const position = 1 / (1 + i * 0.06);
    const density = weight / Math.max(ts.length, 1);
    return { s, i, score: overlap * 3 + position * 0.8 + density * 0.2 };
  });

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i));

  const chosen: Array<{ s: string; i: number }> = [];
  let used = 0;
  const seen = new Set<string>();
  for (const c of scored) {
    const key = c.s.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;              // the same line from several records
    const cost = used === 0 ? c.s.length : c.s.length + 1;
    if (used + cost > maxChars) {
      if (used > 0) continue;
      chosen.push({ s: c.s.slice(0, maxChars), i: c.i });
      used = maxChars;
      break;
    }
    seen.add(key);
    chosen.push({ s: c.s, i: c.i });
    used += cost;
    if (chosen.length >= 4) break;            // more than four is not a spoken answer
  }

  // Read them back in document order, so the result still reads as prose.
  chosen.sort((a, b) => a.i - b.i);
  return {
    text: chosen.map((c) => ensureStop(c.s)).join(' ').replace(/\s+/g, ' ').trim(),
    sentencesUsed: chosen.length,
    sentencesSeen: all.length,
  };
}

function ensureStop(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}
