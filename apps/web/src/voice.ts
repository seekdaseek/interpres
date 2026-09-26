/**
 * One live conversation: token, socket, microphone, speaker, and the shared
 * tool-call protocol from `@interpres/core` - the same `AgentProtocol` class the
 * proof scripts drive.
 */
import { AgentProtocol, IdleClock, IDLE_LIMIT_MS, ToolGate, USE_PASTED_TEXT_NAME, pastedTextResult, pasteKeyterms, mergeKeyterms } from '@interpres/core';
import type { ExecResult, GateDecision, GateTool, ServerEvent, ToolCall } from '@interpres/core';
import { AudioEngine, fromBase64, toBase64 } from './audio.ts';
import { api, postJson as postJsonSafe } from './http.ts';

const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
/** A US English voice from the docs' list. */
export const VOICE = 'alba';

export type Status = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'tool' | 'ended' | 'error';

export type PhasePayload = {
  tools: Array<{ name: string; description: string }>;
  systemPrompt: string;
  keyterms: string[];
  transcriptionPrompt: string;
  hasFindTools: boolean;
  reason: string;
  visible: Array<{ voiceName: string; mcpName: string }>;
  sessionUpdate: { type: 'session.update'; session: Record<string, unknown> };
};

export type ToolOutcome = {
  spoken: string;
  raw?: string;
  method?: string;
  refine?: string;
  refineMs?: number;
  totalMs?: number;
  mcpMs?: number;
  isError?: boolean;
  normalisersApplied?: string[];
  phase?: PhasePayload;
  carried?: string[];
  matched?: Array<{ name: string; score: number }>;
};

export type VoiceUi = {
  status(s: Status, detail?: string): void;
  ready(sessionId: string, maxSeconds: number): void;
  userPartial(text: string): void;
  userFinal(text: string): void;
  agentDelta(replyId: string, word: string): void;
  agentFinal(replyId: string, text: string, interrupted: boolean): void;
  toolStart(call: ToolCall): void;
  toolDone(call: ToolCall, outcome: ToolOutcome, ms: number): void;
  toolFailed(call: ToolCall, message: string): void;
  phase(phase: PhasePayload, why: string): void;
  interrupted(): void;
  ended(reason: string): void;
  /** Microphone loudness, 0..1, 25 times a second. */
  level(rms: number): void;
  /** The gate held a call: show what was heard and what would run. */
  gateHeld(call: ToolCall, decision: Exclude<GateDecision, { action: 'execute' }>): void;
  /** A held call was confirmed and ran. */
  gateReleased(call: ToolCall): void;
  /** Keyterms now in effect, and which of them came from the person's paste box. */
  keyterms(all: string[], yours: string[]): void;
  /** Seconds until the session ends for lack of speech, or null while someone is talking or a tool runs. */
  idle(secondsLeft: number | null): void;
};

export type ConnectPayload = {
  url: string;
  greeting: string;
  phase: PhasePayload;
  gate: { tools: GateTool[]; server: string };
};

/** /api/token said no - the per-IP limit or the daily cap. The page plays the recording instead. */
export class TokenRefusedError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'TokenRefusedError';
    this.code = code;
  }
}

/**
 * A tool's round trip to our server. A failure throws the plain sentence from
 * `http.ts`, which is what the agent's `tool.result` then carries - never a
 * parser message or an upstream body.
 */
async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await postJsonSafe<T>(path, body, signal);
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

export class VoiceSession {
  private readonly conn: ConnectPayload;
  private readonly ui: VoiceUi;
  private readonly audio = new AudioEngine();
  private ws?: WebSocket;
  private protocol?: AgentProtocol;
  private ready = false;
  private lastUserTurn = '';
  private closed = false;
  private endTimer?: ReturnType<typeof setTimeout>;
  private idle?: IdleClock;
  private idleTick?: ReturnType<typeof setInterval>;
  private userSpeaking = false;
  private agentReplying = false;
  private readonly gate: ToolGate;
  private readonly getPaste: () => string;
  private phaseKeyterms: string[];
  private yours: string[] = [];
  sessionId = '';

  constructor(conn: ConnectPayload, ui: VoiceUi, getPaste: () => string) {
    this.conn = conn;
    this.ui = ui;
    this.getPaste = getPaste;
    this.gate = new ToolGate(conn.gate.tools, conn.gate.server);
    this.phaseKeyterms = conn.phase.keyterms;
    this.notePaste(getPaste(), false);
  }

  /**
   * The paste box changed. Its text becomes a legitimate source for identifiers,
   * and its speakable word parts become keyterms, so a name like "ochinimus"
   * that the person then SAYS is heard as written.
   */
  notePaste(text: string, push = true): void {
    if (text.trim() !== '') this.gate.recordPaste(text);
    this.yours = pasteKeyterms(text);
    const merged = mergeKeyterms(this.phaseKeyterms, this.yours);
    this.ui.keyterms(merged, this.yours);
    if (push && this.ready && this.ws?.readyState === WebSocket.OPEN) {
      // Mutable mid-session; takes effect on the next utterance.
      this.ws.send(JSON.stringify({ type: 'session.update', session: { input: { keyterms: merged } } }));
    }
  }

