/**
 * JSON Schema normalisation for the Voice Agent API.
 *
 * The Voice Agent API passes `parameters` to its LLM verbatim and does NOT
 * validate it (voice-agent-api.yaml: "The server does NOT validate the schema
 * at `session.update` time, so a malformed schema is accepted but produces
 * unpredictable tool calls. Validate your schema before sending."). So a bad
 * conversion fails silently at runtime, which is why this module is pure and
 * fully unit-tested.
 *
 * Three transforms, in this order:
 *   1. resolve local `$ref` pointers against `$defs` / `definitions`
 *   2. merge `allOf` members
 *   3. collapse `anyOf` / `oneOf` unions, unwrapping the `[T, null]` optional
 *      that Pydantic and Zod emit for every optional field
 *
 * Then prune to the keywords that help a voice model and drop the rest.
 */
import type { JsonSchema } from './types.ts';

/** Keywords we carry through to the Voice Agent API. */
const KEEP = new Set([
  'type',
  'description',
  'enum',
  'const',
  'format',
  'examples',
  'default',
  'pattern',
  'properties',
  'required',
  'items',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);

/**
 * Keywords we drop deliberately.
 *  - `title`: Pydantic puts one on every property ("Buyer Address"), which
 *    just repeats the property name and costs prompt tokens.
 *  - `$schema`, `$defs`, `definitions`: structural, consumed by resolution.
 *  - `additionalProperties`: no effect on how the model reads the schema.
 *  - `execution`: a non-standard field seen on AssemblyAI's own docs server.
 * Anything not in KEEP is dropped anyway; this list exists so the intent is
 * visible and so `droppedKeywords` can report only the interesting ones.
 */
const KNOWN_DROP = new Set([
  'title',
  '$schema',
  '$defs',
  'definitions',
  'additionalProperties',
  'execution',
  '$ref',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'discriminator',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
  'nullable',
]);

export type NormaliseCounters = {
  refsResolved: number;
  allOfFlattened: number;
  unionsCollapsed: number;
  nullableUnwrapped: number;
  warnings: string[];
};

export function newCounters(): NormaliseCounters {
  return { refsResolved: 0, allOfFlattened: 0, unionsCollapsed: 0, nullableUnwrapped: 0, warnings: [] };
}

/** Resolve a local JSON Pointer like `#/$defs/Foo` against the root schema. */
function resolvePointer(root: JsonSchema, ref: string): JsonSchema | undefined {
  // Only local pointers. A remote `$ref` would be an outbound fetch driven by
  // a user-supplied URL, which is exactly what the SSRF guard exists to stop.
  if (!ref.startsWith('#')) return undefined;
  const path = ref.slice(1).split('/').filter(Boolean);
  let node: unknown = root;
  for (const rawSeg of path) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
    if (node === undefined) return undefined;
  }
  return typeof node === 'object' && node !== null ? (node as JsonSchema) : undefined;
}

function isNullBranch(s: JsonSchema): boolean {
  if (s.type === 'null') return true;
  if (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === 'null') return true;
  return false;
}

/** Does this schema carry anything beyond a bare `type`? */
function isBareType(s: JsonSchema): boolean {
  const keys = Object.keys(s).filter((k) => k !== 'type');
  return keys.length === 0;
}

/**
 * Merge `src` into `dst` without letting a later member silently overwrite an
 * earlier member's description or enum.
 */
function mergeInto(dst: JsonSchema, src: JsonSchema): void {
  for (const [k, v] of Object.entries(src)) {
    if (k === 'properties') {
      dst.properties = { ...(dst.properties ?? {}), ...(v as Record<string, JsonSchema>) };
    } else if (k === 'required') {
      const merged = new Set([...(dst.required ?? []), ...((v as string[]) ?? [])]);
      dst.required = [...merged];
    } else if (dst[k] === undefined) {
      dst[k] = v;
    }
  }
}

/**
 * Normalise one schema node: resolve refs, flatten allOf, collapse unions,
 * then prune. `root` is the schema the pointers are relative to.
 *
 * `seen` holds the `$ref` strings on the current resolution path, so a cyclic
 * `$ref` is broken rather than followed forever.
 */
