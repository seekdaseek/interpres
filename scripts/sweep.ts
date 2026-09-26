/**
 * Sweep the official MCP registry: which remote MCP servers could interpres
 * talk to, and how does the converter handle their tools?
 *
 * `initialize` + `tools/list` ONLY. Never calls a tool. Every request carries a
 * User-Agent naming this repository, runs through the same SSRF guard as the
 * product, and uses the product's own `probeServer`, so an `ok` here means
 * "a person could paste this URL into interpres and talk to it".
 *
 *   node scripts/sweep.ts [--concurrency 8] [--timeout 8000] [--limit N] [--out file]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname } from 'node:path';
import { convertCatalog, FIND_TOOLS_NAME } from '@interpres/core';
import type { CatalogStats, ConversionFailure, McpTool } from '@interpres/core';
import { McpError, httpStatus, probeServer } from '../apps/server/src/mcp.ts';
import { SsrfError } from '../apps/server/src/ssrf.ts';

export const UA = 'interpres-sweep/0.1 (+https://github.com/seekdaseek/interpres)';
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const PER_HOST = 2;

type Args = { concurrency: number; timeoutMs: number; limit?: number; out?: string; recheck?: string; recheckClasses: string[]; minGapMinutes: number };

function parseArgs(argv: string[]): Args {
  const a: Args = { concurrency: 8, timeoutMs: 8000, recheckClasses: ['ok'], minGapMinutes: 60 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--concurrency') { a.concurrency = Number(v); i++; }
    else if (k === '--timeout') { a.timeoutMs = Number(v); i++; }
    else if (k === '--limit') { a.limit = Number(v); i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--recheck') { a.recheck = v; i++; }
    else if (k === '--min-gap-minutes') { a.minGapMinutes = Number(v); i++; }
    // Which earlier classes to probe again. Default ok (the stability recheck);
    // the failure classes re-measure a split, e.g. after a classifier fix.
    else if (k === '--recheck-classes') { a.recheckClasses = (v ?? '').split(',').filter(Boolean); i++; }
  }
  return a;
}

/** Read a sweep file, gzipped or not. */
export async function readSweep(path: string): Promise<{ sweep: Record<string, unknown>; totals: unknown; servers: ServerResult[] }> {
  const buf = await readFile(path);
  const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return JSON.parse(text);
}

// ------------------------------------------------------------------ registry

type Remote = { type: string; url: string; headers?: Array<{ name?: string; isRequired?: boolean; isSecret?: boolean }> };
type RegistryEntry = {
  server: {
    name: string; title?: string; description?: string; version?: string;
    remotes?: Remote[]; websiteUrl?: string; repository?: { url?: string };
  };
  _meta?: Record<string, { status?: string; isLatest?: boolean; updatedAt?: string; publishedAt?: string } | undefined>;
};

export type Candidate = {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  status: string;
  remotes: Array<{ type: string; url: string }>;
  /** The registry entry itself says a credential header is required or secret. */
  declaresAuth: boolean;
  websiteUrl?: string;
  repositoryUrl?: string;
};

const official = (e: RegistryEntry) => e._meta?.['io.modelcontextprotocol.registry/official'];

async function fetchRegistryPage(cursor?: string): Promise<{ servers: RegistryEntry[]; next?: string }> {
  const u = new URL(REGISTRY);
  u.searchParams.set('limit', '100');
  if (cursor) u.searchParams.set('cursor', cursor);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(u, { headers: { 'user-agent': UA } });
    if (r.ok) {
      const j = (await r.json()) as { servers: RegistryEntry[]; metadata?: { nextCursor?: string } };
      return { servers: j.servers ?? [], next: j.metadata?.nextCursor };
    }
    // Be polite to the registry on 429/5xx; give up on anything else.
    if (r.status !== 429 && r.status < 500) throw new Error(`registry ${r.status}`);
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
  throw new Error('registry kept failing');
}