  get sampleRates(): { capture: number; playback: number } {
    return { capture: this.audio.captureRate, playback: this.audio.playbackRate };
  }

  /** Must be called from a click handler: audio contexts need a user gesture. */
  async start(): Promise<void> {
    this.ui.status('connecting');
    const t = await api<{ token?: string; maxSessionDurationSeconds?: number }>('/api/token');
    if (!t.ok && t.status === 429) throw new TokenRefusedError(t.message, t.code ?? 'rate_limited');
    if (!t.ok) throw new Error(t.message);
    if (!t.data.token) throw new Error('No session token came back. Try again in a moment.');
    const tokenBody = t.data as { token: string; maxSessionDurationSeconds?: number };
    const maxSeconds = tokenBody.maxSessionDurationSeconds ?? 300;

    await this.audio.start({
      onFrame: (pcm) => {
        const s16 = new Int16Array(pcm);
        let sum = 0;
        for (let i = 0; i < s16.length; i += 4) sum += s16[i]! * s16[i]!;
        this.ui.level(Math.min(1, Math.sqrt(sum / (s16.length / 4)) / 6000));
        // "Only send input.audio after session.ready."
        if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'input.audio', audio: toBase64(pcm) }));
        }
      },
      onPlaying: (playing) => {
        if (playing) this.ui.status('speaking');
        else if (!this.closed && this.ready) this.ui.status('listening');
      },
    });

    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(tokenBody.token)}`);
    this.ws = ws;
    this.protocol = new AgentProtocol(
      (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
      (call) => this.executeHeld(call),
      {
        onToolCall: (call) => { this.ui.toolStart(call); this.ui.status('tool', call.name); },
        onToolDone: (call, exec, ms) => this.ui.toolDone(call, (exec.meta ?? { spoken: '' }) as ToolOutcome, ms),
        onToolError: (call, err) => this.ui.toolFailed(call, err instanceof Error ? err.message : String(err)),
        onInterrupted: () => { this.audio.flush(); this.ui.interrupted(); },
      },
    );

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            ...this.conn.phase.sessionUpdate.session,
            greeting: this.conn.greeting,
            input: {
              ...(this.conn.phase.sessionUpdate.session.input as Record<string, unknown>),
              keyterms: mergeKeyterms(this.phaseKeyterms, this.yours),
              format: { encoding: 'audio/pcm' },
            },
            output: { voice: VOICE, format: { encoding: 'audio/pcm' } },
          },
        }));
      };
      ws.onmessage = (ev) => {
        let msg: ServerEvent;
        try { msg = JSON.parse(String(ev.data)) as ServerEvent; } catch { return; }
        if (msg.type === 'session.ready') {
          this.ready = true;
          this.sessionId = String(msg.session_id ?? '');
          this.ui.ready(this.sessionId, maxSeconds);
          this.ui.status('listening');
          // Leave before the server's hard cap, so the goodbye is ours.
          this.endTimer = setTimeout(() => void this.stop('time limit'), maxSeconds * 1000 - 1500);
          // An open tab nobody talks in bills to the cap; end it after a minute of silence.
          this.idle = new IdleClock(Date.now());
          this.idleTick = setInterval(() => this.tickIdle(), 250);
          resolve();
        }
        if (msg.type === 'session.error' && !this.ready) reject(new Error(`${String(msg.code)}: ${String(msg.message)}`));
        this.onEvent(msg);
      };
      ws.onerror = () => { if (!this.ready) reject(new Error('Could not reach the Voice Agent API.')); };
      ws.onclose = (ev) => {
        if (!this.ready) reject(new Error(`The Voice Agent API closed the connection (code ${ev.code}).`));
        else void this.stop(`connection closed (${ev.code})`);
      };
    });
  }

  private onEvent(msg: ServerEvent): void {
    switch (msg.type) {
      case 'input.speech.started':
        if (!this.userSpeaking) { this.userSpeaking = true; this.idle?.hold('user'); }
        // Barge-in: stop the agent mid-word. The server decides whether it was a
        // real interruption and says so with reply.done status "interrupted".
        this.audio.flush();
        this.ui.status('hearing');
        break;
      case 'input.speech.stopped':
        if (this.userSpeaking) { this.userSpeaking = false; this.idle?.release('user', Date.now()); }
        this.ui.status('thinking');
        break;
      case 'reply.started':
        if (!this.agentReplying) { this.agentReplying = true; this.idle?.hold('agent'); }
        break;
      case 'transcript.user.delta':
        // The full transcript so far, not an increment: replace, never append.
        this.ui.userPartial(String(msg.text ?? ''));
        break;
      case 'transcript.user':
        this.lastUserTurn = String(msg.text ?? '');
        this.gate.recordUserTurn(this.lastUserTurn, Date.now());
        this.ui.userFinal(this.lastUserTurn);
        break;
      case 'reply.audio':
        this.audio.play(fromBase64(String(msg.data ?? '')));
        break;
      case 'transcript.agent.delta':
        // One word at a time: append.
        this.ui.agentDelta(String(msg.reply_id ?? ''), String(msg.delta ?? ''));
        break;
      case 'transcript.agent':
        this.ui.agentFinal(String(msg.reply_id ?? ''), String(msg.text ?? ''), msg.interrupted === true);
        break;
      case 'reply.done':
        if (msg.status === 'interrupted') this.audio.flush();
        if (this.agentReplying) { this.agentReplying = false; this.idle?.release('agent', Date.now()); }
        break;
      case 'session.ended':
        void this.stop('session ended');
        break;
      case 'session.error':
        if (this.ready) this.ui.status('error', `${String(msg.code)}: ${String(msg.message)}`);
        break;
      default:
        break;
    }
    this.protocol?.handle(msg);
  }

  /**
   * use_pasted_text reads the page; find_tools runs the phase planner on the
   * server; every other tool passes the gate first, then calls the MCP server.
   */
  /** A running tool is not idleness. */
  private async executeHeld(call: ToolCall): Promise<ExecResult> {
    this.idle?.hold('tool');
    try {
      return await this.execute(call);
    } finally {
      this.idle?.release('tool', Date.now());
    }
  }

  private tickIdle(): void {
    if (!this.idle || this.closed) return;
    const left = this.idle.remainingMs(Date.now());
    this.ui.idle(left === null ? null : Math.ceil(left / 1000));
    if (left === 0) void this.stop(`no one spoke for ${IDLE_LIMIT_MS / 1000} s`);
  }

  private async execute(call: ToolCall): Promise<ExecResult> {
    if (call.name === USE_PASTED_TEXT_NAME) {
      const text = this.getPaste();
      if (text.trim() !== '') this.gate.recordPaste(text);
      return { result: pastedTextResult(text), meta: { spoken: text.trim() === '' ? 'The paste box is empty.' : `Read ${text.trim().length} characters from the paste box.` } };
    }
    if (call.name === 'find_tools') {
      const r = await postJson<{ phase: PhasePayload; toolResult: string; carried: string[]; matched: Array<{ name: string; score: number }> }>(
        '/api/mcp/find-tools',
        { url: this.conn.url, query: String(call.arguments.query ?? ''), lastUserTurn: this.lastUserTurn },
      );
      // The person's own terms ride across every phase change.
      this.phaseKeyterms = r.phase.keyterms;
      const merged = mergeKeyterms(r.phase.keyterms, this.yours);
      const session = { ...r.phase.sessionUpdate.session, input: { ...(r.phase.sessionUpdate.session.input as Record<string, unknown>), keyterms: merged } };
      this.ui.phase({ ...r.phase, keyterms: merged }, `find_tools("${String(call.arguments.query ?? '')}")`);
      this.ui.keyterms(merged, this.yours);
      return {
        result: r.toolResult,
        sessionUpdate: { session },
        meta: { spoken: r.toolResult, phase: r.phase, carried: r.carried, matched: r.matched },
      };
    }
    // Nothing misheard gets executed: an identifier that did not come from the
    // keyboard or a tool waits for a paste, and an unconfirmed state change for a yes.
    const decision = this.gate.check(call.name, call.arguments, Date.now());
    if (decision.action !== 'execute') {
      this.ui.gateHeld(call, decision);
      return { result: decision.result, meta: { spoken: decision.card.say, method: `held: ${decision.action === 'confirm' ? 'changes state' : decision.action}` } };
    }
    if (decision.confirmed) this.ui.gateReleased(call);
    const r = await postJson<ToolOutcome & { result: string }>('/api/mcp/call', {
      url: this.conn.url,
      tool: call.name,
      arguments: call.arguments,
      question: this.lastUserTurn,
      session: this.sessionId,
    });
    this.gate.recordToolResult(r.raw ?? r.result, call.arguments);
    return { result: r.result, meta: r };
  }

  async stop(reason = 'ended by you'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.idleTick) clearInterval(this.idleTick);
    this.ui.idle(null);
    try {
      // session.end stops billing at once; just closing the socket leaves the
      // session resumable - and billable - for 30 seconds.
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'session.end' }));
    } catch { /* already gone */ }
    setTimeout(() => this.ws?.close(), 800);
    await this.audio.stop();
    this.ui.status('ended');
    this.ui.ended(reason);
  }
}
