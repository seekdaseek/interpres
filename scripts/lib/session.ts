/**
 * A live Voice Agent session for the proof scripts, built on the same
 * `AgentProtocol` the browser uses. Both harnesses open sessions through here,
 * so the only thing that differs between them is how the question gets in:
 * spoken audio, or injected text.
 */
import {
  AgentProtocol, applyNormalisers, assertPhaseValid, buildNameMap, convertCatalog,
  handleFindTools, initialPhase, phaseSessionUpdate, shapeResult, FIND_TOOLS_NAME,
} from '@interpres/core';
import type { ConvertedTool, ExecResult, Phase, PlannerInput, ServerEvent, ToolCall } from '@interpres/core';
import { probeServer, callTool } from '../../apps/server/src/mcp.ts';
import type { McpConnection } from '../../apps/server/src/mcp.ts';
import { CircuitBreaker, makeShaper, newShaperStats } from '../../apps/server/src/shaper.ts';
import type { ShaperStats } from '../../apps/server/src/shaper.ts';
import { config } from '../../apps/server/src/config.ts';

export const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
export const VOICE = 'alba';

export async function mintToken(maxSessionSeconds = 300): Promise<string> {
  const url = new URL(`${config.agentsApi}/token`);
  url.searchParams.set('expires_in_seconds', '120');
  url.searchParams.set('max_session_duration_seconds', String(maxSessionSeconds));
  const res = await fetch(url, { headers: { authorization: `Bearer ${config.assemblyAiKey}` } });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('token endpoint returned no token');
  return body.token;
}

export type Catalog = {
  url: string;
  connection: McpConnection;
  planner: PlannerInput;
  nameMap: Map<string, string>;
  byVoiceName: Map<string, ConvertedTool>;
  stats: { toolsIn: number; toolsConverted: number };
};

export async function loadCatalog(url: string): Promise<Catalog> {
  const connection = await probeServer(url);
  const conversion = convertCatalog(connection.tools, { reserved: [FIND_TOOLS_NAME] });
  return {
    url,
    connection,
    planner: { catalog: conversion.converted, server: connection.serverInfo, instructions: connection.instructions },
    nameMap: buildNameMap(conversion.converted),
    byVoiceName: new Map(conversion.converted.map((c) => [c.tool.name, c])),
    stats: { toolsIn: conversion.stats.toolsIn, toolsConverted: conversion.stats.toolsConverted },
  };
}

export type CallRecord = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  mcpName?: string;
  normalisersApplied?: string[];
  rawChars?: number;
  spokenChars?: number;
  spoken?: string;
  method?: string;
  refine?: string;
  refineMs?: number;
  mcpMs?: number;
  execMs?: number;
  isError?: boolean;
  phaseAfter?: string[];
  callAt: number;
  readyAt?: number;
  sentAt?: number;
  /** First reply.done after the call: the end of the transition phrase. */
  transitionDoneAt?: number;
  /**
   * How long the agent sat silent after its transition phrase, waiting for this
   * result, measured from the transition reply's `reply.done`. That event lands
   * about 0.3 s after `tool.call`, while the phrase's audio may still be playing,
   * so this overstates what a listener hears. `perceivedGapMs` is the real one.
   */
  agentWaitMs?: number;
  /**
   * The silence this call caused: from the later of the tool.call and the end
   * of any transition phrase, to the result going out. With no transition
   * phrase (the measured norm) it is the whole of the call's execution.
   */
  silenceOnUsMs?: number;
  /** Audio in the reply that carried the tool.call; 0 means no transition phrase. */
  transitionAudioMs?: number;
  /** Index into the session's reply list, for the gap computation. */
  transitionReply?: number;
  answerReply?: number;
};

/** One agent reply, as the listener experiences it. */
export type ReplyRecord = {
  startedAt: number;
  firstAudioAt?: number;
  /** Decoded PCM bytes of this reply's audio; 48 bytes = 1 ms at 24 kHz mono 16-bit. */
  audioBytes: number;
  doneAt?: number;
};

