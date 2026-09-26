/**
 * SSRF guard for user-supplied MCP server URLs.
 *
 * Anyone can paste a URL into the demo, and the server then fetches it. So:
 *
 *   - https only
 *   - every address the hostname resolves to must be publicly routable
 *   - the socket is PINNED to those verified addresses, which closes the
 *     DNS-rebinding window between the check and the request
 *   - redirects are never followed
 *   - 10 second timeout, 512 KB response cap
 *
 * Pinning is the part worth spelling out. Resolving, approving, and then calling
 * fetch() leaves the hostname free to resolve again - to 169.254.169.254, say -
 * on the request itself. Undici's `connect.lookup` hook is handed the verified
 * addresses and nothing else, while TLS still sees the real hostname, so the
 * certificate check is unaffected.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';

export const TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const DNS_TIMEOUT_MS = 5_000;

export type SsrfCode =
  | 'not_a_url'
  | 'bad_scheme'
  | 'no_host'
  | 'has_credentials'
  | 'dns_failed'
  | 'blocked_address'
  | 'redirect_refused'
  | 'too_large'
  | 'timeout';

export class SsrfError extends Error {
  // Written out rather than declared as a constructor parameter property:
  // Node's type-stripping refuses those, since they emit runtime assignments.
  // `erasableSyntaxOnly` in tsconfig.json makes tsc reject them too.
  readonly code: SsrfCode;

  constructor(code: SsrfCode, message: string) {
    super(message);
    this.name = 'SsrfError';
    this.code = code;
  }
}

/** [network, prefix length] pairs, as strings for legibility. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],          // "this" network
  ['10.0.0.0', 8],         // private
  ['100.64.0.0', 10],      // carrier NAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local, and cloud metadata at 169.254.169.254
  ['172.16.0.0', 12],      // private
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 relay anycast
  ['192.168.0.0', 16],     // private
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved
  ['255.255.255.255', 32], // broadcast
];

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 128],             // unspecified
  ['::1', 128],            // loopback
  ['64:ff9b::', 96],       // NAT64
  ['100::', 64],           // discard-only
  ['2001:db8::', 32],      // documentation
  ['2002::', 16],          // 6to4
  ['fc00::', 7],           // unique local
  ['fe80::', 10],          // link-local
  ['ff00::', 8],           // multicast
];

function v4ToBigInt(addr: string): bigint {
  const parts = addr.split('.');
  if (parts.length !== 4) throw new SsrfError('blocked_address', `not an IPv4 address: ${addr}`);
  let n = 0n;
  for (const p of parts) {
    const byte = Number(p);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new SsrfError('blocked_address', `not an IPv4 address: ${addr}`);
    }
    n = (n << 8n) | BigInt(byte);
  }
  return n;
}

function v6ToBigInt(addr: string): bigint {
  let a = addr.toLowerCase();
  // Strip a zone index: fe80::1%eth0.
  const pct = a.indexOf('%');
  if (pct >= 0) a = a.slice(0, pct);
  // An embedded IPv4 tail, as in ::ffff:127.0.0.1 or 64:ff9b::192.168.0.1.
  const dotted = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = v4ToBigInt(dotted[1]!);
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    a = `${a.slice(0, dotted.index)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const [head = '', tail = ''] = a.includes('::') ? a.split('::') : [a, ''];
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 0 && a.includes('::')) throw new SsrfError('blocked_address', `not an IPv6 address: ${addr}`);
  const groups = a.includes('::')
    ? [...headGroups, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tailGroups]
    : headGroups;
  if (groups.length !== 8) throw new SsrfError('blocked_address', `not an IPv6 address: ${addr}`);
  let n = 0n;
  for (const g of groups) {
    const v = Number.parseInt(g === '' ? '0' : g, 16);
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      throw new SsrfError('blocked_address', `not an IPv6 address: ${addr}`);
    }
    n = (n << 16n) | BigInt(v);
  }
  return n;
}

function inRange(value: bigint, network: bigint, prefix: number, bits: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(bits - prefix);
  return value >> shift === network >> shift;
}

/**
 * An IPv4-mapped or IPv4-compatible IPv6 address carries a v4 address inside it,
 * and `::ffff:127.0.0.1` reaches loopback just as `127.0.0.1` does. Unmap it so
 * it is judged by the v4 rules.
 */
