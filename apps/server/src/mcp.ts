/**
 * Talking to a remote MCP server on the caller's behalf.
 *
 * Streamable HTTP first, SSE as a fallback, both driven through `guardedFetch`
 * so the SSRF guard covers every request either transport makes - not just the
 * first one. No auth header ever leaves here: interpres connects to no-auth
 * servers only, and the AssemblyAI key is never forwarded to a third party.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpInitializeResult, McpTool } from '@interpres/core';
import { SsrfError, WARM, ensureVerified, guardedFetch } from './ssrf.ts';

export const CLIENT_INFO = { name: 'interpres', version: '0.1.0' } as const;

export type Transport = 'streamable-http' | 'sse';

export type McpConnection = {
  url: string;
  transport: Transport;
  serverInfo: McpInitializeResult['serverInfo'];
  instructions?: string;
  capabilities: Record<string, unknown>;
  tools: McpTool[];
};

export type McpProbeFailure = {
  url: string;
  /** `auth_required`, `unreachable`, `protocol_error`, or an SSRF code. */
  classification: string;
  detail: string;
};

export class McpError extends Error {
  readonly classification: string;
  readonly detail: string;

  constructor(classification: string, detail: string) {
    super(`${classification}: ${detail}`);
    this.name = 'McpError';
    this.classification = classification;
    this.detail = detail;
  }
}

/**
 * Classify a failure the way `docs/SWEEP.md` reports it. An auth wall is a
 * perfectly healthy server we simply cannot use, and must not be counted as
 * broken.
 */
/**
 * The message plus its `cause` chain. Undici reports every network failure as
 * a bare "fetch failed" and puts ENOTFOUND / ECONNREFUSED / the TLS error on
 * `cause`, so without this a dead host and a bad certificate read the same.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== undefined && cur !== null; depth++) {
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code;
      // The SDK's transport errors put the HTTP status on `code` as a number and
      // only the response body in the message, so without this the status is lost.
      if (typeof code === 'number' && code >= 100 && code <= 599) parts.push(`${cur.message} [HTTP ${code}]`);
      else parts.push(typeof code === 'string' && !cur.message.includes(code) ? `${cur.message} [${code}]` : cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.filter(Boolean).join(' <- ');
}

/** The HTTP status an error carried: the `[HTTP nnn]` describeError adds, or an explicit "HTTP nnn". */
export function httpStatus(detail: string): number | null {
  const m = detail.match(/\[HTTP (\d{3})\]/) ?? detail.match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/** Words an auth wall uses, whatever status it was sent with. */
const AUTH_WORDS = /unauthori[sz]ed|unauthenticated|forbidden|invalid.token|api.key|authentication|authorization|bearer/i;

/**
 * Classifies on the status first. After that only words decide, never a bare
 * number: the message holds the response body, and `font-weight: 500` in a
 * challenge page is not a 5xx. Measured in the Sep 26 sweep, where bare numbers
 * produced codes like http_120 and http_348.
 */
export function classifyError(err: unknown): { classification: string; detail: string } {
  if (err instanceof SsrfError) return { classification: err.code, detail: err.message };
  const message = describeError(err);
  const status = httpStatus(message);
  // 402 is a payment wall: like auth, it needs something interpres never sends.
  if (status === 401 || status === 402 || status === 403) return { classification: 'auth_required', detail: message };
  if (status === 404 || status === 405 || status === 408 || status === 410 || status === 429 || (status !== null && status >= 500)) {
    return { classification: 'unreachable', detail: message };
  }
  if (AUTH_WORDS.test(message)) return { classification: 'auth_required', detail: message };
  if (status === null) {
    if (/not found|method not allowed|bad gateway|service unavailable|gateway timeout/i.test(message)) {
      return { classification: 'unreachable', detail: message };
    }
    if (/timeout|timed out|abort|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|socket/i.test(message)) {
      return { classification: 'unreachable', detail: message };
    }
  }
  return { classification: 'protocol_error', detail: message };
}

export type OpenResult = { client: Client; transport: Transport };

/** guardedFetch with extra request headers - a User-Agent for the sweep. */
function fetchWithHeaders(extra: Record<string, string> | undefined): typeof guardedFetch {
  if (!extra || Object.keys(extra).length === 0) return guardedFetch;
  return (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return guardedFetch(input, { ...init, headers });
  };
}

export type Opener = (url: URL, kind: Transport, timeoutMs: number) => Promise<OpenResult>;

async function openWith(url: URL, kind: Transport, timeoutMs: number, headers?: Record<string, string>, fetchImpl?: typeof guardedFetch): Promise<OpenResult> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const fetch = fetchImpl ?? fetchWithHeaders(headers);
  const transport =
    kind === 'streamable-http'
      ? new StreamableHTTPClientTransport(url, { fetch })
      : new SSEClientTransport(url, { fetch });
  // The SDK sends `initialize` and the `notifications/initialized` that stateful
  // servers require, and tracks Mcp-Session-Id for us.
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (err) {
    // A failed connect must still release the transport: an SSE event source
    // left open keeps reconnecting in the background, to a server that already
    // said no.
    await client.close().catch(() => {});
    throw err;
  }
  return { client, transport: kind };
}