export async function collect(): Promise<{ entries: number; unique: number; candidates: Candidate[] }> {
  const all: RegistryEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchRegistryPage(cursor);
    all.push(...page.servers);
    cursor = page.next;
  } while (cursor);

  // The registry lists every published version; one server is one name. Keep
  // the entry flagged isLatest, else the most recently updated.
  const byName = new Map<string, RegistryEntry>();
  for (const e of all) {
    const name = e.server?.name;
    if (!name) continue;
    const prev = byName.get(name);
    if (!prev) { byName.set(name, e); continue; }
    const pm = official(prev);
    const em = official(e);
    if (pm?.isLatest) continue;
    if (em?.isLatest || String(em?.updatedAt ?? '') > String(pm?.updatedAt ?? '')) byName.set(name, e);
  }

  const candidates: Candidate[] = [];
  for (const e of byName.values()) {
    const remotes = (e.server.remotes ?? []).filter((r) => r.type === 'streamable-http' || r.type === 'sse');
    if (remotes.length === 0) continue;
    // Streamable HTTP first: it is the transport the spec prefers.
    remotes.sort((a, b) => (a.type === b.type ? 0 : a.type === 'streamable-http' ? -1 : 1));
    candidates.push({
      name: e.server.name,
      title: e.server.title,
      description: e.server.description?.slice(0, 300),
      version: e.server.version,
      status: official(e)?.status ?? 'unknown',
      remotes: remotes.map((r) => ({ type: r.type, url: r.url })),
      declaresAuth: remotes.some((r) => (r.headers ?? []).some((h) => h.isRequired || h.isSecret)),
      websiteUrl: e.server.websiteUrl,
      repositoryUrl: e.server.repository?.url,
    });
  }
  return { entries: all.length, unique: byName.size, candidates };
}

// --------------------------------------------------------------------- probe

export type ProbeClass = 'ok' | 'auth_required' | 'unreachable' | 'protocol_error';

export type Attempt = { url: string; type: string; class: ProbeClass; reason: string; detail?: string; ms: number };

export type ServerResult = Candidate & {
  /** When this server's probe started. The recheck gap is measured from it. */
  probedAt: string;
  class: ProbeClass;
  reason: string;
  attempts: Attempt[];
  url?: string;
  transport?: string;
  serverInfo?: { name?: string; title?: string; version?: string };
  instructionsChars?: number;
  toolCount?: number;
  readOnlyHint?: number;
  destructiveHint?: number;
  conversion?: CatalogStats;
  conversionFailures?: ConversionFailure[];
  /** The raw `tools/list` result, kept so later analysis never has to re-probe. */
  toolsList?: McpTool[];
};

