/**
 * Deciding whether a JSON Schema `pattern` is safe to pass to the Voice Agent
 * API, and normalising spoken argument values before `tools/call`.
 *
 * The rule comes from the docs (tools/overview, "Spoken digit sequences"):
 *
 *   - `pattern` is a Python regex matched against the WHOLE value, so `^`/`$`
 *     are redundant.
 *   - It is matched against the value **as the agent produces it**. The agent's
 *     cleanup is "reliable for well-known shapes (phone numbers, emails,
 *     dates), but for long or free-form digit sequences - card numbers,
 *     account numbers, claim IDs - the value can reach your tool as it was
 *     spoken": `"4 2 4 2 ..."` or `"4242 4242 ..."`.
 *   - "A pattern that only accepts the tidy form (`^\d{16}$`) will reject the
 *     spaced form and trap the caller in a re-ask loop."
 *
 * So the danger is narrow: a pattern that insists on a LONG CONTIGUOUS run of
 * digits and makes no allowance for spaces. The docs' own "good values" table
 * keeps patterns for US ZIP (`\d{5}(-\d{4})?`), E.164 phone
 * (`\+[1-9]\d{1,14}`), order ID (`[A-Z]{2}-\d{5}`) and ISO date
 * (`\d{4}-\d{2}-\d{2}`) - none of which demand a long unbroken run - and flags
 * only the 13-19 digit card case. Counting total digits in the value would
 * wrongly condemn ZIP+4 (9 digits) and E.164 (up to 15), so we count the
 * longest run instead.
 *
 * Where a property gives `examples`, we do not infer any of this from the
 * pattern text: we build the spoken variants and run the regex against them.
 */
import type { NormaliserId, PatternVerdict } from './types.ts';

/** Digits in a value, ignoring everything else. */
function digitsOf(s: string): string {
  return s.replace(/\D+/g, '');
}

/** Longest run of consecutive digits in a literal value. */
export function longestDigitRun(s: string): number {
  let best = 0;
  for (const run of s.match(/\d+/g) ?? []) best = Math.max(best, run.length);
  return best;
}

/**
 * How long an unbroken digit run must be before spoken spacing is a real risk.
 *
 * Below this, the docs call the agent's cleanup reliable (phone numbers, ZIPs,
 * dates, order IDs). At and above it we are in the card / account / claim-ID
 * territory the docs warn about; their example is 13-19.
 */
export const DIGIT_RUN_RISK_THRESHOLD = 10;

/** Spoken variants of a tidy value: per-digit spaced, and grouped. */
export function spokenVariants(tidy: string): string[] {
  const d = digitsOf(tidy);
  if (d.length === 0) return [];
  const out = new Set<string>();
  out.add(d.split('').join(' '));
  out.add((d.match(/.{1,4}/g) ?? []).join(' '));
  out.add((d.match(/.{1,3}/g) ?? []).join(' '));
  return [...out].filter((v) => v !== tidy);
}

/**
 * Compile a Python-flavoured pattern as a JS regex anchored over the whole
 * value, matching the documented Python `re.fullmatch` semantics.
 *
 * The constructs that appear in tool schemas (character classes, quantifiers,
 * groups, alternation, `\d` `\w` `\s`) mean the same thing in both engines.
 * Anything JS cannot compile we treat as unverifiable rather than guess at.
 */
export function compileWholeValue(pattern: string): RegExp | null {
  let p = pattern;
  if (p.startsWith('^')) p = p.slice(1);
  if (p.endsWith('$') && !p.endsWith('\\$')) p = p.slice(0, -1);
  try {
    return new RegExp(`^(?:${p})$`, 'u');
  } catch {
    try {
      return new RegExp(`^(?:${p})$`);
    } catch {
      return null;
    }
  }
}

/**
 * The longest unbroken digit run the pattern *insists* on, read off the lower
 * bound of its quantifiers.
 *
 * Lower bound, not upper, is what matters: `\d{1,14}` insists on one digit and
 * happily takes a separator-rich value, while `\d{16}` insists on sixteen in a
 * row. That single choice is what keeps E.164 safe and catches the card case.
 */
export function declaredDigitRun(pattern: string): number {
  let max = 0;
  const digitAtom = String.raw`(?:\\d|\[0-9\]|\[\\d\])`;
  for (const m of pattern.matchAll(new RegExp(`${digitAtom}\\{(\\d+)(?:,(\\d+)?)?\\}`, 'g'))) {
    const lo = Number(m[1]);
    if (Number.isFinite(lo)) max = Math.max(max, lo);
  }
  // A run of separate single-digit atoms, e.g. \d\d\d\d\d\d\d\d\d\d.
  for (const run of pattern.match(new RegExp(`(?:${digitAtom}){2,}`, 'g')) ?? []) {
    const count = (run.match(new RegExp(digitAtom, 'g')) ?? []).length;
    max = Math.max(max, count);
  }
  // Quantified digit atoms written back to back with nothing between them, as
  // in \d{4}\d{4}\d{4}\d{4}: sixteen in a row, spelled four ways. A separator
  // such as the dash in \d{3}-\d{4} breaks the chain, which is correct - the
  // caller has somewhere to breathe.
  const chain = new RegExp(`(?:${digitAtom}\\{\\d+(?:,\\d*)?\\}){2,}`, 'g');
  for (const seq of pattern.match(chain) ?? []) {
    let sum = 0;
    for (const m of seq.matchAll(new RegExp(`${digitAtom}\\{(\\d+)(?:,(\\d*))?\\}`, 'g'))) {
      sum += Number(m[1]) || 0;
    }
    max = Math.max(max, sum);
  }
  return max;
}

