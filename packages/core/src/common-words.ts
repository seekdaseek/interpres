/**
 * Common English words, for keeping them OUT of `input.keyterms`.
 *
 * The docs are explicit: "Don't add common English words. Each entry boosts that
 * string, and adding common words at the same weight as your rare terms dilutes
 * the boost." The recogniser already knows these; boosting them spends the
 * 100-term budget on nothing.
 *
 * Two lists:
 * - `ENGLISH_10K`: the 10,000 most frequent English words, by count over English
 *   Wikipedia (MIT licence, see english-10k.ts). A frequency list carries
 *   frequent inflections in their own right ("services", "recommended"), so a
 *   word counts only as written: "advisors" (#11,490) is not common even though
 *   "advisor" (#4,269) is.
 * - `TOOL_WORDS`: the everyday vocabulary tool names are built from (get, list,
 *   check, site, order, webhook...), in base forms, so its plurals and simple
 *   inflections count too.
 */
import { ENGLISH_10K } from './english-10k.ts';

const TOOL_WORDS_TEXT = `
account accounts active add admin agent alert all api app apply archive args array asset assets auth author backup basics
batch bill billing body bool branch browse buffer build cache calendar cancel catalog category channel chat child
client cloud comment config connect connection contact content context contract convert count create credit custom customer
dashboard database dataset debug delete deploy description details device dict directory disable doc docs document
domain done download draft edit email enable endpoint entry error errors estimate export extract feature feed fetch
field fields filter find flag folder format forward get guide handle hash header history host hub id ids import index
input insert install instance integration invoice issue items keyword label latest launch layer lookup match max media
merge meta metadata min mode module monitor name names network node note notes notify object open operation output
owner package page params parse patch payment pending permission ping plan platform plugin post preview profile
project prompt property query queue quote range rank read reads record records refresh register release reply repo
resource response results review role route row rows run save schedule schema scope score script send server
session setting settings setup show sign snapshot sort source spec start stat stats status stop store stream string
submit summary sync tag tags target template text thread ticket timeline title token tool tools topic track update
upload url usage user users validate value values version video view watch web webhook widget word workflow write
`;

const FREQUENT: ReadonlySet<string> = new Set(ENGLISH_10K.split(/\s+/).filter(Boolean));
const TOOL_WORDS: ReadonlySet<string> = new Set(TOOL_WORDS_TEXT.split(/\s+/).filter(Boolean));

export const COMMON_WORDS: ReadonlySet<string> = new Set([...FREQUENT, ...TOOL_WORDS]);

/**
 * Among the 10,000 most frequent words as written, or a tool-name word, its
 * plural or a simple inflection: "services" counts as "service", "signed" as
 * "sign", "created" as "create", "listing" as "list".
 */
export function isCommonWord(word: string): boolean {
  const w = word.toLowerCase();
  if (w.length > 1 && FREQUENT.has(w)) return true;
  const has = (x: string) => x.length > 1 && TOOL_WORDS.has(x);
  if (has(w)) return true;
  if (w.endsWith('ies') && has(`${w.slice(0, -3)}y`)) return true;
  if (w.endsWith('es') && has(w.slice(0, -2))) return true;
  if (w.endsWith('s') && has(w.slice(0, -1))) return true;
  if (w.endsWith('ed') && (has(w.slice(0, -2)) || has(w.slice(0, -1)))) return true;
  if (w.endsWith('ing') && (has(w.slice(0, -3)) || has(`${w.slice(0, -3)}e`))) return true;
  return false;
}
