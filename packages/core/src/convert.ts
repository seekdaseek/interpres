/**
 * MCP tool -> AssemblyAI Voice Agent function tool.
 *
 * This is the whole point of interpres. A Voice Agent `ToolDefinition` requires
 * `type`, `name`, `description` and `parameters` (voice-agent-api.yaml), passes
 * `parameters` to its LLM verbatim, and validates none of it. So every
 * transform here is one the runtime will not catch for us.
 */
import type {
  CatalogConversion,
  CatalogStats,
  ConvertOptions,
  ConvertedTool,
  ConversionFailure,
  JsonSchema,
  McpTool,
  ToolConversionReport,
  VoiceAgentTool,
  ArgumentNormaliser,
  PatternVerdict,
} from './types.ts';
import { newCounters, normaliseSchema, asParametersObject } from './jsonschema.ts';
import { judgePattern, droppedPatternHint } from './spoken.ts';

/**
 * The docs state no charset or length rule for a tool name: the AsyncAPI spec
 * gives `ToolDefinition.name` as a bare `type: string` with no `pattern` and no
 * `maxLength`, and the agent-management validation table names only voice,
 * `http.url` and `timeout_seconds` rules. The only guidance anywhere is a
 * convention - "snake_case, verb-noun".
 *
 * So this is our conservative choice, not a documented limit: the character set
 * every function-calling API we know of accepts, capped at 64.
 */
export const NAME_CHARSET = /[^A-Za-z0-9_-]+/g;
export const NAME_MAX = 64;

export const DEFAULTS = {
  maxDescriptionChars: 1024,
  maxPropertyDescriptionChars: 320,
  maxDepth: 12,
} as const;

/** Truncate on a word boundary, never mid-word, and say that it happened. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const ELLIPSIS = '...';
  const budget = max - ELLIPSIS.length;
  const slice = text.slice(0, budget);
  // Prefer to end at a sentence, then at a word.
  const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  const cut = sentence > budget * 0.5 ? sentence + 1 : slice.lastIndexOf(' ');
  const body = (cut > 0 ? slice.slice(0, cut) : slice).trimEnd();
  return { text: `${body}${ELLIPSIS}`, truncated: true };
}

/** `advisors_catalog_match_service` -> `advisors catalog match service`. */
export function humanise(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function sanitiseName(raw: string, taken: Set<string>): { name: string; changed: boolean } {
  let name = raw.replace(NAME_CHARSET, '_').replace(/_{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  if (name.length === 0) name = 'tool';
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).replace(/[_-]+$/, '');
  const changed = name !== raw;
  if (!taken.has(name)) return { name, changed };
  // Collision after sanitising. Suffix until free, keeping inside NAME_MAX.
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const candidate = name.slice(0, NAME_MAX - suffix.length).replace(/[_-]+$/, '') + suffix;
    if (!taken.has(candidate)) return { name: candidate, changed: true };
  }
  return { name: `${name.slice(0, NAME_MAX - 8)}_${Date.now() % 100000}`, changed: true };
}

function stringifyExamples(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e !== null && e !== undefined)
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
    .filter((e) => typeof e === 'string');
}

/**
 * Walk the normalised parameter schema and make it fit for a voice model:
 * judge every `pattern`, give every property a `description`, and record what
 * happened. Mutates `schema` in place; it is already a private copy.
 */
function dressProperties(
  schema: JsonSchema,
  path: string,
  out: { patterns: PatternVerdict[]; normalisers: ArgumentNormaliser[]; descriptionsAdded: number; hints: number },
  maxPropDesc: number,
): void {
  const props = schema.properties;
  if (!props) return;
  for (const [key, propRaw] of Object.entries(props)) {
    const prop = propRaw;
    const here = path ? `${path}.${key}` : key;

    if (typeof prop.pattern === 'string') {
      const verdict = judgePattern(prop.pattern, stringifyExamples(prop.examples));
      out.patterns.push(verdict);
      if (!verdict.kept) {
        const hint = droppedPatternHint(prop.pattern);
        delete prop.pattern;
        prop.description = prop.description ? `${prop.description} ${hint}` : hint;
        if (verdict.normaliser) {
          out.normalisers.push({ path: here, normaliser: verdict.normaliser, droppedPattern: verdict.pattern });
        }
      }
    }

    // "Every property should have a `description`. That string is how the model
    // extracts argument values from user speech." - voice-agent-api.yaml
    if (typeof prop.description !== 'string' || prop.description.trim() === '') {
      const kind = Array.isArray(prop.type) ? prop.type.join(' or ') : (prop.type ?? 'value');
      const choices = Array.isArray(prop.enum) && prop.enum.length > 0
        ? ` One of: ${prop.enum.map((v) => String(v)).join(', ')}.`
        : '';
      prop.description = `The ${humanise(key)} (${kind}).${choices}`;
      out.descriptionsAdded++;
    } else {
      const t = truncate(prop.description, maxPropDesc);
      prop.description = t.text;
    }

    if (Array.isArray(prop.enum) || typeof prop.format === 'string' || Array.isArray(prop.examples) || typeof prop.pattern === 'string') {
      out.hints++;
    }

    if (prop.properties) dressProperties(prop, here, out, maxPropDesc);
    if (prop.items && !Array.isArray(prop.items)) dressProperties(prop.items, `${here}[]`, out, maxPropDesc);
  }
}

