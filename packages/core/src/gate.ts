/**
 * The confirmation gate: nothing misheard gets executed.
 *
 * Measured with real speech (BUILDLOG, e2e-audio): speech-to-text cannot carry a
 * 40-character address. It looped on repeated zeros, merged doubled letters,
 * and once produced a valid-looking DIFFERENT address that afg answered about.
 * A read-back cannot fix that - 42 characters take ~19 s to say, and nobody can
 * check hex by ear - so the rule is voice for intent, keyboard for identifiers,
 * and a gate in front of every MCP request.
 *
 * Two triggers, and neither makes an MCP request:
 *   A. an identifier-shaped argument that did not come from the keyboard (the
 *      paste box) or from an earlier tool result in this session. It returns
 *      `needs_paste`, and nothing said aloud gets past it (decision D4). Measured:
 *      a spoken "yes, that's right" confirmed an address whose middle was
 *      misheard (5c8e -> 5cad) while its last four characters were right.
 *   B. a tool that changes state. It returns `needs_confirmation`, and an
 *      identical repeat within 120 s, after the person says yes, executes
 *      exactly once.
 * A is checked first, so a state-changing call carrying a spoken identifier
 * needs a paste, not a yes.
 *
 * Everything here is pure: no I/O, and the clock is passed in.
 */
import type { JsonSchema, McpTool } from './types.ts';

// ------------------------------------------------------------ identifiers

export type IdentifierKind = 'hex0x' | 'hex' | 'base58' | 'uuid' | 'mixed';
export type IdentifierHit = { raw: string; normalized: string; kind: IdentifierKind };