/** Does the pattern make any allowance for whitespace inside the value? */
export function allowsInteriorSpace(pattern: string): boolean {
  if (/\\s/.test(pattern)) return true;
  // A literal space followed by a quantifier, as in the docs' ` *([0-9] *){13,19}`.
  if (/ [*?+]/.test(pattern)) return true;
  if (/\\x20|\\u0020/.test(pattern)) return true;
  // A space inside a character class.
  for (const cls of pattern.match(/\[[^\]]*\]/g) ?? []) if (/ /.test(cls)) return true;
  return false;
}

/**
 * Judge one `pattern`, given the property's `examples` (already stringified).
 *
 * Returns `kept` when the pattern is safe to forward, or `kept: false` with a
 * reason and the normaliser to apply to incoming values instead.
 */
export function judgePattern(pattern: string, examples: string[] = []): PatternVerdict {
  const re = compileWholeValue(pattern);
  if (re === null) {
    return {
      kept: false,
      pattern,
      reason: 'pattern does not compile as a regex, so it cannot be verified',
    };
  }

  // The docs are explicit: "Make every value in `examples` match the pattern;
  // if you can't, loosen the pattern, not the examples." A pattern that
  // rejects its own example is already broken, whatever the value looks like.
  for (const ex of examples) {
    if (!re.test(ex)) {
      return {
        kept: false,
        pattern,
        reason: `pattern rejects its own example ${JSON.stringify(ex)}`,
        ...(longestDigitRun(ex) >= DIGIT_RUN_RISK_THRESHOLD
          ? { normaliser: 'strip_non_digits' as NormaliserId }
          : {}),
      };
    }
  }

  // The gate is what the pattern INSISTS on, not how long an example happens to
  // be. `\+[1-9]\d{1,14}` insists on a single digit, so E.164 stays - which is
  // what the docs' "good values" table requires - while `\d{16}` insists on
  // sixteen in a row and does not.
  const declared = declaredDigitRun(pattern);
  if (declared < DIGIT_RUN_RISK_THRESHOLD) return { kept: true, pattern };
  if (allowsInteriorSpace(pattern)) return { kept: true, pattern };

  // Classified risky. If an example is available, name a spoken form the
  // pattern actually rejects, so the reason is measured rather than asserted.
  let evidence = '';
  for (const ex of examples) {
    const rejected = spokenVariants(ex).find((v) => !re.test(v));
    if (rejected !== undefined) {
      evidence = ` (it rejects ${JSON.stringify(rejected)})`;
      break;
    }
  }
  return {
    kept: false,
    pattern,
    reason: `insists on ${declared} consecutive digits with no allowance for spoken spacing${evidence}`,
    normaliser: 'strip_non_digits',
  };
}

/** Apply a normaliser to a value on its way to `tools/call`. */
export function applyNormaliser(id: NormaliserId, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  switch (id) {
    case 'strip_non_digits':
      return value.replace(/\D+/g, '');
    case 'collapse_whitespace':
      return value.replace(/\s+/g, ' ').trim();
    case 'trim':
      return value.trim();
  }
}

/**
 * The sentence appended to a property description when we drop its pattern, so
 * the model still knows the shape even though the API no longer enforces it.
 * Mirrors the docs' advice: describe the value as spoken, strip in the handler.
 */
export function droppedPatternHint(pattern: string): string {
  return `Expected shape: ${pattern} - may be spoken with spaces between digits; spaces are removed before use.`;
}

/**
 * Apply a tool's recorded normalisers to the arguments the agent produced,
 * on the way to `tools/call`.
 *
 * This is the other half of dropping a `pattern`: the API is no longer
 * rejecting a spoken-out card number, so we strip the spaces ourselves, exactly
 * as the docs prescribe ("Then strip non-digits in your tool handler before you
 * use the value"). Paths are dotted, with `[]` for every element of an array.
 */
export function applyNormalisers(
  args: Record<string, unknown>,
  normalisers: ReadonlyArray<{ path: string; normaliser: NormaliserId }>,
): { args: Record<string, unknown>; applied: string[] } {
  if (normalisers.length === 0) return { args, applied: [] };
  // Copied, so a caller's object is never mutated under it.
  const out = structuredClone(args);
  const applied: string[] = [];

  for (const { path, normaliser } of normalisers) {
    const segments = path.split('.');
    const touched = walk(out, segments, 0, (value) => {
      const next = applyNormaliser(normaliser, value);
      return { value: next, changed: next !== value };
    });
    if (touched) applied.push(`${path}:${normaliser}`);
  }
  return { args: out, applied };
}

function walk(
  node: unknown,
  segments: string[],
  index: number,
  fn: (value: unknown) => { value: unknown; changed: boolean },
): boolean {
  const raw = segments[index];
  if (raw === undefined) return false;
  const isArray = raw.endsWith('[]');
  const key = isArray ? raw.slice(0, -2) : raw;
  if (node === null || typeof node !== 'object') return false;
  const holder = node as Record<string, unknown>;
  if (!(key in holder)) return false;
  const last = index === segments.length - 1;

  if (isArray) {
    const arr = holder[key];
    if (!Array.isArray(arr)) return false;
    let changed = false;
    for (let i = 0; i < arr.length; i++) {
      if (last) {
        const r = fn(arr[i]);
        if (r.changed) { arr[i] = r.value; changed = true; }
      } else if (walk(arr[i], segments, index + 1, fn)) {
        changed = true;
      }
    }
    return changed;
  }

  if (last) {
    const r = fn(holder[key]);
    if (r.changed) { holder[key] = r.value; return true; }
    return false;
  }
  return walk(holder[key], segments, index + 1, fn);
}