export type TurnRecord = {
  said: string;
  heard: string[];
  calls: CallRecord[];
  agentReply: string;
  interrupted: boolean;
  startedAt: number;
  speechEndAt?: number;
  firstAudioAt?: number;
  /** Speech end to the agent's first audio of any kind, a transition phrase included. */
  voiceToVoiceMs?: number;
  /** Speech end to the first audio of the answer that used the tool results. */
  timeToAnswerMs?: number;
  idleAt?: number;
  ms?: number;
};

export type OpenOptions = {
  verbose?: boolean;
  /** Carry spoken values across a find_tools phase change. Off only for A/B runs. */
  carry?: boolean;
  /**
   * Open in the phase `find_tools(<query>)` would produce instead of phase 0.
   * Test-only: it sets up "the tool you need is hidden" deterministically, rather
   * than hoping the agent chooses to call find_tools on an earlier turn.
   */
  startPhaseQuery?: string;
};

/** One Voice Agent session bound to one MCP server's catalog. */
export class LiveSession {
  readonly catalog: Catalog;
  readonly ws: WebSocket;
  readonly protocol: AgentProtocol;
  readonly shaperStats: ShaperStats = newShaperStats();
  readonly events: Record<string, number> = {};
  readonly failures: string[] = [];
  sessionId = '';
  phase: Phase;
  turn: TurnRecord | null = null;
  lastUserTranscript = '';

  private readonly breaker = new CircuitBreaker();
  private readonly refine: boolean;
  private readonly shaper;
  private readonly verbose: boolean;
  private readonly carry: boolean;
  private idleWaiters: Array<() => void> = [];
  private replyDoneTimes: number[] = [];
  readonly replies: ReplyRecord[] = [];
  private currentReply = -1;
  private readonly listeners: Array<(msg: ServerEvent) => void> = [];

