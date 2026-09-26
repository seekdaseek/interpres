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
import { SsrfError, guardedFetch, verifyUrl } from './ssrf.ts';

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
      parts.push(typeof code === 'string' && !cur.message.includes(code) ? `${cur.message} [${code}]` : cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.filter(Boolean).join(' <- ');
}

export function classifyError(err: unknown): { classification: string; detail: string } {
  if (err instanceof SsrfError) return { classification: err.code, detail: err.message };
  const message = describeError(err);
  if (/\b(401|403)\b|unauthor|forbidden|invalid.token|api.key|authentication/i.test(message)) {
    return { classification: 'auth_required', detail: message };
  }
  if (/\b(404|405|410)\b|not found|method not allowed/i.test(message)) {
    return { classification: 'unreachable', detail: message };
  }
  if (/\b(5\d\d)\b|bad gateway|service unavailable|gateway timeout/i.test(message)) {
    return { classification: 'unreachable', detail: message };
  }
  if (/timeout|timed out|abort|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|socket/i.test(message)) {
    return { classification: 'unreachable', detail: message };
  }
  return { classification: 'protocol_error', detail: message };
}

type OpenResult = { client: Client; transport: Transport };

/** guardedFetch with extra request headers - a User-Agent for the sweep. */
function fetchWithHeaders(extra: Record<string, string> | undefined): typeof guardedFetch {
  if (!extra || Object.keys(extra).length === 0) return guardedFetch;
  return (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return guardedFetch(input, { ...init, headers });
  };
}

async function openWith(url: URL, kind: Transport, timeoutMs: number, headers?: Record<string, string>): Promise<OpenResult> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const fetch = fetchWithHeaders(headers);
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
  const { url } = await verifyUrl(rawUrl);

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
 * Call one tool. `toolName` must already be the server's own name, mapped back
 * from the Voice Agent name by the caller.
 */
export async function callTool(
  rawUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<CallOutcome> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const { url } = await verifyUrl(rawUrl);
  const started = Date.now();

  let opened: OpenResult;
  try {
    opened = await openWith(url, 'streamable-http', timeoutMs);
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    if (!worthFallingBack(err)) {
      const { classification, detail } = classifyError(err);
      throw new McpError(classification, detail);
    }
    try {
      opened = await openWith(url, 'sse', timeoutMs);
    } catch {
      const { classification, detail } = classifyError(err);
      throw new McpError(classification, detail);
    }
  }

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
