/**
 * Rate limiting for the token endpoint, which is what spends money.
 *
 * Two independent buckets: per-IP per hour stops one person burning the grant,
 * and a global daily cap stops everyone together doing it. Fixed windows, in
 * memory - one process, and a limiter that outlived a restart would need a
 * store we do not have a reason to run.
 */

export type Decision =
  | { allowed: true; remaining: number; globalRemaining: number }
  | { allowed: false; reason: 'per_ip' | 'global'; retryAfterSeconds: number };

type Bucket = { count: number; windowStart: number };

export class RateLimiter {
  readonly perIpPerHour: number;
  readonly globalPerDay: number;
  private readonly hourMs: number;
  private readonly dayMs: number;
  private readonly perIp = new Map<string, Bucket>();
  private global: Bucket = { count: 0, windowStart: 0 };

  constructor(opts: { perIpPerHour: number; globalPerDay: number; hourMs?: number; dayMs?: number }) {
    this.perIpPerHour = opts.perIpPerHour;
    this.globalPerDay = opts.globalPerDay;
    this.hourMs = opts.hourMs ?? 60 * 60 * 1000;
    this.dayMs = opts.dayMs ?? 24 * 60 * 60 * 1000;
  }

  /** Charge one unit to `key`. Call only when about to do the costly thing. */
  take(key: string, now: number = Date.now()): Decision {
    const globalWindow = Math.floor(now / this.dayMs);
    if (this.global.windowStart !== globalWindow) this.global = { count: 0, windowStart: globalWindow };
    if (this.global.count >= this.globalPerDay) {
      return { allowed: false, reason: 'global', retryAfterSeconds: this.secondsLeft(now, this.dayMs) };
    }

    const ipWindow = Math.floor(now / this.hourMs);
    const bucket = this.perIp.get(key);
    const fresh = bucket === undefined || bucket.windowStart !== ipWindow;
    const current = fresh ? { count: 0, windowStart: ipWindow } : bucket;
    if (current.count >= this.perIpPerHour) {
      return { allowed: false, reason: 'per_ip', retryAfterSeconds: this.secondsLeft(now, this.hourMs) };
    }

    current.count++;
    this.perIp.set(key, current);
    this.global.count++;
    this.sweep(ipWindow);
    return {
      allowed: true,
      remaining: this.perIpPerHour - current.count,
      globalRemaining: this.globalPerDay - this.global.count,
    };
  }

  private secondsLeft(now: number, windowMs: number): number {
    return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
  }

  /** Drop buckets from past windows so one IP per request cannot grow forever. */
  private sweep(currentWindow: number): void {
    if (this.perIp.size < 10_000) return;
    for (const [key, b] of this.perIp) if (b.windowStart !== currentWindow) this.perIp.delete(key);
  }

  get trackedKeys(): number {
    return this.perIp.size;
  }

  get globalUsed(): number {
    return this.global.count;
  }
}

/**
 * The key to charge.
 *
 * Deliberately NOT anything derived from `X-Forwarded-For` or a framework's
 * `req.ip`: a client can send whatever it likes in those, so a limiter keyed on
 * one is no limiter at all. `cf-connecting-ip` is set by Cloudflare itself, and
 * this service is only reachable through the tunnel, so nothing else can write
 * it. Without Cloudflare we fall back to the socket's own peer address.
 */
export function clientKey(
  headers: { get(name: string): string | null },
  remoteAddress: string | undefined,
): string {
  const cf = headers.get('cf-connecting-ip');
  if (cf !== null && cf.trim() !== '') return `cf:${cf.trim()}`;
  if (remoteAddress !== undefined && remoteAddress !== '') return `sock:${remoteAddress}`;
  return 'unknown';
}
