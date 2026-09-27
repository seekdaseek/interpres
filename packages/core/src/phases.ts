/**
 * The phase planner: keeping the visible tool list inside the limit the docs
 * set, and swapping it as the conversation moves.
 *
 * "Keep tool sets small (<=10 per phase). Past that, selection accuracy drops."
 * A `session.tools` update REPLACES the array rather than merging it, so every
 * plan carries the complete list.
 */
import type { ConvertedTool, JsonSchema, McpServerInfo, VoiceAgentTool } from './types.ts';
import { rankTools } from './rank.ts';
import { buildKeyterms, buildTranscriptionPrompt } from './keyterms.ts';
import { buildSystemPrompt } from './prompt.ts';
import { extractEntities } from './entities.ts';
import { usePastedTextDefinition, USE_PASTED_TEXT_NAME } from './gate.ts';

/** The documented ceiling on tools per phase. */
export const MAX_TOOLS_PER_PHASE = 10;

export const FIND_TOOLS_NAME = 'find_tools';

/**
 * The meta-tool. Its description is written as a trigger and an anti-trigger,
 * which the docs call the main cause of a tool that never fires.
 */
export function findToolsDefinition(catalogSize: number, visibleCount: number): VoiceAgentTool {
  const hidden = Math.max(catalogSize - visibleCount, 0);
  return {
    type: 'function',
    name: FIND_TOOLS_NAME,
    description:
      `Search this server's other ${hidden} tools and swap the matching ones into your ` +
      `available set. Call this whenever the person asks for something none of your current ` +
      `tools covers - it is how you reach the rest of the server. Do not call it for small ` +
      `talk, and do not call it again for a request your current tools already handle.`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What the person wants, in their own words or a few keywords. ' +
            'Plain language, not a tool name.',
          examples: ['check the status of my order', 'cancel a booking', 'current price'],
        },
      },
      required: ['query'],
    },
    execution_mode: 'interactive',
    timeout_seconds: 15,
  };
}

export type Phase = {
  /** Tools sent in `session.tools`, `find_tools` included when present. */
  tools: VoiceAgentTool[];
  /** The catalog entries behind those tools, `find_tools` excluded. */
  visible: ConvertedTool[];
  systemPrompt: string;
  keyterms: string[];
  transcriptionPrompt: string;
  hasFindTools: boolean;
  /** What triggered this phase, for the UI timeline and the logs. */
  reason: string;
};

export type PlannerInput = {
  catalog: ConvertedTool[];
  server: McpServerInfo | undefined;
  instructions?: string;
};

/**
 * Built-in tools present in every phase. `use_pasted_text` is how an exact
 * identifier reaches a tool without passing through speech-to-text.
 */
export const BUILTIN_SLOTS = 1;
/** Catalog tools per phase when find_tools is also present: 10 - 2 built-ins. */
export const CATALOG_SLOTS_WITH_FIND = MAX_TOOLS_PER_PHASE - BUILTIN_SLOTS - 1;

function assemble(
  input: PlannerInput,
  visible: ConvertedTool[],
  hasFindTools: boolean,
  reason: string,
): Phase {
  const tools: VoiceAgentTool[] = visible.map((c) => c.tool);
  tools.unshift(usePastedTextDefinition());
  if (hasFindTools) tools.unshift(findToolsDefinition(input.catalog.length, visible.length));
  return {
    tools,
    visible,
    hasFindTools,
    reason,
    systemPrompt: buildSystemPrompt({
      server: input.server,
      instructions: input.instructions,
      visible,
      catalogSize: input.catalog.length,
      hasFindTools,
    }),
    keyterms: buildKeyterms(visible, input.server),
    transcriptionPrompt: buildTranscriptionPrompt(visible, input.server, input.instructions),
  };
}

/**
 * The phase the session opens with.
 *
 * When the whole catalog fits inside the limit, every tool is exposed and
 * `find_tools` is left out. The brief has it always present, but a discovery
 * tool that can only answer "you already have all of them" spends one of ten
 * slots and gives the model a wrong turn to take. Above the limit it earns its
 * place, and phase 0 shows `find_tools` plus the 9 best-ranked tools.
 */
export function initialPhase(input: PlannerInput): Phase {
  if (input.catalog.length <= MAX_TOOLS_PER_PHASE - BUILTIN_SLOTS) {
    return assemble(input, input.catalog, false, 'catalog fits in one phase');
  }
  // No query yet. Rank against the server's own self-description so the opening
  // set is the tools most typical of what this server is for, rather than
  // whichever nine it happened to list first.
  const seed = [input.server?.title, input.server?.name, input.instructions]
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .join(' ');
  const ranked = seed ? rankTools(input.catalog, seed) : input.catalog.map((tool) => ({ tool, score: 0 }));
  const visible = ranked.slice(0, CATALOG_SLOTS_WITH_FIND).map((r) => r.tool);
  return assemble(input, visible, true, `catalog of ${input.catalog.length} exceeds the ${MAX_TOOLS_PER_PHASE}-tool limit`);
}