export function normaliseSchema(
  node: JsonSchema | undefined,
  root: JsonSchema,
  counters: NormaliseCounters,
  opts: { maxDepth: number; depth?: number; seen?: ReadonlySet<string> } = { maxDepth: 12 },
): JsonSchema {
  const depth = opts.depth ?? 0;
  const seen = opts.seen ?? new Set<string>();
  const maxDepth = opts.maxDepth;

  if (node === undefined || node === null || typeof node !== 'object') return {};
  if (depth > maxDepth) {
    counters.warnings.push(`schema deeper than ${maxDepth} levels; truncated to {type:"object"}`);
    return { type: 'object' };
  }

  let s: JsonSchema = { ...node };

  // 1. $ref
  if (typeof s.$ref === 'string') {
    const ref = s.$ref;
    if (seen.has(ref)) {
      counters.warnings.push(`cyclic $ref ${ref}; replaced with {type:"object"}`);
      return { type: 'object' };
    }
    const target = resolvePointer(root, ref);
    if (target === undefined) {
      counters.warnings.push(`unresolvable $ref ${ref}; replaced with {type:"object"}`);
      const { $ref: _drop, ...rest } = s;
      return normaliseSchema({ type: 'object', ...rest }, root, counters, {
        maxDepth,
        depth: depth + 1,
        seen,
      });
    }
    counters.refsResolved++;
    const { $ref: _drop, ...siblings } = s;
    // Siblings of a $ref (a description on the property, say) win over the
    // target's own, because they are local to the use site.
    return normaliseSchema({ ...target, ...siblings }, root, counters, {
      maxDepth,
      depth: depth + 1,
      seen: new Set([...seen, ref]),
    });
  }

  // 2. allOf
  if (Array.isArray(s.allOf) && s.allOf.length > 0) {
    const members = s.allOf;
    const { allOf: _drop, ...base } = s;
    const merged: JsonSchema = { ...base };
    for (const member of members) {
      const m = normaliseSchema(member, root, counters, { maxDepth, depth: depth + 1, seen });
      mergeInto(merged, m);
      counters.allOfFlattened++;
    }
    s = merged;
  }

  // 3. anyOf / oneOf
  const union = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined;
  if (union && union.length > 0) {
    const { anyOf: _a, oneOf: _o, ...base } = s;
    const nonNull = union.filter((b) => !isNullBranch(b));
    const hadNull = nonNull.length !== union.length;

    if (nonNull.length === 0) {
      // Union of nothing but null. Nothing a voice model can fill in.
      counters.unionsCollapsed++;
      s = { ...base, type: 'string' };
      counters.warnings.push('union contained only null branches; treated as string');
    } else if (nonNull.length === 1) {
      // The Pydantic/Zod optional: anyOf: [T, {type: "null"}].
      const only = nonNull[0]!;
      if (hadNull) counters.nullableUnwrapped++;
      else counters.unionsCollapsed++;
      const inner = normaliseSchema(only, root, counters, { maxDepth, depth: depth + 1, seen });
      // Base wins: the property's own description beats the branch's.
      s = { ...inner, ...base };
      // ...except a bare branch type must not be shadowed by nothing.
      if (base.type === undefined && inner.type !== undefined) s.type = inner.type;
      // Pydantic pairs `anyOf: [T, null]` with `default: null`. Once null is
      // gone that default contradicts the type it sits on, and the model is
      // being shown a value it is not allowed to send.
      if (hadNull && s.default === null) delete s.default;
    } else {
      // A real union. The API hands `parameters` straight to its LLM, and a
      // union of object shapes reliably produces arguments that match none of
      // them. Collapse to a single concrete shape instead.
      counters.unionsCollapsed++;
      const branches = nonNull.map((b) =>
        normaliseSchema(b, root, counters, { maxDepth, depth: depth + 1, seen }),
      );
      const types = new Set(branches.map((b) => (typeof b.type === 'string' ? b.type : undefined)));
      if (types.size === 1 && !types.has(undefined)) {
        // Same type throughout: merge the branches, union their enums.
        const merged: JsonSchema = { ...base, type: [...types][0] as string };
        const enums: unknown[] = [];
        for (const b of branches) {
          if (Array.isArray(b.enum)) enums.push(...b.enum);
          mergeInto(merged, b);
        }
        if (enums.length > 0) merged.enum = [...new Set(enums)];
        s = merged;
      } else {
        // Mixed types: take the first branch that carries real structure,
        // and say so in the description so the model is not misled.
        const pick = branches.find((b) => !isBareType(b)) ?? branches[0]!;
        const alt = [...types].filter(Boolean).join(' or ');
        s = { ...pick, ...base };
        if (base.type === undefined && pick.type !== undefined) s.type = pick.type;
        const note = `Accepts ${alt}; send ${String(s.type ?? 'a value')}.`;
        s.description = s.description ? `${s.description} ${note}` : note;
        counters.warnings.push(`mixed-type union (${alt}) collapsed to ${String(s.type)}`);
      }
    }
  }

  // 4. recurse into structure
  if (s.properties && typeof s.properties === 'object') {
    const out: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(s.properties)) {
      out[k] = normaliseSchema(v, root, counters, { maxDepth, depth: depth + 1, seen });
    }
    s.properties = out;
  }
  if (s.items !== undefined) {
    if (Array.isArray(s.items)) {
      // Tuple form. A voice model cannot reliably fill positional tuples, so
      // keep only the first item shape and note it.
      const first = s.items[0];
      s.items = first ? normaliseSchema(first, root, counters, { maxDepth, depth: depth + 1, seen }) : {};
      counters.warnings.push('tuple-form items reduced to its first element schema');
    } else {
      s.items = normaliseSchema(s.items, root, counters, { maxDepth, depth: depth + 1, seen });
    }
  }

  // 5. prune
  const pruned: JsonSchema = {};
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k)) continue;
    if (v === undefined) continue;
    pruned[k] = v;
  }
  // `required` entries that name a property we no longer have would make the
  // model hunt for a field that is not in the schema.
  if (Array.isArray(pruned.required) && pruned.properties) {
    const have = new Set(Object.keys(pruned.properties));
    const kept = pruned.required.filter((r) => have.has(r));
    if (kept.length !== pruned.required.length) {
      counters.warnings.push('dropped required entries naming absent properties');
    }
    if (kept.length > 0) pruned.required = kept;
    else delete pruned.required;
  } else if (Array.isArray(pruned.required) && !pruned.properties) {
    delete pruned.required;
  }
  return pruned;
}

/** Keywords dropped from a node, for reporting. Only the notable ones. */
export function notableDroppedKeywords(node: JsonSchema): string[] {
  return Object.keys(node).filter((k) => !KEEP.has(k) && KNOWN_DROP.has(k));
}

/**
 * The Voice Agent API requires `parameters` to be a JSON Schema *object*
 * (`{"type": "object", "properties": {...}, "required": [...]}`). A tool with
 * no arguments still needs that shape.
 */
export function asParametersObject(s: JsonSchema): JsonSchema {
  const out: JsonSchema = { type: 'object', properties: s.properties ?? {} };
  if (Array.isArray(s.required) && s.required.length > 0) out.required = s.required;
  return out;
}
