import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildIndex, serialise, DEFAULT_SOURCE, DEFAULT_OUT } from '../../../scripts/registry-index-build.ts';
import { Registry, PER_HOST, SEARCH_LIMIT, queryTokens } from '../src/registry.ts';
import type { IndexEntry, IndexFile } from '../src/registry.ts';

const server = (name: string, url: string, tools: number, extra: Record<string, unknown> = {}) => ({
  name, url, transport: 'streamable-http', toolCount: tools, class: 'ok', description: `${name} description`, ...extra,
});

const SUMMARY = {
  sweep: { startedAt: '2026-09-26T12:52:04.405Z' },
  servers: [
    server('com.zeta/z', 'https://zeta.example/mcp', 3),
    server('com.alpha/a', 'https://alpha.example/mcp', 5, { description: `${'long '.repeat(60)}end` }),
    server('com.none/n', 'https://none.example/mcp', 0),
    server('com.down/d', 'https://down.example/mcp', 4, { class: 'unreachable' }),
  ],
};

test('the build keeps servers ok at the recheck with a tool, sorted, descriptions cut to 140', () => {
  const idx = buildIndex(SUMMARY as never, 'fixture');
  assert.deepEqual(idx.entries.map((e) => e.n), ['com.alpha/a', 'com.zeta/z']);
  assert.equal(idx.count, 2);
  assert.ok(idx.entries[0]!.d!.length <= 140);
  assert.ok(idx.entries[0]!.d!.endsWith('…'));
  assert.equal(idx.entries[0]!.h, 'alpha.example');
});

test('the build is deterministic: same input, same bytes, and no timestamp in the gzip header', () => {
  const a = serialise(buildIndex(SUMMARY as never, 'fixture'));
  const b = serialise(buildIndex({ ...SUMMARY, servers: [...SUMMARY.servers].reverse() } as never, 'fixture'));
  assert.equal(a.toString('hex'), b.toString('hex'), 'input order must not matter');
  assert.equal(a.readUInt32LE(4), 0, 'gzip MTIME is zeroed');
});

test('the committed index is exactly what the build makes from the committed recheck summary', () => {
  const summary = JSON.parse(gunzipSync(readFileSync(DEFAULT_SOURCE)).toString('utf8'));
  const rebuilt = serialise(buildIndex(summary, DEFAULT_SOURCE));
  const committed = readFileSync(DEFAULT_OUT);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  assert.equal(sha(rebuilt), sha(committed));
});

const entry = (n: string, u: string, k: number, t?: string, d?: string): IndexEntry => ({ n, u, h: new URL(u).host, k, x: 'streamable-http', ...(t ? { t } : {}), ...(d ? { d } : {}) });
const file = (entries: IndexEntry[]): IndexFile => ({ builtFrom: 'test', recheckAt: 'x', rule: 'x', count: entries.length, entries });

test('ranking: a host or name match beats a description mention, and every word must match', () => {
  const r = new Registry(file([
    entry('com.shelf/reads', 'https://shelf.example/mcp', 4, 'Shelf', 'Lists the books on your shelf.'),
    entry('com.mostrecommendedbooks/books', 'https://mostrecommendedbooks.com/api/mcp', 6, 'Most Recommended Books', 'Who recommends what.'),
    entry('com.weather/w', 'https://weather.example/mcp', 6, 'Weather', 'Forecasts and alerts.'),
    entry('com.alerts/a', 'https://alerts.example/mcp', 2, 'Alerts', 'Pager alerts.'),
  ]));
  assert.deepEqual(r.search('books').results.map((s) => s.host), ['mostrecommendedbooks.com', 'shelf.example']);
  assert.deepEqual(r.search('weather alerts').results.map((s) => s.host), ['weather.example'], 'both words, one server');
  assert.deepEqual(r.search('zzz').results, []);
});

test('ties keep one order, call after call, and a repeat comes from the cache', () => {
  const r = new Registry(file(['b', 'c', 'a'].map((x) => entry(`com.${x}/docs`, `https://${x}.example/mcp`, 1, undefined, 'docs server'))));
  const first = r.search('docs');
  assert.deepEqual(first.results.map((s) => s.name), ['com.a/docs', 'com.b/docs', 'com.c/docs']);
  const again = r.search('  DOCS ');
  assert.equal(again.cached, true);
  assert.deepEqual(again.results, first.results);
});

test('at most two results per host, one per URL, and twelve in all', () => {
  const mass = Array.from({ length: 30 }, (_, i) => entry(`dev.mass/s${String(i).padStart(2, '0')}`, `https://sensor.mass.example/s${i}/mcp`, 31, `sensor ${i}`));
  const twins = [entry('com.one/x', 'https://twin.example/mcp', 2, 'sensor twin'), entry('com.two/x', 'https://twin.example/mcp', 2, 'sensor twin')];
  const spread = Array.from({ length: 20 }, (_, i) => entry(`com.s${i}/x`, `https://s${i}.example/mcp`, 1, `sensor ${i}`));
  const r = new Registry(file([...mass, ...twins, ...spread]));
  const { results } = r.search('sensor');
  assert.equal(results.length, SEARCH_LIMIT);
  const perHost = new Map<string, number>();
  for (const s of results) perHost.set(s.host, (perHost.get(s.host) ?? 0) + 1);
  assert.ok([...perHost.values()].every((n) => n <= PER_HOST), JSON.stringify([...perHost]));
  assert.equal(results.filter((s) => s.url === 'https://twin.example/mcp').length, 1, 'one URL is one server');
});

test('an empty or one-character query matches nothing and costs nothing', () => {
  const r = new Registry(file([entry('com.a/a', 'https://a.example/mcp', 1, 'A', 'a b c')]));
  for (const q of ['', ' ', 'a', 'a b']) {
    assert.deepEqual(queryTokens(q).filter((t) => t.length < 2), []);
    assert.deepEqual(r.search(q).results, [], JSON.stringify(q));
  }
});

test('forDomain finds the domain, its subdomains and its reversed registry name, not lookalikes', () => {
  const r = new Registry(file([
    entry('agency.goji/goji', 'https://mcp.goji.agency/mcp', 9),
    entry('com.other/x', 'https://notgoji.agency/mcp', 3),
    entry('com.evil/x', 'https://goji.agency.evil.example/mcp', 3),
    entry('agency.goji/second', 'https://api.elsewhere.example/goji', 2),
    entry('com.root/x', 'https://goji.agency/mcp', 1),
  ]));
  assert.deepEqual(r.forDomain('goji.agency').map((s) => s.url), [
    'https://goji.agency/mcp',              // the domain's own host
    'https://mcp.goji.agency/mcp',          // named agency.goji/, and a subdomain
    'https://api.elsewhere.example/goji',   // named agency.goji/, hosted elsewhere
  ]);
  assert.deepEqual(r.forDomain('nothing.example'), []);
});

test('the real index: books finds Most Recommended Books first, and a mass host is capped', () => {
  const r = Registry.load();
  assert.ok(r.count > 10_000);
  assert.equal(r.search('books').results[0]?.host, 'mostrecommendedbooks.com');
  const { results } = r.search('observatory');
  const hosts = new Map<string, number>();
  for (const s of results) hosts.set(s.host, (hosts.get(s.host) ?? 0) + 1);
  assert.ok([...hosts.values()].every((n) => n <= PER_HOST));
  assert.deepEqual(r.forDomain('goji.agency').map((s) => s.url), ['https://mcp.goji.agency/mcp']);
});
