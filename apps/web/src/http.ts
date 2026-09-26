/**
 * Reading interpres's own API.
 *
 * The public URL sits behind Cloudflare, which can answer with its own HTML page
 * instead of our JSON - it did for every 502 we sent, until those became 424s.
 * So a body is read as text and parsed inside a try, and one that is not JSON
 * becomes a plain sentence with the status. Never a parser message like
 * `Unexpected token '<'`: that is what a judge saw on Sep 26.
 */
export type ApiFailure = {
  ok: false;
  /** 0 when the request never got an answer. */
  status: number;
  /** One plain sentence: the server's own, or ours when there was none. */
  message: string;
  code?: string;
  kind?: string;
  detail?: string;
  body?: Record<string, unknown>;
};

export type ApiResult<T> = { ok: true; status: number; data: T } | ApiFailure;

/** What to say when there is no JSON to read. */
export function noDetailsMessage(status: number): string {
  if (status === 0) return "Couldn't reach interpres. Check your connection and try again.";
  return `interpres answered ${status} without any details. Try again in a moment.`;
}

/** Parse a body that may or may not be JSON; never throws. */
export function readBody<T>(status: number, ok: boolean, text: string): ApiResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status, message: noDetailsMessage(status) };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { ok: false, status, message: noDetailsMessage(status) };
  const body = json as Record<string, unknown>;
  if (ok) return { ok: true, status, data: body as T };
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
  return {
    ok: false,
    status,
    message: str('error') ?? noDetailsMessage(status),
    code: str('code'),
    kind: str('kind'),
    detail: str('detail'),
    body,
  };
}

export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, message: noDetailsMessage(0) };
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    // A body cut off mid-read reads as no details.
  }
  return readBody<T>(res.status, res.ok, text);
}

export function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<ApiResult<T>> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}