/**
 * Could the legacy SSE transport change the outcome? Not after an auth refusal
 * (same server, same missing credential), and not after a network-level failure
 * (same host) - trying anyway doubles the wait on every dead URL. It can after
 * an HTTP-level rejection of the POST or a response that is not MCP at all,
 * which is what an SSE-only server gives a Streamable HTTP client.
 */
export function worthFallingBack(err: unknown): boolean {
  if (err instanceof SsrfError) return false;
  const { classification, detail } = classifyError(err);
  if (classification === 'auth_required') return false;
  return !/timeout|timed out|aborted|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|certificate|CERT_|TLS|SSL|self.signed/i.test(detail);
}

/**
 * Connect, list tools, disconnect.
 *
 * `tools/list` is the only call made. Nothing here ever invokes a tool, which is
 * what makes it safe to point at a stranger's server.
 */
export async function probeServer(
  rawUrl: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<McpConnection> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // Vet before either transport opens, so a bad URL fails the same way for both.
  const url = await ensureVerified(rawUrl);

  let opened: OpenResult | undefined;
  let firstFailure: unknown;
  try {
    opened = await openWith(url, 'streamable-http', timeoutMs, opts.headers);
  } catch (err) {
    firstFailure = err;
    // An SSRF refusal is final: falling back would just re-refuse.
    if (err instanceof SsrfError) throw err;
    if (!worthFallingBack(err)) {
      const { classification, detail } = classifyError(err);
      throw new McpError(classification, detail);
    }
    try {
      opened = await openWith(url, 'sse', timeoutMs, opts.headers);
    } catch {
      // Report the Streamable HTTP failure: it is the transport the spec
      // prefers, so its error describes the server better than the fallback's.
      const { classification, detail } = classifyError(firstFailure);
      throw new McpError(classification, detail);
    }
  }

  const { client, transport } = opened;
  try {
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    const version = client.getServerVersion();
    return {
      url: url.href,
      transport,
      serverInfo: version ? { name: version.name, version: version.version, title: (version as { title?: string }).title } : undefined,
      instructions: client.getInstructions(),
      capabilities: (client.getServerCapabilities() ?? {}) as Record<string, unknown>,
      tools: listed.tools as McpTool[],
    };
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    const { classification, detail } = classifyError(err);
    throw new McpError(classification, detail);
  } finally {
    await client.close().catch(() => {});
  }
}

export type CallOutcome = {
  result: Record<string, unknown>;
  transport: Transport;
  durationMs: number;
};

/**
 * Open a client: Streamable HTTP first, SSE only when the failure says the
 * server may simply be SSE-only. Errors come out classified.
 */
async function openWithFallback(url: URL, timeoutMs: number, opener: Opener): Promise<OpenResult> {
  try {
    return await opener(url, 'streamable-http', timeoutMs);
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    if (!worthFallingBack(err)) {
      const { classification, detail } = classifyError(err);
      throw new McpError(classification, detail);
    }
    try {
      return await opener(url, 'sse', timeoutMs);
    } catch {
      const { classification, detail } = classifyError(err);
      throw new McpError(classification, detail);
    }
  }
}

/** A warm client is closed after this long unused. */
export const POOL_IDLE_MS = 60_000;
/** At most this many warm clients; the least recently used is closed first. */
export const POOL_MAX = 32;