/** A short, stable reason code from what actually happened. */
export function reasonFor(cls: ProbeClass, detail: string, ssrfCode?: string): string {
  if (ssrfCode) return `ssrf_${ssrfCode}`;
  const d = detail;
  // The recorded status only - never a bare number, which may sit in a body.
  const status = httpStatus(d);
  if (cls === 'auth_required') return status !== null ? `http_${status}` : 'auth_words';
  if (status !== null) return status >= 500 ? 'http_5xx' : `http_${status}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(d)) return 'dns';
  if (/ECONNREFUSED/i.test(d)) return 'refused';
  if (/ECONNRESET|socket hang up|other side closed/i.test(d)) return 'reset';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(d)) return 'host_unreachable';
  if (/certificate|CERT_|TLS|SSL|self.signed/i.test(d)) return 'tls';
  if (/timeout|timed out|aborted/i.test(d)) return 'timeout';
  if (cls === 'protocol_error') {
    if (/-32601|method not found/i.test(d)) return 'jsonrpc_method_not_found';
    if (/protocol version is not supported/i.test(d)) return 'protocol_version';
    if (/-32\d{3}/.test(d)) return 'jsonrpc_error';
    if (/content.type|text\/html|unexpected token|is not valid JSON|parse/i.test(d)) return 'not_mcp_response';
    return 'protocol_other';
  }
  if (/fetch failed/i.test(d)) return 'fetch_failed';
  return 'other';
}

function classifySsrf(code: string): ProbeClass {
  return code === 'too_large' ? 'protocol_error' : 'unreachable';
}

async function probeOne(url: string, type: string, timeoutMs: number): Promise<{ attempt: Attempt; conn?: Awaited<ReturnType<typeof probeServer>> }> {
  const t0 = Date.now();
  if (/\{[^}]*\}/.test(url)) {
    return { attempt: { url, type, class: 'unreachable', reason: 'url_template', detail: 'URL has unfilled {variables}', ms: 0 } };
  }
  // A backstop well past the SDK, fetch and DNS timeouts, so no single server
  // can stall a worker.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpError('unreachable', 'hard timeout')), timeoutMs * 3);
  });
  try {
    const conn = await Promise.race([probeServer(url, { timeoutMs, headers: { 'user-agent': UA } }), hard]);
    return { attempt: { url, type, class: 'ok', reason: 'ok', ms: Date.now() - t0 }, conn };
  } catch (err) {
    const ms = Date.now() - t0;
    if (err instanceof SsrfError) {
      const cls = classifySsrf(err.code);
      return { attempt: { url, type, class: cls, reason: reasonFor(cls, err.message, err.code), detail: err.message.slice(0, 200), ms } };
    }
    if (err instanceof McpError) {
      const cls = (['auth_required', 'unreachable', 'protocol_error'].includes(err.classification) ? err.classification : 'protocol_error') as ProbeClass;
      return { attempt: { url, type, class: cls, reason: reasonFor(cls, err.detail), detail: err.detail.slice(0, 200), ms } };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { attempt: { url, type, class: 'protocol_error', reason: reasonFor('protocol_error', detail), detail: detail.slice(0, 200), ms } };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCandidate(c: Candidate, timeoutMs: number): Promise<ServerResult> {
  const probedAt = new Date().toISOString();
  const attempts: Attempt[] = [];
  const seen = new Set<string>();
  for (const r of c.remotes.slice(0, 3)) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    const { attempt, conn } = await probeOne(r.url, r.type, timeoutMs);
    attempts.push(attempt);
    if (conn) {
      const tools = conn.tools;
      const conversion = convertCatalog(tools, { reserved: [FIND_TOOLS_NAME] });
      return {
        ...c, probedAt, class: 'ok', reason: 'ok', attempts, url: r.url, transport: conn.transport,
        serverInfo: conn.serverInfo, instructionsChars: conn.instructions?.length ?? 0,
        toolCount: tools.length,
        readOnlyHint: tools.filter((t) => t.annotations?.readOnlyHint === true).length,
        destructiveHint: tools.filter((t) => t.annotations?.destructiveHint === true).length,
        conversion: conversion.stats,
        conversionFailures: conversion.failures,
        toolsList: tools,
      };
    }
  }
  // Every remote failed: report the primary remote's outcome.
  const primary = attempts[0]!;
  return { ...c, probedAt, class: primary.class, reason: primary.reason, attempts };
}

/** A pool that never runs more than PER_HOST probes against one host at once. */
async function runPool(
  cands: Candidate[],
  concurrency: number,
  timeoutMs: number,
  onDone: (r: ServerResult, i: number) => void,
  /** Earliest time each candidate may be probed (the recheck gap). */
  notBefore: Map<string, number> = new Map(),
): Promise<ServerResult[]> {
  const results: ServerResult[] = new Array(cands.length);
  const hostOf = (c: Candidate) => { try { return new URL(c.remotes[0]!.url).host; } catch { return c.remotes[0]!.url; } };
  const busy = new Map<string, number>();
  const pending = cands.map((c, i) => ({ c, i }));
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const idx = pending.findIndex((p) => (busy.get(hostOf(p.c)) ?? 0) < PER_HOST && (notBefore.get(p.c.name) ?? 0) <= now);
      if (idx < 0) {
        if (pending.length === 0) return;
        await new Promise((r) => setTimeout(r, pending.every((p) => (notBefore.get(p.c.name) ?? 0) > Date.now()) ? 5000 : 50));
        continue;
      }
      const { c, i } = pending.splice(idx, 1)[0]!;
      const host = hostOf(c);
      busy.set(host, (busy.get(host) ?? 0) + 1);
      try {
        results[i] = await probeCandidate(c, timeoutMs);
      } finally {
        busy.set(host, (busy.get(host) ?? 1) - 1);
      }
      onDone(results[i]!, ++done);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// --------------------------------------------------------------------- totals

function sumStats(list: CatalogStats[]): CatalogStats {
  const keys = ['toolsIn', 'toolsConverted', 'convertedWithHints', 'namesSanitised', 'descriptionsSynthesised', 'descriptionsTruncated',
    'patternsKept', 'patternsDropped', 'refsResolved', 'allOfFlattened', 'unionsCollapsed', 'nullableUnwrapped', 'failed'] as const;
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as CatalogStats;
  for (const s of list) for (const k of keys) out[k] += s[k];
  return out;
}

export function totals(results: ServerResult[]) {
  const byClass: Record<string, number> = {};
  const byReason: Record<string, Record<string, number>> = {};
  for (const r of results) {
    byClass[r.class] = (byClass[r.class] ?? 0) + 1;
    (byReason[r.class] ??= {})[r.reason] = (byReason[r.class]![r.reason] ?? 0) + 1;
  }
  const ok = results.filter((r) => r.class === 'ok');
  const conv = sumStats(ok.map((r) => r.conversion!));
  const failuresByReason: Record<string, number> = {};
  for (const r of ok) for (const f of r.conversionFailures ?? []) failuresByReason[f.reason] = (failuresByReason[f.reason] ?? 0) + 1;
  const declared = results.filter((r) => r.declaresAuth);
  return {
    candidates: results.length,
    byClass,
    byReason,
    ok: {
      servers: ok.length,
      serversWithTools: ok.filter((r) => (r.toolCount ?? 0) > 0).length,
      serversOverTenTools: ok.filter((r) => (r.toolCount ?? 0) > 10).length,
      tools: conv.toolsIn,
      conversion: conv,
      shareConvertedWithHints: conv.toolsConverted > 0 ? Number((conv.convertedWithHints / conv.toolsConverted).toFixed(4)) : 0,
      conversionFailuresByReason: failuresByReason,
      toolsWithReadOnlyHint: ok.reduce((n, r) => n + (r.readOnlyHint ?? 0), 0),
      toolsWithDestructiveHint: ok.reduce((n, r) => n + (r.destructiveHint ?? 0), 0),
      serversWithAnyAnnotation: ok.filter((r) => (r.readOnlyHint ?? 0) + (r.destructiveHint ?? 0) > 0).length,
    },
    declaredAuth: {
      servers: declared.length,
      measured: declared.reduce<Record<string, number>>((m, r) => { m[r.class] = (m[r.class] ?? 0) + 1; return m; }, {}),
    },
  };
}

// ----------------------------------------------------------------------- main

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const t0 = Date.now();
  console.log(`sweep started ${startedAt.toISOString()} | concurrency ${args.concurrency}, timeout ${args.timeoutMs} ms, ${PER_HOST}/host | UA: ${UA}`);
  let reg: { entries: number; unique: number; candidates: Candidate[] };
  const notBefore = new Map<string, number>();
  let recheckOf: string | null = null;
  if (args.recheck) {
    // Recheck mode: re-probe every server that was ok in an earlier sweep, each
    // no sooner than --min-gap-minutes after its own earlier probe.
    const prev = await readSweep(args.recheck);
    recheckOf = args.recheck;
    const okPrev = prev.servers.filter((r) => args.recheckClasses.includes(r.class));
    for (const r of okPrev) notBefore.set(r.name, Date.parse(r.probedAt) + args.minGapMinutes * 60_000);
    reg = { entries: 0, unique: 0, candidates: okPrev.map(({ name, title, description, version, status, remotes, declaresAuth, websiteUrl, repositoryUrl }) => ({ name, title, description, version, status, remotes, declaresAuth, websiteUrl, repositoryUrl })) };
    console.log(`recheck of ${args.recheck}: ${reg.candidates.length} servers that were ${args.recheckClasses.join("/")}, each at least ${args.minGapMinutes} min after its first probe`);
  } else {
    reg = await collect();
    console.log(`registry: ${reg.entries} entries, ${reg.unique} unique servers, ${reg.candidates.length} with streamable-http/sse remotes (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  let cands = reg.candidates;
  if (args.limit) cands = cands.slice(0, args.limit);

  const perHost = new Map<string, number>();
  for (const c of cands) { try { const h = new URL(c.remotes[0]!.url).host; perHost.set(h, (perHost.get(h) ?? 0) + 1); } catch { /* counted as its own */ } }
  const topHosts = [...perHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`hosts: ${perHost.size} distinct; busiest: ${topHosts.map(([h, n]) => `${h}=${n}`).join(', ')}`);

  const running: Record<string, number> = {};
  const results = await runPool(cands, args.concurrency, args.timeoutMs, (r, n) => {
    running[r.class] = (running[r.class] ?? 0) + 1;
    if (n % 250 === 0 || n === cands.length) {
      console.log(`  ${n}/${cands.length}  ${JSON.stringify(running)}  ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  }, notBefore);

  const finishedAt = new Date();
  const out = {
    sweep: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      seconds: Math.round((Date.now() - t0) / 1000),
      userAgent: UA,
      concurrency: args.concurrency,
      perHost: PER_HOST,
      timeoutMs: args.timeoutMs,
      limit: args.limit ?? null,
      recheckOf,
      minGapMinutes: recheckOf ? args.minGapMinutes : null,
      recheckClasses: recheckOf ? args.recheckClasses : null,
      registry: { entries: reg.entries, uniqueServers: reg.unique, withRemotes: reg.candidates.length },
      distinctHosts: perHost.size,
      method: 'initialize + tools/list only, through the product probeServer and SSRF guard; no tool is ever called',
    },
    totals: totals(results),
    servers: results,
  };
  const stamp = startedAt.toISOString().slice(0, 16).replace(/:/g, '');
  const base = args.out ?? `data/sweep-${stamp}Z${recheckOf ? '-recheck' : ''}`;
  await mkdir(dirname(base), { recursive: true });
  // Full record, raw tools/list included, gzipped: tens of MB as plain JSON.
  await writeFile(`${base}.json.gz`, gzipSync(`${JSON.stringify(out)}\n`));
  // And a readable summary without the raw catalogs.
  const summary = { ...out, servers: results.map(({ toolsList: _raw, ...rest }) => rest) };
  await writeFile(`${base}-summary.json`, `${JSON.stringify(summary, null, 1)}\n`);
  console.log(`\nwritten: ${base}.json.gz and ${base}-summary.json`);
  console.log(JSON.stringify(out.totals, null, 1).slice(0, 3000));
}
