/**
 * System prompts for a voice agent fronting an MCP server.
 *
 * The docs are firm that the prompt and the visible tool list must move
 * together: "Update tools AND `system_prompt` together. Tool-only gating where
 * the prompt still references a now-hidden tool can underperform not gating at
 * all." So the prompt is rebuilt from the visible tools on every phase change,
 * never patched.
 */
import type { ConvertedTool, McpServerInfo } from './types.ts';
import { humanise } from './convert.ts';

/**
 * Lifted from the docs' anti-fabrication clause (tools/overview). Gating stops
 * a fabricated call from doing anything real; it does not stop the agent
 * *claiming* it happened, and this wording is what suppresses the claim.
 */
export const ANTI_FABRICATION = [
  'NEVER state a value, name, number, status, ID or quotation unless that exact',
  'value came from a tool result in this conversation. If you have not seen a',
  'tool result, you do not have the answer. Do not estimate it, do not guess,',
  'and do not say "around" a number. Say you need to look it up, then call the',
  'tool.',
].join(' ');

export type PromptContext = {
  server: McpServerInfo | undefined;
  /** The server's own `instructions` from `initialize`, if it sent any. */
  instructions?: string;
  /** Tools visible in this phase, excluding the `find_tools` meta-tool. */
  visible: ConvertedTool[];
  /** Total tools in the catalog, so the agent knows more exist. */
  catalogSize: number;
  /** True when `find_tools` is exposed in this phase. */
  hasFindTools: boolean;
};

export function buildSystemPrompt(ctx: PromptContext): string {
  const label = (ctx.server?.title ?? ctx.server?.name ?? 'an MCP server').trim();
  const lines: string[] = [];

  lines.push(
    `You are a voice interface to ${label}, reached over the Model Context Protocol. ` +
      `The person is speaking to you out loud, so keep every reply to one or two short ` +
      `sentences and say numbers and identifiers the way a person would read them aloud.`,
  );

  if (ctx.instructions && ctx.instructions.trim() !== '') {
    // The server described itself; that beats anything we could infer.
    lines.push(`About this server, in its own words: ${ctx.instructions.trim().replace(/\s+/g, ' ')}`);
  }

  if (ctx.visible.length > 0) {
    lines.push(
      'Tools you can call right now:\n' +
        ctx.visible.map((t) => `- ${t.tool.name}: ${firstSentence(t.tool.description)}`).join('\n'),
    );
  }

  if (ctx.hasFindTools) {
    const hidden = Math.max(ctx.catalogSize - ctx.visible.length, 0);
    lines.push(
      `This server has ${ctx.catalogSize} tools in total and ${hidden} of them are not in the ` +
        `list above. If what the person wants is not covered by a tool you can see, call ` +
        `find_tools with a short description of what they asked for. That swaps in the ` +
        `matching tools, and you can then call one. Do not tell the person a thing is ` +
        `impossible before you have tried find_tools.`,
    );
  }

  lines.push(
    'When in doubt, call the tool. A wasted call is fine. Answering from memory is not.',
  );
  // Deliberately NO "say 'let me check' before a tool call" line. Tried and
  // measured on 2026-09-26: the reply carrying a tool.call still had no audio in
  // 6 of 6 turns, time to first audio did not move (4476 -> 4570 ms median), and
  // one answer degenerated into just "One moment." - the phrase spoken after the
  // result instead of the answer. The agent emits tool calls silently whatever
  // the prompt says.
  lines.push(ANTI_FABRICATION);
  lines.push(
    'A tool result may be long or full of JSON. Never read it out verbatim: say the one ' +
      'or two facts that answer the question. If a tool fails, say plainly what failed and ' +
      'what you need in order to retry.',
  );

  return lines.join('\n\n');
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const stop = trimmed.search(/[.!?](\s|$)/);
  const one = stop > 0 ? trimmed.slice(0, stop + 1) : trimmed;
  return one.length > 200 ? `${one.slice(0, 197).trimEnd()}...` : one;
}

/** The greeting, spoken once. Immutable after `session.ready`. */
export function buildGreeting(server: McpServerInfo | undefined, catalogSize: number): string {
  const label = (server?.title ?? server?.name ?? 'this server').trim();
  return `Connected to ${label}, with ${catalogSize} ${catalogSize === 1 ? 'tool' : 'tools'} available. What would you like to do?`;
}