export function unmapIpv4(addr: string): string | null {
  const m = addr.toLowerCase().match(/^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (m) return m[1]!;
  const hexMapped = addr.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** Is this literal address safe to connect to? */
export function isPublicAddress(addr: string): boolean {
  const unmapped = unmapIpv4(addr);
  const target = unmapped ?? addr;
  const family = isIP(target);
  if (family === 4) {
    const v = v4ToBigInt(target);
    return !BLOCKED_V4.some(([net, prefix]) => inRange(v, v4ToBigInt(net), prefix, 32));
  }
  if (family === 6) {
    const v = v6ToBigInt(target);
    return !BLOCKED_V6.some(([net, prefix]) => inRange(v, v6ToBigInt(net), prefix, 128));
  }
  return false;
}

export type VerifiedTarget = {
  url: URL;
  /** Every address the hostname resolved to; all of them verified public. */
  addresses: Array<{ address: string; family: number }>;
};

/**
 * Parse and vet a user-supplied URL. Throws `SsrfError` with a code the API can
 * turn into a message the user can act on.
 */
export async function verifyUrl(raw: string): Promise<VerifiedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('not_a_url', 'That is not a URL.');
  }
  if (url.protocol !== 'https:') {
    throw new SsrfError('bad_scheme', 'Only https:// MCP servers are accepted.');
  }
  if (url.hostname === '') throw new SsrfError('no_host', 'The URL has no host.');
  if (url.username !== '' || url.password !== '') {
    // Credentials in the URL would be forwarded to a third-party server.
    throw new SsrfError('has_credentials', 'Remove the credentials from the URL.');
  }

  const literal = isIP(url.hostname.replace(/^\[|\]$/g, ''));
  if (literal !== 0) {
    const addr = url.hostname.replace(/^\[|\]$/g, '');
    if (!isPublicAddress(addr)) {
      throw new SsrfError('blocked_address', `${addr} is not a publicly routable address.`);
    }
    return { url, addresses: [{ address: addr, family: literal }] };
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    // The system resolver has no timeout of its own worth relying on; a slow
    // one would otherwise hold a request open far past TIMEOUT_MS.
    let timer: ReturnType<typeof setTimeout> | undefined;
    resolved = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch {
    throw new SsrfError('dns_failed', `Could not resolve ${url.hostname}.`);
  }
  if (resolved.length === 0) throw new SsrfError('dns_failed', `${url.hostname} resolved to nothing.`);

  // EVERY address must pass. One public and one private answer is the
  // rebinding setup, so a single bad address disqualifies the host.
  for (const r of resolved) {
    if (!isPublicAddress(r.address)) {
      throw new SsrfError('blocked_address', `${url.hostname} resolves to ${r.address}, which is not publicly routable.`);
    }
  }
  return { url, addresses: resolved };
}

/** Count bytes through the body and fail past the cap, without buffering it. */
function capBody(body: ReadableStream<Uint8Array> | null, max: number): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          controller.error(new SsrfError('too_large', `Response exceeded ${max} bytes.`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * The rules applied to a response once the socket is already vetted: no
 * redirects, and no body over the cap. Separate from `guardedFetch` so both can
 * be tested without a network.
 */
export function enforceResponsePolicy(res: Response, host: string): Response {
  if (res.status >= 300 && res.status < 400) {
    // A redirect would send the next request somewhere we never vetted.
    void res.body?.cancel().catch(() => {});
    throw new SsrfError('redirect_refused', `${host} answered ${res.status}; redirects are not followed.`);
  }

  const declaredHeader = res.headers.get('content-length');
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      void res.body?.cancel().catch(() => {});
      throw new SsrfError('too_large', `Response declared ${declared} bytes, over the ${MAX_RESPONSE_BYTES} cap.`);
    }
  }

  return new Response(capBody(res.body, MAX_RESPONSE_BYTES), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * A `fetch` that only ever reaches vetted, publicly routable addresses. Shaped
 * to the SDK's `FetchLike` so the MCP transports can use it unchanged, which
 * means the guard covers every request they make, not just the first.
 */
export async function guardedFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const target = await verifyUrl(raw);

  const agent = new Agent({
    connect: {
      // Handed only the addresses we verified. TLS still sees the hostname, so
      // certificate validation is untouched.
      lookup(_hostname, _options, cb) {
        cb(null, target.addresses.map((a) => ({ address: a.address, family: a.family })));
      },
    },
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new SsrfError('timeout', `No response within ${TIMEOUT_MS}ms.`)), TIMEOUT_MS);
  // Honour a caller's own signal as well as our timeout.
  const callerSignal = init.signal ?? (input instanceof Request ? input.signal : null);
  if (callerSignal) callerSignal.addEventListener('abort', () => ac.abort(callerSignal.reason), { once: true });

  try {
    const res = await undiciFetch(target.url.href, {
      ...(init as Record<string, unknown>),
      method: init.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: init.headers ?? (input instanceof Request ? input.headers : undefined),
      body: init.body ?? undefined,
      signal: ac.signal,
      redirect: 'manual',
      dispatcher: agent,
    } as never) as unknown as Response;

    return enforceResponsePolicy(res as unknown as Response, target.url.host);
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    if (ac.signal.aborted && ac.signal.reason instanceof SsrfError) throw ac.signal.reason;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new SsrfError('timeout', `No response within ${TIMEOUT_MS}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    void agent.close().catch(() => {});
  }
}