const HEX0X = /^0x[0-9a-f]{16,}$/i;
const HEX = /^[0-9a-f]{24,}$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{24,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const digits = (s: string) => (s.match(/\d/g) ?? []).length;
const letters = (s: string) => (s.match(/[A-Za-z]/g) ?? []).length;

/** Classify one candidate with its internal spaces already removed. */
export function identifierKind(candidate: string): IdentifierKind | null {
  const c = candidate;
  if (EMAIL.test(c)) return null;                       // an email is not an identifier here
  if (letters(c) === 0) return null;                    // digit-only strings: out of scope for now
  if (HEX0X.test(c)) return 'hex0x';
  if (UUID.test(c)) return 'uuid';
  if (HEX.test(c) && digits(c) > 0) return 'hex';
  if (BASE58.test(c) && digits(c) > 0) return 'base58';
  if (c.length >= 16 && !/\s/.test(c) && digits(c) >= 3 && letters(c) >= 3) return 'mixed';
  return null;
}

/**
 * Undo speech-to-text's spacing of a spelled-out value, and nothing else.
 *
 * Collapsed: a run of four or more single characters ("0 x 3 f 9 a"), and a run
 * of four or more short hex groups ("3f9a 1c7e 5b2d 8f4a"), optionally led by a
 * "0x". NOT collapsed: ordinary words. Removing every space from a whole
 * argument would turn "the tests failed 3 times on run 42" into a 27-character
 * run with 4 digits - an identifier by the length rule - and a plain sentence is
 * a documented negative.
 */
export function collapseSpelled(text: string): string {
  let t = text.replace(/\b((?:[0-9A-Za-z] ){3,}[0-9A-Za-z])\b/g, (m) => m.replace(/ /g, ''));
  t = t.replace(/\b((?:0x)?(?:[0-9a-f]{2,6} ){3,}[0-9a-f]{2,6})\b/gi, (m) => m.replace(/ /g, ''));
  return t;
}

/** Every identifier-shaped value inside `text`. */
export function findIdentifiers(text: string): IdentifierHit[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const hits: IdentifierHit[] = [];
  for (const tok of collapseSpelled(text).split(/\s+/)) {
    const raw = tok.replace(/^[("'`[{<]+|[)"'`\]}>.,;:!?]+$/g, '');
    if (raw.length < 16) continue;
    const kind = identifierKind(raw);
    if (!kind) continue;
    const normalized = kind === 'base58' || kind === 'mixed' ? raw : raw.toLowerCase();
    if (!hits.some((h) => h.normalized === normalized)) hits.push({ raw, normalized, kind });
  }
  return hits;
}

export function isIdentifierShaped(text: string): boolean {
  return findIdentifiers(text).length > 0;
}

/** Hex and UUIDs compare case-insensitively; base58 and mixed must match exactly. */
export function appearsVerbatim(hit: IdentifierHit, haystack: string): boolean {
  if (!haystack) return false;
  return hit.kind === 'base58' || hit.kind === 'mixed'
    ? haystack.includes(hit.raw)
    : haystack.toLowerCase().includes(hit.normalized);
}

// --------------------------------------------------------------- writes

/**
 * The spec's write verbs, plus a few more of the same kind. A false positive
 * costs one confirmation; a false negative runs a state change unasked, so the
 * list errs toward write.
 */
export const WRITE_VERBS = new Set([
  'create', 'delete', 'remove', 'update', 'set', 'add', 'put', 'patch', 'insert', 'send', 'post', 'publish',
  'pay', 'transfer', 'buy', 'sell', 'swap', 'mint', 'stake', 'withdraw', 'deposit', 'claim', 'sign', 'fund',
  'submit', 'approve', 'reject', 'cancel', 'book', 'order', 'schedule', 'invite', 'assign', 'deploy',
  'execute', 'trigger', 'dispute', 'appeal', 'upload', 'discard', 'archive', 'rename', 'move',
  // beyond the spec's list, same kind
  'write', 'edit', 'modify', 'save', 'reset', 'revoke', 'grant', 'register', 'subscribe', 'unsubscribe',
  'close', 'start', 'stop', 'restart', 'kill', 'drop', 'purge', 'erase', 'replace', 'commit', 'merge',
  'push', 'lock', 'unlock', 'enable', 'disable', 'toggle', 'apply', 'refund', 'charge', 'bid', 'vote',
  'reply', 'comment', 'follow', 'unfollow', 'block', 'ban', 'attach', 'detach', 'link', 'unlink', 'import',
  'clear', 'reserve', 'confirm', 'accept', 'decline', 'unstake', 'bridge', 'burn', 'lend', 'borrow', 'repay',
  'redeem', 'rebalance', 'emit', 'broadcast', 'notify', 'email', 'sms', 'call', 'dial', 'message', 'tweet',
  'install', 'uninstall', 'provision', 'destroy', 'terminate', 'suspend', 'resume', 'finalize',
]);

/** Split a tool name into lowercase word tokens: snake, kebab, dotted and camel. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/**
 * Tokens every tool on the server starts with - `afg` in `afg_create_wallet` -
 * which carry no meaning about the action. Never strips a tool down to nothing.
 */
export function sharedPrefixTokens(names: string[]): number {
  if (names.length < 2) return 0;
  const toks = names.map(nameTokens);
  const min = Math.min(...toks.map((t) => t.length));
  let n = 0;
  while (n < min - 1 && toks.every((t) => t[n] === toks[0]![n])) n++;
  return n;
}

export type WriteVerdict = { write: boolean; reason: string };

export function classifyWrite(tool: Pick<McpTool, 'name' | 'annotations'>, sharedPrefix = 0, presetWriteTools: readonly string[] = []): WriteVerdict {
  if (tool.annotations?.destructiveHint === true) return { write: true, reason: 'destructiveHint' };
  if (presetWriteTools.includes(tool.name)) return { write: true, reason: 'preset writeTools list' };
  if (tool.annotations?.readOnlyHint === true) return { write: false, reason: 'readOnlyHint' };
  const first = nameTokens(tool.name)[sharedPrefix];
  if (first !== undefined && WRITE_VERBS.has(first)) return { write: true, reason: `name starts with the write verb "${first}"` };
  return { write: false, reason: first ? `name starts with "${first}", not a write verb` : 'no name tokens' };
}

// ---------------------------------------------------------------- patterns

/** Original `pattern` constraints by dotted path, read before conversion drops any. */
export function originalPatterns(schema: JsonSchema | undefined, prefix = '', out: Record<string, string> = {}, depth = 0): Record<string, string> {
  if (!schema || depth > 8) return out;
  for (const [k, p] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof p.pattern === 'string') out[path] = p.pattern;
    if (p.properties) originalPatterns(p, path, out, depth + 1);
  }
  return out;
}

// -------------------------------------------------------------------- gate

export type GateTool = {
  voiceName: string;
  mcpName: string;
  /** First sentence of what the tool does, for the confirmation line. */
  what: string;
  write: boolean;
  writeReason: string;
  /** The server's own `pattern` per argument path, before conversion touched it. */
  patterns: Record<string, string>;
};

/** Build the gate's view of a catalog from the raw MCP tools. */
export function gateTools(
  tools: Array<{ voiceName: string; source: McpTool }>,
  presetWriteTools: readonly string[] = [],
): GateTool[] {
  const shared = sharedPrefixTokens(tools.map((t) => t.source.name));
  return tools.map(({ voiceName, source }) => {
    const verdict = classifyWrite(source, shared, presetWriteTools);
    const desc = (source.description ?? source.title ?? '').trim();
    const stop = desc.search(/[.!?](\s|$)/);
    const what = (stop > 0 ? desc.slice(0, stop + 1) : desc).slice(0, 160) || `Runs ${source.name}.`;
    return { voiceName, mcpName: source.name, what, write: verdict.write, writeReason: verdict.reason, patterns: originalPatterns(source.inputSchema) };
  });
}

export const CONFIRM_WINDOW_MS = 120_000;

const YES = /\b(yes|yeah|yep|yup|correct|right|confirm(ed)?|go ahead|do it|sure|ok(ay)?|that'?s (it|right|correct)|affirmative|proceed|please do)\b/i;
const NO = /\b(no|nope|don'?t|do not|wrong|cancel|stop|wait|not (right|correct|it))\b/i;

/** Did the person say yes - and not no? Deliberately conservative. */
export function isAffirmative(text: string): boolean {
  return YES.test(text) && !NO.test(text);
}

type Pending = { key: string; gatedAt: number; confirmedAt?: number };

/** What the UI shows for a held call. */
export type GateCard = { tool: string; server?: string; value?: string; grouped?: string; what?: string; say: string };

/** Every held decision carries a JSON string for tool.result; no MCP request was made. */
export type GateDecision =
  | { action: 'execute'; key: string; confirmed: boolean }
  /** Trigger A: an identifier from speech. Only a paste gets past it. */
  | { action: 'paste'; key: string; result: string; card: GateCard }
  /** Trigger B: a state change, released by a spoken yes. */
  | { action: 'confirm'; trigger: 'write'; key: string; result: string; card: GateCard }
  /** Trigger A, and the value also fails the server's own pattern. */
  | { action: 'invalid'; key: string; result: string; card: GateCard };

/** Group a value in fours for reading: 0x3f 9a1c 7e5b ... */
export function groupInFours(value: string): string {
  return (value.match(/.{1,4}/g) ?? [value]).join(' ');
}

/** Stable key: same tool and same arguments, identifiers normalised. */
export function callKey(tool: string, args: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const hits = findIdentifiers(v);
      if (hits.length === 1 && hits[0]!.raw.length >= collapseSpelled(v).trim().length - 2) return hits[0]!.normalized;
      return collapseSpelled(v).trim();
    }
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, norm(x)]));
    return v;
  };
  return `${tool}:${JSON.stringify(norm(args))}`;
}