export type FindToolsOutcome = {
  phase: Phase;
  /** Names now callable, which is what `tool.result` reports back to the agent. */
  available: string[];
  /** Best matches, for the UI. */
  matched: Array<{ name: string; score: number }>;
  /** Exactly what goes back in `tool.result.result`: a JSON string. */
  toolResult: string;
  /** Values carried over from the caller's last turn into the new phase. */
  carried: string[];
};

export type FindToolsOptions = {
  /** The caller's most recent final transcript, if the client has one. */
  lastUserTurn?: string;
  /**
   * Carry the values in `lastUserTurn` across the swap. On by default; off only
   * to measure what happens without it.
   */
  carry?: boolean;
};

/** Handle a `find_tools` call: rank, reveal, and report back. */
export function handleFindTools(input: PlannerInput, query: string, opts: FindToolsOptions = {}): FindToolsOutcome {
  const ranked = rankTools(input.catalog, query);
  const keep = CATALOG_SLOTS_WITH_FIND;
  const visible = ranked.slice(0, keep).map((r) => r.tool);
  const phase = assemble(input, visible, true, `find_tools(${JSON.stringify(query)})`);
  const available = phase.tools.map((t) => t.name);
  const carried = opts.carry === false ? [] : extractEntities(opts.lastUserTurn ?? '');

  if (carried.length > 0) {
    // Bias speech-to-text toward these values if the caller has to say them
    // again, and tell the transcriber they are in play.
    phase.keyterms = [...carried, ...phase.keyterms.filter((k) => !carried.includes(k))].slice(0, 100);
    const note = ` The caller already gave these values: ${carried.join(', ')}.`;
    if (phase.transcriptionPrompt.length + note.length <= 1750) phase.transcriptionPrompt += note;
  }

  const result: Record<string, unknown> = {
    available_tools: available.filter((n) => n !== FIND_TOOLS_NAME && n !== USE_PASTED_TEXT_NAME),
    note: 'These tools are now callable. Call the right one now.',
  };
  if (carried.length > 0) {
    // A tool result is one of the two sources tool arguments are inferred from,
    // so the values ride along in it rather than relying on the agent to reach
    // back past the phase change to the caller's turn.
    result.values_from_request = carried;
    result.note = 'These tools are now callable. The person already gave the values listed in values_from_request: use them as arguments now instead of asking again.';
  }

  return {
    phase,
    available,
    matched: ranked.slice(0, keep).map((r) => ({ name: r.tool.tool.name, score: Number(r.score.toFixed(3)) })),
    toolResult: JSON.stringify(result),
    carried,
  };
}

/**
 * `input.transcription_mode`, sent in every `session.update` interpres makes:
 * the opening one, every phase change and every paste. The API takes
 * "min_latency", "balanced" (its default) or "max_accuracy", and the field is
 * mutable. Round H adopted min_latency from two in-process A/Bs against
 * balanced, generated in docs/LATENCY.md.
 */
export const TRANSCRIPTION_MODE = 'min_latency';

/**
 * The `session.update` body for a phase. Only mutable fields: `greeting` and
 * `output` would raise `immutable_field` after `session.ready`.
 */
export function phaseSessionUpdate(phase: Phase): {
  type: 'session.update';
  session: Record<string, unknown>;
} {
  return {
    type: 'session.update',
    session: {
      system_prompt: phase.systemPrompt,
      tools: phase.tools,
      input: {
        keyterms: phase.keyterms,
        transcription_prompt: phase.transcriptionPrompt,
        transcription_mode: TRANSCRIPTION_MODE,
      },
    },
  };
}

/**
 * The paste box's mid-session update: the merged keyterms, with the
 * transcription mode sent again, so no update is left to the default.
 */
export function keytermsSessionUpdate(keyterms: string[]): {
  type: 'session.update';
  session: Record<string, unknown>;
} {
  return { type: 'session.update', session: { input: { keyterms, transcription_mode: TRANSCRIPTION_MODE } } };
}

/** Never let a malformed phase reach the API, which would not complain. */
export function assertPhaseValid(phase: Phase): void {
  if (phase.tools.length > MAX_TOOLS_PER_PHASE) {
    throw new Error(`phase exposes ${phase.tools.length} tools, over the ${MAX_TOOLS_PER_PHASE} limit`);
  }
  const names = phase.tools.map((t) => t.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`phase has duplicate tool names: ${names.join(', ')}`);
  }
  if (phase.keyterms.length > 100) throw new Error(`phase has ${phase.keyterms.length} keyterms, over 100`);
  if (phase.transcriptionPrompt.length > 1750) {
    throw new Error(`transcription_prompt is ${phase.transcriptionPrompt.length} chars, over 1750`);
  }
  for (const t of phase.tools) {
    if (t.type !== 'function') throw new Error(`tool ${t.name} has type ${String(t.type)}`);
    if (!t.name) throw new Error('tool with an empty name');
    if (!t.description) throw new Error(`tool ${t.name} has an empty description, which the API requires`);
    const p: JsonSchema = t.parameters;
    if (p?.type !== 'object') throw new Error(`tool ${t.name} parameters must be type:"object"`);
    if (typeof p.properties !== 'object' || p.properties === null) {
      throw new Error(`tool ${t.name} parameters must carry a properties object`);
    }
  }
}
