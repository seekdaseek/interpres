/**
 * The registry index the page searches and discovery looks in, built from the
 * committed recheck summary: every server that was `ok` at the recheck - the
 * second pass, an hour after the first - with at least one tool.
 *
 *   node scripts/registry-index-build.ts [summary.json.gz] [out.json.gz]
 *
 * Deterministic: entries sorted by name then URL, fields in a fixed order, and a
 * gzip header with no timestamp, so the same input gives the same bytes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export const DEFAULT_SOURCE = 'data/sweep-2026-09-26T1252Z-recheck-summary.json.gz';
export const DEFAULT_OUT = 'apps/server/data/registry-index.json.gz';
export const DESCRIPTION_MAX = 140;

/** One server, as the index stores it. `d` is the registry description, cut to 140 characters. */
export type IndexEntry = { n: string; t?: string; u: string; h: string; k: number; x: string; d?: string };

export type IndexFile = { builtFrom: string; recheckAt: string; rule: string; count: number; entries: IndexEntry[] };

type SummaryServer = {
  name: string; title?: string; description?: string; class: string; url?: string;
  transport?: string; toolCount?: number; serverInfo?: { title?: string };
};

const cut = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1).trimEnd()}…`;
};

export function buildIndex(summary: { sweep: { startedAt: string }; servers: SummaryServer[] }, builtFrom: string): IndexFile {
  const entries: IndexEntry[] = [];
  for (const s of summary.servers) {
    if (s.class !== 'ok' || !s.url || !s.transport || typeof s.toolCount !== 'number' || s.toolCount < 1) continue;
    const e: IndexEntry = { n: s.name, u: s.url, h: new URL(s.url).host, k: s.toolCount, x: s.transport };
    const title = s.title ?? s.serverInfo?.title;
    if (title && title.trim() !== '') e.t = cut(title, 60);
    if (s.description && s.description.trim() !== '') e.d = cut(s.description, DESCRIPTION_MAX);
    entries.push(e);
  }
  entries.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.u < b.u ? -1 : a.u > b.u ? 1 : 0));
  // A fixed key order, whatever order the fields were assigned in.
  const ordered = entries.map((e) => {
    const o: IndexEntry = { n: e.n, u: e.u, h: e.h, k: e.k, x: e.x };
    if (e.t !== undefined) o.t = e.t;
    if (e.d !== undefined) o.d = e.d;
    return o;
  });
  return {
    builtFrom,
    recheckAt: summary.sweep.startedAt,
    rule: 'class ok at the recheck, and at least one tool',
    count: ordered.length,
    entries: ordered,
  };
}

/** gzip bytes with the header's timestamp zeroed and a fixed OS byte, so builds on any machine match. */
export function gzipStable(text: string): Buffer {
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  gz.writeUInt32LE(0, 4);   // MTIME
  gz[9] = 255;              // OS: unknown
  return gz;
}

export function serialise(index: IndexFile): Buffer {
  return gzipStable(`${JSON.stringify(index)}\n`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const source = process.argv[2] ?? DEFAULT_SOURCE;
  const out = process.argv[3] ?? DEFAULT_OUT;
  const summary = JSON.parse(gunzipSync(readFileSync(source)).toString('utf8'));
  const index = buildIndex(summary, source);
  const bytes = serialise(index);
  writeFileSync(out, bytes);
  const withDesc = index.entries.filter((e) => e.d).length;
  const hosts = new Set(index.entries.map((e) => e.h)).size;
  console.log(`${out}: ${index.count} servers on ${hosts} hosts, ${withDesc} with a description, ${bytes.length} bytes gzipped`);
  console.log(`sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}
