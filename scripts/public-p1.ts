/**
 * P1 acceptance through the public URL: discovery for five typed websites, and
 * three registry searches, each timed from here (a round trip through
 * Cloudflare) and by the server (discovery's own clock).
 *
 *   node scripts/public-p1.ts https://interpres.ochinimus.app data/public-p1.json
 */
import { writeFile } from 'node:fs/promises';

const base = (process.argv[2] ?? 'https://interpres.ochinimus.app').replace(/\/$/, '');
const out = process.argv[3];

export const WEBSITES = ['goji.agency', 'tandem.ac', 'afg.ai', 'mostrecommendedbooks.com', 'example.com'];
export const SEARCHES = ['books', 'weather', 'goji'];

type Json = Record<string, any>;

async function timed(url: string, init?: RequestInit): Promise<{ status: number; ms: number; body: Json | null; text: string }> {
  const started = performance.now();
  const res = await fetch(url, init);
  const text = await res.text();
  let body: Json | null = null;
  try { body = JSON.parse(text) as Json; } catch { /* kept as text */ }
  return { status: res.status, ms: Math.round(performance.now() - started), body, text: text.slice(0, 120) };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const at = new Date().toISOString();
  const discovery = [];
  for (const site of WEBSITES) {
    const r = await timed(`${base}/api/mcp/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: site }) });
    const d = r.body?.discovery;
    discovery.push({
      typed: site, status: r.status, roundTripMs: r.ms, json: r.body !== null,
      connectedTo: r.status === 200 && !r.body?.choose ? r.body?.url : null,
      tools: r.body?.stats?.toolsConverted ?? null,
      kind: d?.kind ?? null, source: d?.found?.source ?? null, note: d?.found?.note ?? null, discoveryMs: d?.ms ?? null,
      tried: d?.tried ?? r.body?.tried ?? [], error: r.body?.error ?? null,
    });
  }
  const searches = [];
  for (const q of SEARCHES) {
    const r = await timed(`${base}/api/registry/search?q=${encodeURIComponent(q)}`);
    searches.push({
      q, status: r.status, roundTripMs: r.ms, serverMs: r.body?.ms ?? null, total: r.body?.total ?? null,
      results: (r.body?.results ?? []).map((s: Json) => ({ title: s.title ?? s.name, host: s.host, tools: s.tools, url: s.url })),
    });
  }
  console.log(`${base} at ${at}\n`);
  console.log('| typed | status | connected to | tools | how | discovery | round trip |');
  console.log('| --- | ---: | --- | ---: | --- | ---: | ---: |');
  for (const d of discovery) {
    console.log(`| \`${d.typed}\` | ${d.status} | ${d.connectedTo ?? (d.error ? `none: ${d.tried.length} tried` : d.kind)} | ${d.tools ?? ''} | ${d.note ?? d.kind ?? ''} | ${d.discoveryMs ?? ''} ms | ${d.roundTripMs} ms |`);
  }
  for (const s of searches) {
    console.log(`\nsearch "${s.q}": ${s.status}, ${s.results.length} of ${s.total}, server ${s.serverMs} ms, round trip ${s.roundTripMs} ms`);
    for (const x of s.results.slice(0, 5)) console.log(`  ${x.title} | ${x.host} | ${x.tools} tools`);
  }
  if (out) await writeFile(out, `${JSON.stringify({ base, at, discovery, searches }, null, 1)}\n`);
}
