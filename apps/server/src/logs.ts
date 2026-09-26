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

const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
/**
 * IPv6 in either the compressed form (any `::`) or the full eight-group form.
 * Requiring one of those two keeps clock times like `09:32:34` - two colons, no
 * `::` - from being mistaken for an address.
 */
const IPV6 = /(?:[0-9a-f]{0,4}:){1,7}:(?:[0-9a-f]{0,4}:){0,6}[0-9a-f]{0,4}|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi;

/**
 * No IP address is ever written to the log. Not the caller's (the rate limiter
 * keys on it and keeps it in memory only), and not one quoted in an error
 * either - an SSRF refusal says "resolves to 10.0.0.5", and that line would
 * otherwise carry the address straight into the file.
 */
export function redactIps(text: string): string {
  // IPv6 first: an IPv4-mapped address contains an IPv4 tail.
  return text.replace(IPV6, (m) => (m.includes('::') || (m.match(/:/g) ?? []).length === 7 ? '<ip>' : m)).replace(IPV4, '<ip>');
}

function scrubValue(v: unknown): unknown {
  if (typeof v === 'string') return redactIps(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') return scrub(v as Record<string, unknown>);
  return v;
}

export function scrub(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    // Keys that could only ever hold a client address are dropped outright,
    // rather than trusting redaction to catch every format. Checked before the
    // secret rule, which `clientKey` would otherwise match first and merely
    // redact to a length.
    if (/^(ip|clientIp|client_ip|remoteAddress|remote_address|cfConnectingIp|xForwardedFor|clientKey)$/i.test(k)) continue;
    if (FORBIDDEN.test(k)) {
      out[k] = typeof v === 'string' ? `<redacted ${v.length} chars>` : '<redacted>';
      continue;
    }
    out[k] = scrubValue(v);
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
