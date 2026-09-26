/**
 * One live conversation: token, socket, microphone, speaker, and the shared
 * tool-call protocol from `@interpres/core` - the same `AgentProtocol` class the
 * proof scripts drive.
 */
import { AgentProtocol } from '@interpres/core';
import type { ExecResult, ServerEvent, ToolCall } from '@interpres/core';
import { AudioEngine, fromBase64, toBase64 } from './audio.ts';

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
};

export type ConnectPayload = {
  url: string;
  greeting: string;
  phase: PhasePayload;
};

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(`${path} answered ${res.status} with non-JSON`); }
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${path} answered ${res.status}`);
  return json as T;
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
  sessionId = '';

  constructor(conn: ConnectPayload, ui: VoiceUi) {
    this.conn = conn;
    this.ui = ui;
  }

  get sampleRates(): { capture: number; playback: number } {
    return { capture: this.audio.captureRate, playback: this.audio.playbackRate };
  }

  /** Must be called from a click handler: audio contexts need a user gesture. */
  async start(): Promise<void> {
    this.ui.status('connecting');
    const tokenRes = await fetch('/api/token');
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as { token?: string; error?: string; maxSessionDurationSeconds?: number };
    if (!tokenRes.ok || !tokenBody.token) throw new Error(tokenBody.error ?? `Could not get a session token (${tokenRes.status}).`);
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
      (call) => this.execute(call),
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
        // Barge-in: stop the agent mid-word. The server decides whether it was a
        // real interruption and says so with reply.done status "interrupted".
        this.audio.flush();
        this.ui.status('hearing');
        break;
      case 'input.speech.stopped':
        this.ui.status('thinking');
        break;
      case 'transcript.user.delta':
        // The full transcript so far, not an increment: replace, never append.
        this.ui.userPartial(String(msg.text ?? ''));
        break;
      case 'transcript.user':
        this.lastUserTurn = String(msg.text ?? '');
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

  /** find_tools runs the phase planner on the server; every other tool calls the MCP server. */
  private async execute(call: ToolCall): Promise<ExecResult> {
    if (call.name === 'find_tools') {
      const r = await postJson<{ phase: PhasePayload; toolResult: string; carried: string[]; matched: Array<{ name: string; score: number }> }>(
        '/api/mcp/find-tools',
        { url: this.conn.url, query: String(call.arguments.query ?? ''), lastUserTurn: this.lastUserTurn },
      );
      this.ui.phase(r.phase, `find_tools("${String(call.arguments.query ?? '')}")`);
      return {
        result: r.toolResult,
        sessionUpdate: { session: r.phase.sessionUpdate.session },
        meta: { spoken: r.toolResult, phase: r.phase, carried: r.carried, matched: r.matched },
      };
    }
    const r = await postJson<ToolOutcome & { result: string }>('/api/mcp/call', {
      url: this.conn.url,
      tool: call.name,
      arguments: call.arguments,
      question: this.lastUserTurn,
    });
    return { result: r.result, meta: r };
  }

  async stop(reason = 'ended by you'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.endTimer) clearTimeout(this.endTimer);
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