function* stringsAt(v: unknown, path: string): Generator<{ path: string; value: string }> {
  if (typeof v === 'string') { yield { path, value: v }; return; }
  if (Array.isArray(v)) { for (const x of v) yield* stringsAt(x, path); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) yield* stringsAt(x, path ? `${path}.${k}` : k);
}

export class ToolGate {
  private readonly tools: Map<string, GateTool>;
  private readonly serverLabel: string;
  private readonly pending = new Map<string, Pending>();
  /** Text the person typed or pasted, and raw tool results: where an identifier may legitimately come from. */
  private readonly provenance: string[] = [];
  private provenanceChars = 0;
  private lastAffirmativeAt = 0;
  /** Executions, per key, released by a confirmation. */
  executedAfterConfirm = 0;

  constructor(tools: GateTool[], serverLabel: string) {
    this.tools = new Map(tools.map((t) => [t.voiceName, t]));
    this.serverLabel = serverLabel;
  }

  tool(voiceName: string): GateTool | undefined {
    return this.tools.get(voiceName);
  }

  /** The paste box, or anything the person typed. */
  recordPaste(text: string): void {
    this.remember(text);
  }

  /**
   * A raw MCP result: identifiers in it may be used as arguments later.
   *
   * Pass the arguments the call was made with. A result that echoes back what
   * it was sent - most lookups do - must not launder a misheard value into
   * "came from a tool": found by the protocol test, where a confirmed spoken
   * address, echoed by the tool, let the next identical call through unasked.
   */
  recordToolResult(text: string, args?: Record<string, unknown>): void {
    let t = text;
    if (args) {
      for (const { value } of stringsAt(args, '')) {
        for (const hit of findIdentifiers(value)) {
          if (hit.kind === 'base58' || hit.kind === 'mixed') t = t.split(hit.raw).join('<echo>');
          else t = t.replace(new RegExp(hit.normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<echo>');
        }
      }
    }
    this.remember(t);
  }

  private remember(text: string): void {
    if (!text) return;
    this.provenance.push(text);
    this.provenanceChars += text.length;
    // Bounded: keep the most recent ~2 MB.
    while (this.provenanceChars > 2_000_000 && this.provenance.length > 1) this.provenanceChars -= this.provenance.shift()!.length;
  }

  /** Every final user transcript. A yes here confirms whatever is pending. */
  recordUserTurn(text: string, now: number): void {
    if (!isAffirmative(text)) return;
    this.lastAffirmativeAt = now;
    for (const p of this.pending.values()) if (p.confirmedAt === undefined && now - p.gatedAt <= CONFIRM_WINDOW_MS) p.confirmedAt = now;
  }

  /** Decide before any MCP request. Never throws. */
  check(voiceName: string, args: Record<string, unknown>, now: number): GateDecision {
    const key = callKey(voiceName, args);
    for (const [k, p] of this.pending) if (now - p.gatedAt > CONFIRM_WINDOW_MS) this.pending.delete(k);

    const tool = this.tools.get(voiceName);
    const haystack = this.provenance.join('\n');

    // Trigger A, first and unconditionally: an identifier that did not come from
    // the keyboard or a tool never runs, whatever was said before or after it.
    for (const { path, value } of stringsAt(args, '')) {
      for (const hit of findIdentifiers(value)) {
        if (appearsVerbatim(hit, haystack)) continue;
        const pattern = tool?.patterns[path];
        if (pattern !== undefined) {
          let re: RegExp | null = null;
          try { re = new RegExp(`^(?:${pattern.replace(/^\^/, '').replace(/\$$/, '')})$`); } catch { re = null; }
          if (re && !re.test(hit.raw)) {
            const say = `That value does not match the format this tool expects. Please paste it into the box under the Talk button.`;
            return {
              action: 'invalid',
              key,
              result: JSON.stringify({ status: 'invalid', argument: path, heard: hit.raw, expected_pattern: pattern, say, instruction: 'Do not retry with a value from speech. Ask the person to paste it, then call use_pasted_text.' }),
              card: { tool: voiceName, value: hit.raw, grouped: groupInFours(hit.raw), say },
            };
          }
        }
        // No pending entry: there is no voice path past this, so a yes has nothing to release.
        const say = 'I may have misheard that value. Please paste it into the box under the Talk button, and I will use exactly what you paste.';
        return {
          action: 'paste',
          key,
          result: JSON.stringify({
            status: 'needs_paste',
            reason: 'identifier_from_speech',
            argument: path,
            heard: hit.raw,
            say,
            instruction: 'Say the line in "say". Never call a tool with this value from speech, even if the person says it is right. Once they have pasted it, call use_pasted_text and use exactly the text it returns.',
          }),
          card: { tool: voiceName, value: hit.raw, grouped: groupInFours(hit.raw), say },
        };
      }
    }

    // A confirmed identical repeat of a held state change runs exactly once,
    // then the confirmation is spent.
    const pend = this.pending.get(key);
    if (pend && pend.confirmedAt !== undefined && now - pend.gatedAt <= CONFIRM_WINDOW_MS) {
      this.pending.delete(key);
      this.executedAfterConfirm++;
      return { action: 'execute', key, confirmed: true };
    }

    // Trigger B: tools that change state.
    if (tool?.write) {
      this.pending.set(key, { key, gatedAt: now });
      const say = `This will ${tool.what.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())} on ${this.serverLabel}. Should I go ahead?`;
      return {
        action: 'confirm',
        trigger: 'write',
        key,
        result: JSON.stringify({
          status: 'needs_confirmation',
          reason: 'changes_state',
          tool: voiceName,
          server: this.serverLabel,
          say,
          instruction: 'Say the line in "say". Only if the person then says yes, call the same tool again with exactly the same arguments.',
        }),
        card: { tool: voiceName, server: this.serverLabel, what: tool.what, say },
      };
    }

    return { action: 'execute', key, confirmed: false };
  }
}

// -------------------------------------------------------- the paste box tool

export const USE_PASTED_TEXT_NAME = 'use_pasted_text';

export function usePastedTextDefinition() {
  return {
    type: 'function' as const,
    name: USE_PASTED_TEXT_NAME,
    description:
      'Read exactly what the person pasted or typed into the box under the Talk button. Call this whenever ' +
      'they mention something they pasted - "the address I pasted", "the ID in the box" - and use the text it ' +
      'returns verbatim as the argument. Never guess or re-type a pasted value from speech.',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'interactive' as const,
    timeout_seconds: 10,
  };
}

/**
 * The tool.result for use_pasted_text.
 *
 * It carries the next step as well as the text. Measured in the browser: with
 * the bare text, the agent read the box and then asked "what would you like to
 * know about it?" instead of making the call it had been asked for.
 */
export function pastedTextResult(text: string): string {
  const t = text.trim();
  return t === ''
    ? JSON.stringify({ status: 'empty', hint: 'The paste box is empty. Ask the person to paste the value into the box under the Talk button, then call use_pasted_text again.' })
    : JSON.stringify({
        text: t,
        next: 'This is exactly what the person pasted. If they asked you to do something with it, call that tool now with this text as the argument, unchanged. Do not ask them to repeat the request.',
      });
}