/** The server forgot the session - a restart, its own idle timeout - or the transport closed. */
export function sessionGone(err: unknown): boolean {
  const d = describeError(err);
  return httpStatus(d) === 404 || /not connected|session (not found|expired|terminated)/i.test(d);
}

type Warm = { key: string; opened: OpenResult; timer?: ReturnType<typeof setTimeout> };

/**
 * One MCP client per (voice session, server URL), kept for the session's life.
 * Opening one costs initialize, notifications/initialized and, on close, a
 * DELETE: round trips that used to sit on the speech path for every call.
 */
export class McpPool {
  private readonly warm = new Map<string, Warm>();
  private readonly opening = new Map<string, Promise<Warm>>();
  private readonly idleMs: number;
  private readonly max: number;
  private readonly opener: Opener;
  /** Clients opened over the pool's life. */
  opened = 0;

  constructor(opts: { idleMs?: number; max?: number; opener?: Opener } = {}) {
    this.idleMs = opts.idleMs ?? POOL_IDLE_MS;
    this.max = opts.max ?? POOL_MAX;
    this.opener = opts.opener ?? ((url, kind, timeoutMs) => openWith(url, kind, timeoutMs));
  }

  async call(poolKey: string, url: URL, toolName: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ result: Record<string, unknown>; transport: Transport }> {
    const key = `${poolKey}\n${url.href}`;
    let w = await this.get(key, url, timeoutMs);
    try {
      return await this.run(w, toolName, args, timeoutMs);
    } catch (err) {
      if (!sessionGone(err)) throw err;
      // Reopen once: a second failure is the server's answer, not a stale session.
      await this.drop(key);
      w = await this.get(key, url, timeoutMs);
      return await this.run(w, toolName, args, timeoutMs);
    }
  }

  private async run(w: Warm, toolName: string, args: Record<string, unknown>, timeoutMs: number) {
    this.touch(w);
    const result = await w.opened.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs });
    this.touch(w);
    return { result: result as Record<string, unknown>, transport: w.opened.transport };
  }

  private async get(key: string, url: URL, timeoutMs: number): Promise<Warm> {
    const hit = this.warm.get(key);
    if (hit) return hit;
    // Two calls racing on a cold key share one open.
    let p = this.opening.get(key);
    if (!p) {
      p = openWithFallback(url, timeoutMs, this.opener).then((opened) => {
        this.opened++;
        const w: Warm = { key, opened };
        this.warm.set(key, w);
        while (this.warm.size > this.max) void this.drop(this.warm.keys().next().value!);
        return w;
      }).finally(() => this.opening.delete(key));
      this.opening.set(key, p);
    }
    return p;
  }

  /** Most recently used last, and the idle clock starts over. */
  private touch(w: Warm): void {
    if (!this.warm.has(w.key)) return;
    this.warm.delete(w.key);
    this.warm.set(w.key, w);
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => void this.drop(w.key), this.idleMs);
    w.timer.unref?.();
  }

  async drop(key: string): Promise<void> {
    const w = this.warm.get(key);
    if (!w) return;
    this.warm.delete(key);
    if (w.timer) clearTimeout(w.timer);
    await w.opened.client.close().catch(() => {});
  }

  get size(): number {
    return this.warm.size;
  }
}

export const pool = new McpPool();

/**
 * Call one tool. `toolName` must already be the server's own name, mapped back
 * from the Voice Agent name by the caller.
 */
export async function callTool(
  rawUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; poolKey?: string } = {},
): Promise<CallOutcome> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const url = await ensureVerified(rawUrl);
  const started = Date.now();

  if (WARM && opts.poolKey) {
    try {
      const { result, transport } = await pool.call(opts.poolKey, url, toolName, args, timeoutMs);
      return { result, transport, durationMs: Date.now() - started };
    } catch (err) {
      if (err instanceof SsrfError || err instanceof McpError) throw err;
      const { classification, detail } = classifyError(err);
      throw new McpError(classification, detail);
    }
  }

  // Cold: a client for this one call.
  const opened = await openWithFallback(url, timeoutMs, (u, kind, t) => openWith(u, kind, t));

  try {
    const result = await opened.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs });
    return { result: result as Record<string, unknown>, transport: opened.transport, durationMs: Date.now() - started };
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    const { classification, detail } = classifyError(err);
    throw new McpError(classification, detail);
  } finally {
    await opened.client.close().catch(() => {});
  }
}
