/**
 * Every failure a route can report, as a status and a sentence a person can act
 * on.
 *
 * No route answers 502, 503 or 504. Cloudflare sits in front of the public URL
 * and replaces an origin's 502/504 body with its own HTML page, so the JSON we
 * sent never arrived and the page showed a JSON parser error instead (measured
 * Sep 26, data/public-matrix-before.json). A failure upstream of us - the MCP
 * server, or AssemblyAI's token service - is 424 Failed Dependency; our own bugs
 * stay 500; a bad request stays 400.
 */
import { URL_MESSAGES, normaliseServerUrl } from '@interpres/core';
import type { UrlErrorCode } from '@interpres/core';
import { SsrfError } from './ssrf.ts';
import { McpError, httpStatus } from './mcp.ts';

/** The status for a failure that happened past our origin. */
export const UPSTREAM_FAILED = 424;

export type FailureKind =
  | 'input' | 'blocked' | 'auth' | 'not_mcp' | 'unreachable' | 'busy' | 'server_error'
  | 'redirect' | 'too_large' | 'internal';

export type FailureBody = {
  /** One plain sentence with a next step. This is what the page and the agent show. */
  error: string;
  /** The machine code: an SSRF code, an MCP classification, or a URL code. */
  code: string;
  kind: FailureKind;
  /** What actually happened, clipped. Shown folded on the page; never logged publicly. */
  detail?: string;
};

export type Failure = { status: 400 | 424 | 500; body: FailureBody };

export const MESSAGES = {
  auth: 'This server needs a login. interpres only connects to servers that need none, and never sends credentials.',
  notMcp: 'That address answered, but not as an MCP server. MCP endpoints usually end in /mcp or /sse.',
  unreachable: "Couldn't reach it. Check the address and try again.",
  busy: 'That server is turning requests away right now. Try again in a minute.',
  serverError: (status: number) => `That server answered with an error (${status}). Try again in a minute, or try another server.`,
  tooLarge: 'That server sent more than interpres accepts in one answer (512 KB).',
  internal: 'Something broke inside interpres. Try again; if it keeps happening, it is our bug.',
} as const;

const clip = (s: string, n = 300) => (s.length <= n ? s : `${s.slice(0, n)}…`);

/** A URL the normaliser refused. */
export class UrlError extends Error {
  readonly code: UrlErrorCode;
  constructor(code: UrlErrorCode, message: string) {
    super(message);
    this.name = 'UrlError';
    this.code = code;
  }
}

/** The normalised URL, or a UrlError the route turns into a 400. */
export function requireServerUrl(raw: unknown): { url: string; notes: string[] } {
  if (typeof raw !== 'string') throw new UrlError('empty', URL_MESSAGES.empty);
  const r = normaliseServerUrl(raw);
  if (!r.ok) throw new UrlError(r.code, r.message);
  return { url: r.url, notes: r.notes };
}

/** An MCP failure's kind: the classification first, then the HTTP status it carried. */
export function mcpKind(classification: string, detail: string): FailureKind {
  if (classification === 'auth_required') return 'auth';
  if (classification === 'protocol_error') return 'not_mcp';
  const status = httpStatus(detail);
  if (status === 404 || status === 405 || status === 410) return 'not_mcp';
  if (status === 429) return 'busy';
  if (status !== null && status >= 500) return 'server_error';
  return 'unreachable';
}

export function explainFailure(err: unknown): Failure {
  if (err instanceof UrlError) return { status: 400, body: { error: err.message, code: err.code, kind: 'input' } };
  if (err instanceof SsrfError) {
    switch (err.code) {
      case 'blocked_address':
        // The guard's own wording: it names the address and why.
        return { status: 400, body: { error: err.message, code: err.code, kind: 'blocked' } };
      case 'dns_failed':
        return { status: 400, body: { error: MESSAGES.unreachable, code: err.code, kind: 'unreachable', detail: err.message } };
      case 'timeout':
        return { status: UPSTREAM_FAILED, body: { error: MESSAGES.unreachable, code: err.code, kind: 'unreachable', detail: err.message } };
      case 'redirect_refused':
        return { status: 400, body: { error: `${err.message} Paste the address it redirects to.`, code: err.code, kind: 'redirect' } };
      case 'too_large':
        return { status: 400, body: { error: MESSAGES.tooLarge, code: err.code, kind: 'too_large', detail: err.message } };
      default:
        return { status: 400, body: { error: err.message, code: err.code, kind: 'input' } };
    }
  }
  if (err instanceof McpError) {
    const kind = mcpKind(err.classification, err.detail);
    const status = httpStatus(err.detail);
    const error =
      kind === 'auth' ? MESSAGES.auth
        : kind === 'not_mcp' ? MESSAGES.notMcp
          : kind === 'busy' ? MESSAGES.busy
            : kind === 'server_error' ? MESSAGES.serverError(status ?? 500)
              : MESSAGES.unreachable;
    return { status: UPSTREAM_FAILED, body: { error, code: err.classification, kind, detail: clip(err.detail) } };
  }
  return { status: 500, body: { error: MESSAGES.internal, code: 'internal', kind: 'internal', detail: clip(err instanceof Error ? err.message : String(err)) } };
}