export function convertTool(
  mcp: McpTool,
  taken: Set<string>,
  opts: ConvertOptions = {},
): ConvertedTool {
  const maxDesc = opts.maxDescriptionChars ?? DEFAULTS.maxDescriptionChars;
  const maxPropDesc = opts.maxPropertyDescriptionChars ?? DEFAULTS.maxPropertyDescriptionChars;
  const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth;

  const { name: voiceName, changed: nameSanitised } = sanitiseName(mcp.name, taken);
  taken.add(voiceName);

  // description: required by the API, so it is never left empty.
  let descriptionSynthesised = false;
  let source = (mcp.description ?? '').trim();
  if (source === '') {
    source = (mcp.title ?? mcp.annotations?.title ?? '').trim();
    descriptionSynthesised = source !== '';
  }
  if (source === '') {
    source = `Call the ${humanise(mcp.name)} tool on this MCP server.`;
    descriptionSynthesised = true;
  }
  // A destructive tool should not be picked casually by a model that is
  // guessing from a name. MCP's own annotation is the only signal we get.
  if (mcp.annotations?.destructiveHint === true) {
    source += ' This tool makes changes that cannot be undone; confirm with the user before calling it.';
  }
  const { text: description, truncated: descriptionTruncated } = truncate(source, maxDesc);

  const counters = newCounters();
  const rawSchema = mcp.inputSchema ?? {};
  const normalised = normaliseSchema(rawSchema, rawSchema, counters, { maxDepth });
  const parameters = asParametersObject(normalised);

  const dressed = { patterns: [] as PatternVerdict[], normalisers: [] as ArgumentNormaliser[], descriptionsAdded: 0, hints: 0 };
  dressProperties(parameters, '', dressed, maxPropDesc);

  const tool: VoiceAgentTool = {
    type: 'function',
    name: voiceName,
    description,
    parameters,
    // The documented default, stated anyway: interactive is the mode that is
    // meant to speak a transition phrase while the tool runs
    // (tools/overview.mdx, "Execution modes").
    execution_mode: 'interactive',
  };

  const report: ToolConversionReport = {
    mcpName: mcp.name,
    voiceName,
    nameSanitised,
    descriptionSynthesised,
    descriptionTruncated,
    refsResolved: counters.refsResolved,
    allOfFlattened: counters.allOfFlattened,
    unionsCollapsed: counters.unionsCollapsed,
    nullableUnwrapped: counters.nullableUnwrapped,
    patterns: dressed.patterns,
    normalisers: dressed.normalisers,
    hasHints: dressed.hints > 0,
    warnings: counters.warnings,
  };
  if (dressed.descriptionsAdded > 0) {
    report.warnings.push(`${dressed.descriptionsAdded} property description(s) synthesised from the property name`);
  }
  return { tool, report, source: mcp };
}

export function emptyStats(): CatalogStats {
  return {
    toolsIn: 0, toolsConverted: 0, convertedWithHints: 0, namesSanitised: 0,
    descriptionsSynthesised: 0, descriptionsTruncated: 0, patternsKept: 0,
    patternsDropped: 0, refsResolved: 0, allOfFlattened: 0, unionsCollapsed: 0,
    nullableUnwrapped: 0, failed: 0,
  };
}

/** Convert a whole `tools/list`. One bad tool must not lose the others. */
export function convertCatalog(tools: McpTool[], opts: ConvertOptions = {}): CatalogConversion {
  const taken = new Set<string>(opts.reserved ?? []);
  const converted: ConvertedTool[] = [];
  const failures: ConversionFailure[] = [];
  const stats = emptyStats();
  stats.toolsIn = tools.length;

  for (const mcp of tools) {
    if (typeof mcp?.name !== 'string' || mcp.name.trim() === '') {
      failures.push({ mcpName: String(mcp?.name ?? '(missing)'), reason: 'tool has no name' });
      continue;
    }
    try {
      const c = convertTool(mcp, taken, opts);
      converted.push(c);
      const r = c.report;
      stats.toolsConverted++;
      if (r.hasHints) stats.convertedWithHints++;
      if (r.nameSanitised) stats.namesSanitised++;
      if (r.descriptionSynthesised) stats.descriptionsSynthesised++;
      if (r.descriptionTruncated) stats.descriptionsTruncated++;
      stats.patternsKept += r.patterns.filter((p) => p.kept).length;
      stats.patternsDropped += r.patterns.filter((p) => !p.kept).length;
      stats.refsResolved += r.refsResolved;
      stats.allOfFlattened += r.allOfFlattened;
      stats.unionsCollapsed += r.unionsCollapsed;
      stats.nullableUnwrapped += r.nullableUnwrapped;
    } catch (err) {
      failures.push({ mcpName: mcp.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  stats.failed = failures.length;
  return { converted, failures, stats };
}

/** Map a Voice Agent tool name back to the MCP name `tools/call` needs. */
export function buildNameMap(converted: ConvertedTool[]): Map<string, string> {
  return new Map(converted.map((c) => [c.report.voiceName, c.report.mcpName]));
}