  private constructor(catalog: Catalog, ws: WebSocket, opts: OpenOptions) {
    this.catalog = catalog;
    this.ws = ws;
    this.verbose = opts.verbose ?? false;
    this.carry = opts.carry ?? true;
    this.phase = opts.startPhaseQuery
      ? handleFindTools(catalog.planner, opts.startPhaseQuery, { carry: false }).phase
      : initialPhase(catalog.planner);
    assertPhaseValid(this.phase);
    this.shaper = makeShaper({ stats: this.shaperStats, breaker: this.breaker });
    this.refine = config.shaperRefine;
    this.protocol = new AgentProtocol(
      (msg) => this.send(msg),
      (call) => this.execute(call),
      {
        onToolCall: (call) => {
          this.turn?.calls.push({
            callId: call.callId, name: call.name, arguments: call.arguments, callAt: Date.now(),
            transitionReply: this.currentReply >= 0 ? this.currentReply : undefined,
          });
          this.log(`  TOOL.CALL ${call.name}(${JSON.stringify(call.arguments)})`);
        },
        onResultsSent: (ids) => {
          const now = Date.now();
          for (const c of this.turn?.calls ?? []) {
            if (!ids.includes(c.callId)) continue;
            c.sentAt = now;
            // The answer is the next reply to start after the result goes out.
            c.answerReply = this.replies.length;
            c.transitionDoneAt = this.replyDoneTimes.find((t) => t >= c.callAt);
            if (c.transitionDoneAt !== undefined) c.agentWaitMs = Math.max(0, c.sentAt - c.transitionDoneAt);
          }
        },
        onReplyDone: () => { this.replyDoneTimes.push(Date.now()); },
        onInterrupted: () => { if (this.turn) this.turn.interrupted = true; this.log('  INTERRUPTED'); },
        onTurnIdle: () => {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const w of waiters) w();
        },
      },
    );
  }

  static async open(url: string, opts: OpenOptions = {}): Promise<LiveSession> {
    const catalog = await loadCatalog(url);
    const token = await mintToken();
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    const session = new LiveSession(catalog, ws, opts);
    await session.connect();
    return session;
  }

  private log(line: string): void {
    if (this.verbose || /TOOL\.CALL|PHASE|RESULT|HEARD|AGENT|INTERRUPTED|!!/.test(line)) console.log(line);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    if (this.verbose && msg.type !== 'input.audio') console.log(`  -> ${String(msg.type)}`);
  }

  /** Raw send for callers that stream audio. */
  sendAudio(base64: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'input.audio', audio: base64 }));
  }

  sendRaw(msg: Record<string, unknown>): void {
    this.send(msg);
  }

  onEvent(fn: (msg: ServerEvent) => void): void {
    this.listeners.push(fn);
  }

  private async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('could not open the websocket')), { once: true });
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no session.ready within 20s')), 20_000);
      this.ws.addEventListener('message', (ev) => {
        let msg: ServerEvent;
        try { msg = JSON.parse(String((ev as MessageEvent).data)) as ServerEvent; } catch { return; }
        this.events[msg.type] = (this.events[msg.type] ?? 0) + 1;
        if (this.verbose && msg.type !== 'reply.audio' && msg.type !== 'transcript.agent.delta' && msg.type !== 'transcript.user.delta') {
          console.log(`  <- ${msg.type}${msg.type === 'session.error' ? ` ${JSON.stringify(msg)}` : ''}`);
        }
        switch (msg.type) {
          case 'session.ready':
            this.sessionId = String(msg.session_id ?? '');
            clearTimeout(timer);
            resolve();
            break;
          case 'session.error':
            this.failures.push(`session.error ${String(msg.code)}: ${String(msg.message)}`);
            this.log(`  !! session.error ${String(msg.code)}: ${String(msg.message)}`);
            if (this.sessionId === '') { clearTimeout(timer); reject(new Error(String(msg.message))); }
            break;
          case 'transcript.user':
            this.lastUserTranscript = String(msg.text ?? '');
            this.turn?.heard.push(this.lastUserTranscript);
            this.log(`  HEARD  "${this.lastUserTranscript}"`);
            break;
          case 'reply.started':
            this.replies.push({ startedAt: Date.now(), audioBytes: 0 });
            this.currentReply = this.replies.length - 1;
            break;
          case 'reply.done': {
            const r = this.replies[this.currentReply];
            if (r) r.doneAt = Date.now();
            break;
          }
          case 'reply.audio': {
            const r = this.replies[this.currentReply];
            if (r) {
              r.firstAudioAt ??= Date.now();
              const b64 = String(msg.data ?? '');
              r.audioBytes += Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
            }
            if (this.turn && this.turn.firstAudioAt === undefined && this.turn.speechEndAt !== undefined) {
              this.turn.firstAudioAt = Date.now();
              this.turn.voiceToVoiceMs = this.turn.firstAudioAt - this.turn.speechEndAt;
            }
            break;
          }
          case 'transcript.agent': {
            const text = String(msg.text ?? '');
            if (this.turn && text.trim() !== '') this.turn.agentReply = this.turn.agentReply ? `${this.turn.agentReply} ${text}` : text;
            break;
          }
          default:
            break;
        }
        this.protocol.handle(msg);
        for (const l of this.listeners) l(msg);
      });
      this.ws.addEventListener('close', (ev) => {
        if (this.sessionId === '') reject(new Error(`socket closed before session.ready (code ${(ev as CloseEvent).code})`));
      });
    });
    // No greeting: "omit it to listen first", which keeps the event flow clean.
    this.send({
      type: 'session.update',
      session: {
        system_prompt: this.phase.systemPrompt,
        tools: this.phase.tools,
        input: { keyterms: this.phase.keyterms, transcription_prompt: this.phase.transcriptionPrompt },
        output: { voice: VOICE, format: { encoding: 'audio/pcm' } },
      },
    });
    await ready;
  }

  /** The executor: `find_tools` runs the phase planner; everything else calls the MCP server. */
  private async execute(call: ToolCall): Promise<ExecResult> {
    const record = this.turn?.calls.find((c) => c.callId === call.callId);
    const started = Date.now();

    if (call.name === FIND_TOOLS_NAME) {
      const query = String(call.arguments.query ?? '');
      const outcome = handleFindTools(this.catalog.planner, query, { lastUserTurn: this.lastUserTranscript, carry: this.carry });
      assertPhaseValid(outcome.phase);
      this.phase = outcome.phase;
      const upd = phaseSessionUpdate(outcome.phase);
      if (record) {
        record.phaseAfter = outcome.available;
        record.method = 'phase_change';
        record.spoken = outcome.carried.length > 0 ? `carried: ${outcome.carried.join(', ')}` : 'carried: none';
        record.readyAt = Date.now();
        record.execMs = record.readyAt - started;
      }
      this.log(`  PHASE -> ${outcome.available.join(', ')}`);
      if (outcome.carried.length > 0) this.log(`  PHASE carried from the user's turn: ${outcome.carried.join(', ')}`);
      return { result: outcome.toolResult, sessionUpdate: { session: upd.session } };
    }

    const mcpName = this.catalog.nameMap.get(call.name);
    if (mcpName === undefined) {
      this.failures.push(`agent called unknown tool ${call.name}`);
      return { result: JSON.stringify({ error: `There is no tool called ${call.name}. Call find_tools to see what exists.` }) };
    }
    const entry = this.catalog.byVoiceName.get(call.name);
    const { args, applied } = applyNormalisers(call.arguments, entry?.report.normalisers ?? []);
    try {
      const outcome = await callTool(this.catalog.url, mcpName, args);
      const shaped = await shapeResult(call.name, outcome.result, {
        shaper: this.refine ? this.shaper : undefined,
        shaperAvailable: () => !this.breaker.isOpen(),
        question: this.lastUserTranscript || this.turn?.said,
      });
      if (record) {
        Object.assign(record, {
          mcpName, normalisersApplied: applied, rawChars: shaped.rawChars, spokenChars: shaped.spokenChars,
          spoken: shaped.spoken, method: shaped.method, refine: shaped.refine, refineMs: shaped.refineMs,
          mcpMs: outcome.durationMs, isError: shaped.isError, readyAt: Date.now(),
        });
        record.execMs = record.readyAt! - started;
      }
      this.log(`  RESULT ${mcpName}: ${shaped.rawChars} raw -> ${shaped.spokenChars} spoken [${shaped.method}, refine=${shaped.refine} ${shaped.refineMs}ms] mcp=${outcome.durationMs}ms`);
      return { result: shaped.result };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.failures.push(`tool ${call.name} threw: ${detail}`);
      if (record) { record.isError = true; record.spoken = detail; record.readyAt = Date.now(); }
      return { result: JSON.stringify({ error: detail }) };
    }
  }

  beginTurn(said: string): TurnRecord {
    this.turn = { said, heard: [], calls: [], agentReply: '', interrupted: false, startedAt: Date.now() };
    return this.turn;
  }

  /** Resolves when the agent goes idle, or after `timeoutMs`. */
  waitIdle(timeoutMs: number): Promise<'idle' | 'timeout'> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve('timeout'); } }, timeoutMs);
      this.idleWaiters.push(() => { if (!settled) { settled = true; clearTimeout(timer); resolve('idle'); } });
    });
  }

  endTurn(): TurnRecord | null {
    const t = this.turn;
    if (t) {
      t.idleAt = Date.now();
      t.ms = t.idleAt - t.startedAt;
      for (const c of t.calls) {
        const tr = c.transitionReply !== undefined ? this.replies[c.transitionReply] : undefined;
        c.transitionAudioMs = tr ? Math.round(tr.audioBytes / 48) : 0;
        // If a phrase played, the caller heard it until firstAudioAt + its length.
        const phraseEnd = tr?.firstAudioAt !== undefined ? tr.firstAudioAt + c.transitionAudioMs : undefined;
        const from = phraseEnd !== undefined ? Math.max(c.callAt, phraseEnd) : c.callAt;
        if (c.sentAt !== undefined) c.silenceOnUsMs = Math.max(0, c.sentAt - from);
      }
      const last = t.calls[t.calls.length - 1];
      const answer = last?.answerReply !== undefined ? this.replies[last.answerReply] : undefined;
      if (answer?.firstAudioAt !== undefined && t.speechEndAt !== undefined) t.timeToAnswerMs = answer.firstAudioAt - t.speechEndAt;
    }
    this.turn = null;
    return t;
  }

  async close(): Promise<void> {
    this.send({ type: 'session.end' });
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000);
      this.ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
