/**
 * The client side of the Voice Agent tool-call protocol, in one place.
 *
 * The browser, `scripts/e2e.ts` and `scripts/e2e-audio.ts` all drive this same
 * class, so whatever the proof scripts establish is established about the code
 * the browser runs - not about a copy of it.
 *
 * The rules come from the docs (client-side-tools, "Returning tool results"):
 *
 *   - "Send `tool.result` when `reply.done` is the latest event you've received."
 *   - Accumulate on `tool.call`, drain in the `reply.done` handler, AND drain from
 *     the tool handler too, because "your tool may return after `reply.done`
 *     already fired".
 *   - "Update `last_event` on `reply.started` / `input.speech.started` so results
 *     that become available mid-turn are held until that turn ends."
 *   - On `reply.done` with `status: "interrupted"`, "discard any pending
 *     `tool.result` accumulators from the just-ended reply".
 *
 * On top of that it knows when a turn is actually over, which the docs leave to
 * the client: sending a `tool.result` auto-fires the agent's next reply, so the
 * `reply.done` after that one is the answer, not the transition phrase.
 */

export type ServerEvent = { type: string; [k: string]: unknown };

export type ToolCall = { callId: string; name: string; arguments: Record<string, unknown> };

export type ExecResult = {
  /** JSON string, sent as `tool.result.result`. */
  result: string;
  /**
   * Sent before the result, when a tool changes what the agent can see -
   * `find_tools` swapping in a new phase. Must carry only mutable fields.
   */
  sessionUpdate?: Record<string, unknown>;
  /** Anything the caller wants back in its hooks: timings, shaping method. */
  meta?: Record<string, unknown>;
};

export type Executor = (call: ToolCall) => Promise<ExecResult>;

export type ProtocolHooks = {
  onToolCall?: (call: ToolCall) => void;
  /** After the result is queued. `ms` is the executor's own time. */
  onToolDone?: (call: ToolCall, exec: ExecResult, ms: number) => void;
  onToolError?: (call: ToolCall, error: unknown) => void;
  /** A queued result was actually sent - the moment speech can resume. */
  onResultsSent?: (callIds: string[]) => void;
  /** Every `reply.done` that is not an interruption. */
  onReplyDone?: (status: string) => void;
  /** The agent has nothing left to say and nothing in flight: the turn is over. */
  onTurnIdle?: () => void;
  /** The caller barged in. Flush playback. */
  onInterrupted?: () => void;
  /**
   * A tool finished after the reply it belonged to was interrupted, so its
   * result was dropped rather than delivered into the next turn.
   */
  onDropped?: (call: ToolCall) => void;
};

export class AgentProtocol {
  private readonly sendFn: (msg: Record<string, unknown>) => void;
  private readonly execute: Executor;
  private readonly hooks: ProtocolHooks;

  private lastEvent = '';
  private readonly pending: Array<{ call_id: string; result: string }> = [];
  /** Tool handlers still running. A turn is not over while any is. */
  private inFlight = 0;
  /** A result has gone out, so the next `reply.done` is the answer. */
  private awaitingAnswer = false;
  /**
   * Bumped on every interruption. A handler that finishes after the reply it
   * belonged to was interrupted must not deliver its result into the next turn.
   */
  private epoch = 0;

  constructor(send: (msg: Record<string, unknown>) => void, execute: Executor, hooks: ProtocolHooks = {}) {
    this.sendFn = send;
    this.execute = execute;
    this.hooks = hooks;
  }

  /** For the UI and the tests: what the protocol is waiting on. */
  get state(): { lastEvent: string; pending: number; inFlight: number; awaitingAnswer: boolean } {
    return { lastEvent: this.lastEvent, pending: this.pending.length, inFlight: this.inFlight, awaitingAnswer: this.awaitingAnswer };
  }

  /** Feed every server event, in order. */
  handle(msg: ServerEvent): void {
    switch (msg.type) {
      case 'reply.started':
      case 'input.speech.started':
        this.lastEvent = msg.type;
        return;
      case 'tool.call':
        this.onToolCall(msg);
        return;
      case 'reply.done':
        this.onReplyDone(msg);
        return;
      default:
        return;
    }
  }

  private onToolCall(msg: ServerEvent): void {
    const call: ToolCall = {
      callId: String(msg.call_id ?? ''),
      name: String(msg.name ?? ''),
      arguments: (msg.arguments && typeof msg.arguments === 'object' ? msg.arguments : {}) as Record<string, unknown>,
    };
    this.hooks.onToolCall?.(call);
    this.inFlight++;
    const epoch = this.epoch;
    const started = Date.now();

    void this.execute(call)
      .then((exec) => {
        if (epoch !== this.epoch) { this.hooks.onDropped?.(call); return; }   // its reply was interrupted
        if (exec.sessionUpdate) this.sendFn({ type: 'session.update', ...exec.sessionUpdate });
        this.pending.push({ call_id: call.callId, result: exec.result });
        this.hooks.onToolDone?.(call, exec, Date.now() - started);
      })
      .catch((err: unknown) => {
        if (epoch !== this.epoch) { this.hooks.onDropped?.(call); return; }
        this.hooks.onToolError?.(call, err);
        // The agent still needs an answer it can speak, or the turn stalls
        // until its own tool timeout.
        const detail = err instanceof Error ? err.message : String(err);
        this.pending.push({ call_id: call.callId, result: JSON.stringify({ error: `The tool failed: ${detail}` }) });
      })
      .finally(() => {
        if (epoch !== this.epoch) return;
        this.inFlight--;
        // "Call flushIfIdle() from the tool.call handler. Your tool may return
        // after reply.done already fired." Sending a result always produces one
        // more reply.done, so only that handler ever declares a turn over.
        this.flushIfIdle();
      });
  }

  private onReplyDone(msg: ServerEvent): void {
    this.lastEvent = 'reply.done';
    const status = String(msg.status ?? 'completed');
    if (status === 'interrupted') {
      this.epoch++;
      this.pending.length = 0;
      this.inFlight = 0;
      this.awaitingAnswer = false;
      this.hooks.onInterrupted?.();
      this.hooks.onTurnIdle?.();
      return;
    }
    this.hooks.onReplyDone?.(status);
    // Read before the flush, because the flush is what sets it.
    const wasAwaiting = this.awaitingAnswer;
    const flushed = this.flushIfIdle();
    if (this.inFlight > 0 || this.pending.length > 0) return;   // a tool is still running
    // Results went out just now, so an answer is coming - even if an earlier
    // flush had set awaitingAnswer. Measured: with warm MCP connections a chained
    // call finished before its reply's reply.done, and the turn was declared
    // over while the agent was about to speak.
    if (flushed) return;
    if (wasAwaiting) {
      // Results went out earlier, so this reply was the answer.
      this.awaitingAnswer = false;
      this.hooks.onTurnIdle?.();
      return;
    }
    if (this.awaitingAnswer) return;   // results just went out; the answer is next
    this.hooks.onTurnIdle?.();
  }

  /** Send whatever results are waiting, if the agent is between replies. True if any went out. */
  private flushIfIdle(): boolean {
    if (this.lastEvent !== 'reply.done' || this.pending.length === 0) return false;
    const ids: string[] = [];
    for (const p of this.pending) {
      this.sendFn({ type: 'tool.result', call_id: p.call_id, result: p.result });
      ids.push(p.call_id);
    }
    this.pending.length = 0;
    this.awaitingAnswer = true;
    this.hooks.onResultsSent?.(ids);
    return true;
  }
}
