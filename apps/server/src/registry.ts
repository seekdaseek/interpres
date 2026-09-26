/**
 * The registry index: every server that listed its tools without auth at the
 * Sep 26 recheck, built by scripts/registry-index-build.ts and loaded into
 * memory once at start. Search ranks it; discovery looks in it for a domain.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export type IndexEntry = { n: string; t?: string; u: string; h: string; k: number; x: string; d?: string };
export type IndexFile = { builtFrom: string; recheckAt: string; rule: string; count: number; entries: IndexEntry[] };

/** What the page gets for one server. */
export type RegistryServer = {
  name: string;
  title?: string;
  url: string;
  host: string;
  tools: number;
  transport: string;
  description?: string;
};

export const INDEX_PATH = 'apps/server/data/registry-index.json.gz';
export const SEARCH_LIMIT = 12;
export const PER_HOST = 2;
export const MIN_QUERY = 2;

/**
 * Lowercased copies only. Per-word arrays of every name, title and description
 * held 20.8 MB of heap after load; these strings hold 7.6 MB (measured Sep 26,
 * gc between). Queries stay at 7-8 ms.
 */
type Prepared = IndexEntry & { nl: string; tl: string; dl: string; hl: string };

const words = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function prepare(e: IndexEntry): Prepared {
  return { ...e, nl: e.n.toLowerCase(), tl: (e.t ?? '').toLowerCase(), dl: (e.d ?? '').toLowerCase(), hl: e.h.toLowerCase() };
}

export const toServer = (e: IndexEntry): RegistryServer => ({
  name: e.n, ...(e.t ? { title: e.t } : {}), url: e.u, host: e.h, tools: e.k, transport: e.x, ...(e.d ? { description: e.d } : {}),
});

/** The query's words, lowercased; words under two characters say too little to match on. */
export function queryTokens(q: string): string[] {
  return words(q.toLowerCase()).filter((t) => t.length >= MIN_QUERY);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One query word, and where it may sit: a whole host label, name segment or word, or the start of one. */
type Matcher = { t: string; hostExact: RegExp; hostStart: RegExp; segExact: RegExp; segStart: RegExp; wordExact: RegExp; wordStart: RegExp };

export function matcher(t: string): Matcher {
  const e = esc(t);
  return {
    t,
    hostExact: new RegExp(`(?:^|\\.)${e}(?:\\.|$)`),
    hostStart: new RegExp(`(?:^|\\.)${e}`),
    segExact: new RegExp(`(?:^|[./_-])${e}(?:[./_-]|$)`),
    segStart: new RegExp(`(?:^|[./_-])${e}`),
    wordExact: new RegExp(`(?:^|[^\\p{L}\\p{N}])${e}(?:[^\\p{L}\\p{N}]|$)`, 'u'),
    wordStart: new RegExp(`(?:^|[^\\p{L}\\p{N}])${e}`, 'u'),
  };
}

/** A whole unit scores `exact`, the start of one `start`, anywhere else `inner`, absent 0. */
const field = (s: string, t: string, exactRe: RegExp, startRe: RegExp, exact: number, start: number, inner: number) =>
  !s.includes(t) ? 0 : exactRe.test(s) ? exact : startRe.test(s) ? start : inner;

/**
 * How well one server matches every word: its best field per word, summed.
 * A word no field contains scores the server 0 - every word must match.
 */
export function scoreEntry(e: Prepared, ms: Matcher[], phrase: string): number {
  let total = 0;
  for (const m of ms) {
    const s = Math.max(
      field(e.hl, m.t, m.hostExact, m.hostStart, 10, 7, 6),
      field(e.nl, m.t, m.segExact, m.segStart, 8, 6, 5),
      field(e.tl, m.t, m.wordExact, m.wordStart, 7, 5, 4),
      field(e.dl, m.t, m.wordExact, m.wordStart, 3, 2, 1),
    );
    if (s === 0) return 0;
    total += s;
  }
  // The whole query as typed, inside the title or description: a small bonus.
  if (ms.length > 1 && (e.tl.includes(phrase) || e.dl.includes(phrase))) total += 2;
  return total;
}

export class Registry {
  readonly count: number;
  readonly recheckAt: string;
  readonly rule: string;
  private readonly entries: Prepared[];
  private readonly cache = new Map<string, RegistryServer[]>();
  private readonly cacheMax: number;

  constructor(file: IndexFile, opts: { cacheMax?: number } = {}) {
    this.entries = file.entries.map(prepare);
    this.count = file.count;
    this.recheckAt = file.recheckAt;
    this.rule = file.rule;
    this.cacheMax = opts.cacheMax ?? 500;
  }

  static load(path = INDEX_PATH): Registry {
    return new Registry(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as IndexFile);
  }

  /**
   * The top matches on name, host, title and description. At most two per host,
   * so the few hosts that serve thousands of registry entries cannot fill a
   * page; one URL is one server, whatever names point at it. Ties go by name,
   * so the order never changes between calls.
   */
  search(q: string, limit = SEARCH_LIMIT): { results: RegistryServer[]; cached: boolean } {
    const phrase = q.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = `${limit}\n${phrase}`;
    const hit = this.cache.get(key);
    if (hit) return { results: hit, cached: true };
    const matchers = queryTokens(phrase).map(matcher);
    const results: RegistryServer[] = [];
    if (matchers.length > 0) {
      const scored: Array<[number, Prepared]> = [];
      for (const e of this.entries) {
        const s = scoreEntry(e, matchers, phrase);
        if (s > 0) scored.push([s, e]);
      }
      scored.sort((a, b) => b[0] - a[0] || (a[1].n < b[1].n ? -1 : a[1].n > b[1].n ? 1 : 0));
      const perHost = new Map<string, number>();
      const seenUrl = new Set<string>();
      for (const [, e] of scored) {
        if (results.length >= limit) break;
        if (seenUrl.has(e.u) || (perHost.get(e.h) ?? 0) >= PER_HOST) continue;
        seenUrl.add(e.u);
        perHost.set(e.h, (perHost.get(e.h) ?? 0) + 1);
        results.push(toServer(e));
      }
    }
    if (this.cache.size >= this.cacheMax) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, results);
    return { results, cached: false };
  }

  /**
   * Servers a website may be pointing at: a remote on the domain or one of its
   * subdomains, or a registry name that starts with the domain reversed
   * (goji.agency -> agency.goji/...). The domain's own host first, then names,
   * then subdomains; one entry per URL.
   */
  forDomain(domain: string, max = 5): RegistryServer[] {
    const d = domain.toLowerCase();
    const rev = d.split('.').reverse().join('.');
    const rank = (e: Prepared) => (e.h === d ? 0 : e.nl === rev || e.nl.startsWith(`${rev}/`) || e.nl.startsWith(`${rev}.`) ? 1 : e.h.endsWith(`.${d}`) ? 2 : -1);
    const found: Array<[number, Prepared]> = [];
    for (const e of this.entries) {
      const r = rank(e);
      if (r >= 0) found.push([r, e]);
    }
    found.sort((a, b) => a[0] - b[0] || b[1].k - a[1].k || (a[1].n < b[1].n ? -1 : a[1].n > b[1].n ? 1 : 0));
    const out: RegistryServer[] = [];
    const seen = new Set<string>();
    for (const [, e] of found) {
      if (seen.has(e.u)) continue;
      seen.add(e.u);
      out.push(toServer(e));
      if (out.length >= max) break;
    }
    return out;
  }
}
