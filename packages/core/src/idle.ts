/**
 * Ends a voice session nobody is talking in.
 *
 * A Voice Agent session bills for as long as its WebSocket is open (docs,
 * billing-and-pricing, "Voice Agent API billing"), and the API has no inactivity
 * setting: the session-configuration reference has no timeout field (read
 * 2026-09-26). So an open, idle tab runs to the 300 s cap. This clock runs only
 * while nobody is speaking and nothing is pending: user speech resets it, and an
 * agent reply or a running tool holds it.
 *
 * Pure: the clock is passed in.
 */
export const IDLE_LIMIT_MS = 60_000;

export type Busy = 'user' | 'agent' | 'tool';

export class IdleClock {
  readonly limitMs: number;
  private readonly busy = new Map<Busy, number>();
  private idleSince: number;

  constructor(now: number, limitMs = IDLE_LIMIT_MS) {
    this.limitMs = limitMs;
    this.idleSince = now;
  }

  /** Something started that is not idleness: the person talking, a reply, a tool. */
  hold(what: Busy): void {
    this.busy.set(what, (this.busy.get(what) ?? 0) + 1);
  }

  /** It ended. When nothing else is going on, the idle clock starts from now. */
  release(what: Busy, now: number): void {
    const n = (this.busy.get(what) ?? 0) - 1;
    if (n > 0) this.busy.set(what, n);
    else this.busy.delete(what);
    if (this.busy.size === 0) this.idleSince = now;
  }

  /** The person spoke: whatever was counting starts over. */
  userSpoke(now: number): void {
    this.idleSince = now;
  }

  /** Milliseconds until the session should end, or null while something is going on. */
  remainingMs(now: number): number | null {
    if (this.busy.size > 0) return null;
    return Math.max(0, this.limitMs - (now - this.idleSince));
  }

  expired(now: number): boolean {
    return this.remainingMs(now) === 0;
  }
}
