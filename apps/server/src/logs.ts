/**
 * Structured event log, one JSON object per line. It is what `docs/PROOF.md`
 * counts, so it records latency and outcomes and never a secret.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type Event = {
  at: string;
  kind:
    | 'token.minted' | 'token.refused' | 'token.error'
    | 'mcp.connect' | 'mcp.connect.failed' | 'mcp.cache.hit'
    | 'tool.call' | 'tool.call.failed'
    | 'find_tools'
    | 'shape';
  ms?: number;
  ok?: boolean;
  [k: string]: unknown;
};

/** Keys whose value must never be written, whatever a caller passes. */
const FORBIDDEN = /key|token|secret|authorization|password|credential/i;

export function scrub(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (FORBIDDEN.test(k)) {
      out[k] = typeof v === 'string' ? `<redacted ${v.length} chars>` : '<redacted>';
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrub(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class EventLog {
  readonly path: string;
  private ready: Promise<void> | null = null;
  private readonly recent: Event[] = [];
  private readonly recentMax = 500;

  constructor(path: string) {
    this.path = path;
  }

  /** Never throws: losing a log line must not fail a live voice turn. */
  async write(event: Event): Promise<void> {
    const line = { ...scrub(event), at: event.at, kind: event.kind };
    this.recent.push(line as Event);
    if (this.recent.length > this.recentMax) this.recent.shift();
    try {
      this.ready ??= mkdir(dirname(this.path), { recursive: true }).then(() => {});
      await this.ready;
      await appendFile(this.path, `${JSON.stringify(line)}\n`, 'utf8');
    } catch {
      // Disk full, read-only mount, whatever it is: the call still happened.
    }
  }

  record(kind: Event['kind'], fields: Record<string, unknown> = {}): void {
    void this.write({ at: new Date().toISOString(), kind, ...fields });
  }

  /** In-memory tail, for the status endpoint. */
  tail(n = 50): Event[] {
    return this.recent.slice(-n);
  }
}
