/**
 * What people type into the server box, turned into the URL interpres connects
 * to. The page runs this to show the result as it is typed; the server runs it
 * again on every request and is the authority.
 *
 * It decides only which address was meant. Whether that address is safe to
 * reach is the SSRF guard's job, and the guard runs after this, unchanged.
 */

export type UrlNote =
  /** No scheme was typed, so https:// was put in front. */
  | 'added_https'
  /** http:// was typed and replaced: interpres connects over https only. */
  | 'switched_to_https'
  /** Wrapping quotes, brackets or trailing punctuation were removed. */
  | 'cleaned';

export type UrlErrorCode = 'empty' | 'not_a_url' | 'bad_scheme' | 'has_credentials' | 'no_host';

export type NormalisedUrl =
  | { ok: true; url: string; notes: UrlNote[] }
  | { ok: false; code: UrlErrorCode; message: string };

/** Longer than any real endpoint; past this it is a paste accident. */
export const MAX_URL_CHARS = 2048;

/** Things people wrap a URL in: quotes of every kind, backticks, angle brackets. */
const LEADING = /^["'`<“”‘’«]+/;
const TRAILING = /["'`>“”‘’»]+$/;

/** Schemes that are schemes, even with no `//` after them. */
const KNOWN_SCHEMES = /^(?:https?|javascript|vbscript|data|file|ftps?|s?ftp|mailto|tel|sms|wss?|ssh|blob|about|chrome|view-source|git|irc|ldap|smb|telnet|gopher)$/i;

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** Sentence punctuation after a URL. A `)` or `]` goes only when nothing opened it. */
function stripTrailing(s: string): string {
  let out = s;
  for (;;) {
    const last = out.at(-1);
    if (last === '.' || last === ',' || last === ';') out = out.slice(0, -1);
    else if (last === ')' && count(out, ')') > count(out, '(')) out = out.slice(0, -1);
    else if (last === ']' && count(out, ']') > count(out, '[')) out = out.slice(0, -1);
    else return out;
  }
}

function clean(raw: string): string {
  let out = raw.trim();
  for (let before = ''; before !== out;) {
    before = out;
    out = stripTrailing(out.replace(LEADING, '').replace(TRAILING, '').trim()).trim();
  }
  return out;
}

const fail = (code: UrlErrorCode, message: string): NormalisedUrl => ({ ok: false, code, message });

export const URL_MESSAGES: Record<UrlErrorCode, string> = {
  empty: 'Type or paste a server address.',
  not_a_url: "That doesn't look like a web address. Try one like mcp.example.com/mcp.",
  bad_scheme: 'Only web addresses work here: http:// or https://.',
  has_credentials: 'interpres never sends credentials. Remove the user:password@ part of the address.',
  no_host: 'That address has no host name.',
};

/**
 * Normalise a typed or pasted server address.
 *
 * - trims, and strips wrapping quotes, backticks, angle brackets and trailing `.,;)]`
 * - no scheme gets https://; http:// becomes https://
 * - refuses every other scheme, and any user:password@
 * - lowercases the host and turns an IDN host into punycode, through `URL`
 * - keeps the path and the query; drops a #fragment, which no server ever sees
 */
export function normaliseServerUrl(raw: string): NormalisedUrl {
  if (typeof raw !== 'string') return fail('empty', URL_MESSAGES.empty);
  if (raw.length > MAX_URL_CHARS) return fail('not_a_url', 'That address is too long to be a server address.');
  const notes: UrlNote[] = [];
  const text = clean(raw);
  if (text === '') return fail('empty', URL_MESSAGES.empty);
  if (text !== raw.trim()) notes.push('cleaned');

  let candidate = text;
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):/i);
  if (text.startsWith('//')) {
    candidate = `https:${text}`;
    notes.push('added_https');
  } else if (scheme === null) {
    candidate = `https://${text}`;
    notes.push('added_https');
  } else if (!KNOWN_SCHEMES.test(scheme[1]!)) {
    const rest = text.slice(scheme[0].length);
    const authority = text.split(/[/?#]/)[0]!;
    // "goji.agency:443/mcp" is a host and a port, and "user:pw@host" is
    // credentials; neither is a scheme.
    if (/^\d+(?:[/?#]|$)/.test(rest) || authority.includes('@')) {
      candidate = `https://${text}`;
      notes.push('added_https');
    } else {
      return fail('bad_scheme', `${scheme[1]}: is not a web address. ${URL_MESSAGES.bad_scheme}`);
    }
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail('not_a_url', URL_MESSAGES.not_a_url);
  }

  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    notes.push('switched_to_https');
  } else if (url.protocol !== 'https:') {
    return fail('bad_scheme', `${url.protocol} is not a web address. ${URL_MESSAGES.bad_scheme}`);
  }
  if (url.username !== '' || url.password !== '') return fail('has_credentials', URL_MESSAGES.has_credentials);
  if (url.hostname === '') return fail('no_host', URL_MESSAGES.no_host);

  // A single typed word ("books") parses as a host, but it was never an
  // address. An explicit scheme or an IP literal is left to the SSRF guard.
  const isIpLiteral = /^\[.*\]$/.test(url.hostname) || /^\d+(?:\.\d+){3}$/.test(url.hostname);
  if (notes.includes('added_https') && !url.hostname.includes('.') && !isIpLiteral) {
    return fail('not_a_url', URL_MESSAGES.not_a_url);
  }

  url.hash = '';
  return { ok: true, url: url.href, notes };
}
