/**
 * A website finds its MCP server.
 *
 * Runs when someone types a bare domain or a site root, or a URL that answers
 * but not as MCP. It looks in two places and stops at the first that answers
 * `initialize` + `tools/list`:
 *
 *   1. the registry index: a remote on the domain or a subdomain, or a registry
 *      name that starts with the domain reversed (goji.agency -> agency.goji/)
 *   2. probes: https://<domain>/mcp, /sse, https://mcp.<domain>/mcp, and for a
 *      site root the root itself, last
 *
 * Each place gets 5 s. The probe is the caller's: in the server it is the same
 * getCatalog path as a connect, so it goes through the SSRF guard, lists tools
 * and never calls one - and a hit is already cached when the page connects.
 */
import type { RegistryServer } from './registry.ts';

export const DISCOVERY_TIMEOUT_MS = 5_000;
export const DISCOVERY_CACHE_MS = 10 * 60 * 1000;
export const MAX_CANDIDATES = 5;

export type Candidate = {
  url: string;
  tools: number;
  source: 'registry' | 'probe';
  name?: string;
  title?: string;
  /** Said on the page: "Found in the official MCP registry" or "Found at /mcp". */
  note: string;
};

export type Discovery =
  | { kind: 'one'; domain: string; found: Candidate; tried: string[]; ms: number }
  | { kind: 'several'; domain: string; candidates: Candidate[]; tried: string[]; ms: number }
  | { kind: 'none'; domain: string; tried: string[]; ms: number };

/** Resolves with the tool count and names when the URL answers as MCP; throws otherwise. */
export type Probe = (url: string) => Promise<{ tools: number; title?: string }>;

export type DiscoverDeps = {
  forDomain: (domain: string) => RegistryServer[];
  probe: Probe;
  timeoutMs?: number;
  now?: () => number;
};

/** The domain a site is known by: its host, less a leading www. */
export function domainOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

/** A bare domain or a site root: nothing after the host but a slash. */
export function isSiteRoot(url: URL): boolean {
  return url.pathname === '/' && url.search === '';
}

const isIpLiteral = (host: string) => /^\[.*\]$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** The probe URLs for a domain, in the order they are tried. */
export function probeUrls(target: URL): string[] {
  const d = domainOf(target);
  const port = target.port ? `:${target.port}` : '';
  const out = [`https://${d}${port}/mcp`, `https://${d}${port}/sse`];
  if (!isIpLiteral(d) && !d.startsWith('mcp.')) out.push(`https://mcp.${d}${port}/mcp`);
  if (isSiteRoot(target)) out.push(target.href);
  return out;
}

export async function discover(target: URL, deps: DiscoverDeps, opts: { skip?: string[] } = {}): Promise<Discovery> {
  const now = deps.now ?? Date.now;
  const started = now();
  const timeoutMs = deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const domain = domainOf(target);
  const skip = new Set(opts.skip ?? []);
  const tried: string[] = [];

  // 1. The registry. Several entries are probed together, since a pick list
  //    needs each one's live tool count.
  const fromRegistry = deps.forDomain(domain).filter((s) => !skip.has(s.url)).slice(0, MAX_CANDIDATES);
  if (fromRegistry.length > 0) {
    tried.push(...fromRegistry.map((s) => s.url));
    const answered = await Promise.all(fromRegistry.map(async (s): Promise<Candidate | null> => {
      try {
        const p = await withTimeout(deps.probe(s.url), timeoutMs);
        // The registry's title first: a host serving many servers often gives them all one name.
        return { url: s.url, tools: p.tools, source: 'registry', name: s.name, title: s.title ?? p.title, note: 'Found in the official MCP registry' };
      } catch {
        return null;
      }
    }));
    const ok = answered.filter((c): c is Candidate => c !== null);
    if (ok.length === 1) return { kind: 'one', domain, found: ok[0]!, tried, ms: now() - started };
    if (ok.length > 1) return { kind: 'several', domain, candidates: ok, tried, ms: now() - started };
  }

  // 2. Probes, one at a time, stopping at the first that answers.
  for (const url of probeUrls(target)) {
    if (skip.has(url) || tried.includes(url)) continue;
    tried.push(url);
    try {
      const p = await withTimeout(deps.probe(url), timeoutMs);
      const path = new URL(url).pathname;
      return {
        kind: 'one', domain, tried, ms: now() - started,
        found: { url, tools: p.tools, source: 'probe', title: p.title, note: path === '/' ? 'Found at the site root' : `Found at ${path}` },
      };
    } catch {
      // Not MCP, not reachable, or refused by the guard: on to the next.
    }
  }
  return { kind: 'none', domain, tried, ms: now() - started };
}

/** Discovery results per domain, for ten minutes. */
export class DiscoveryCache {
  private readonly map = new Map<string, { at: number; result: Discovery }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DISCOVERY_CACHE_MS;
    this.max = opts.max ?? 500;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): Discovery | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) { this.map.delete(key); return undefined; }
    return hit.result;
  }

  set(key: string, result: Discovery): void {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { at: this.now(), result });
  }
}
