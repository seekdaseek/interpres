/**
 * Pulling the values a caller spoke - addresses, IDs, long numbers - out of a
 * transcript, so they can be carried across a phase change.
 *
 * Why this exists. The Aug 26 changelog says tool calls "infer argument values
 * only from user turns and tool results". A `find_tools` round trip puts a tool
 * result and a new system prompt between the caller's words and the tool that
 * finally needs them. Carrying the values forward explicitly - into the
 * `find_tools` result, which is a documented inference source, and into
 * `keyterms` / `transcription_prompt` in case the caller has to say them again -
 * means the revealed tool does not have to reach back past the swap for them.
 *
 * Speech-to-text writes spelled-out hex in more than one way ("0x5aaeb605...",
 * "0 x 5 a a e b 6 0 5..."), so spaced forms are collapsed before matching.
 */

/** A carried value must be short enough to be a real identifier. */
export const MAX_ENTITY_CHARS = 66;
export const MAX_ENTITIES = 5;

/**
 * Collapse "0 x 5 a a e b" into "0x5aaeb": a hex value read one character at a
 * time. Only after an explicit `0x`, so ordinary prose is never glued together.
 */
export function collapseSpokenHex(text: string): string {
  return text.replace(/\b0\s*x((?:\s*[0-9a-f]){4,})/gi, (_m, rest: string) => `0x${rest.replace(/\s+/g, '')}`);
}

/**
 * Identifier-like values in a transcript, most specific first:
 *   - hex values after `0x` (wallet addresses, hashes)
 *   - tokens mixing letters and digits (AB-12345, ORD7781)
 *   - runs of four or more digits (order numbers, account numbers)
 *
 * Anything longer than `MAX_ENTITY_CHARS` is refused rather than carried. A
 * speech-to-text repetition loop produced a 900-character run of zeros from a
 * 42-character address on 2026-09-26; forwarding that into keyterms would bias
 * the next attempt toward the same garbage.
 */
export function extractEntities(transcript: string): string[] {
  if (!transcript) return [];
  const text = collapseSpokenHex(transcript);
  const found: string[] = [];
  const add = (v: string) => {
    const t = v.replace(/[.,;:!?)]+$/, '');
    if (t.length < 4 || t.length > MAX_ENTITY_CHARS) return;
    if (!found.some((f) => f.toLowerCase() === t.toLowerCase())) found.push(t);
  };

  for (const m of text.matchAll(/\b0x[0-9a-f]+\b/gi)) add(m[0]);
  for (const m of text.matchAll(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g)) {
    if (/^0x/i.test(m[0])) continue;                  // already taken as hex
    add(m[0]);
  }
  for (const m of text.matchAll(/\b\d{4,}\b/g)) {
    if (found.some((f) => f.includes(m[0]))) continue; // part of something longer
    add(m[0]);
  }
  return found.slice(0, MAX_ENTITIES);
}
