/**
 * Round F0 on the public URL: what typing `ochinimus.app` connects to, and the
 * starter questions offered for it, with which of its tools are paid.
 *
 *   node scripts/public-f0.ts https://interpres.ochinimus.app data/f0-starters-before.json
 */
import { writeFile } from 'node:fs/promises';

const base = (process.argv[2] ?? 'https://interpres.ochinimus.app').replace(/\/$/, '');
const out = process.argv[3];

async function post(path: string, body: unknown): Promise<{ status: number; ms: number; json: any }> {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { nonJson: text.slice(0, 120) }; }
  return { status: res.status, ms: Math.round(performance.now() - started), json };
}

const at = new Date().toISOString();
const connect = await post('/api/mcp/connect', { url: 'ochinimus.app' });
const url = connect.json?.url;
const catalog: Array<{ mcpName: string; description: string }> = connect.json?.catalog ?? [];
// The same test the server applies, restated here so the report stands alone.
const paidByDescription = catalog.filter((t) => /\bcosts?\s+\$?\d+(?:\.\d+)?\s*USDC\b|\bx402\b/i.test(t.description)).map((t) => t.mcpName);
const starters = url ? await post('/api/mcp/starters', { url }) : null;
const result = {
  base, at,
  typed: 'ochinimus.app',
  connect: { status: connect.status, ms: connect.ms, url, tools: catalog.length, discovery: connect.json?.discovery?.found?.note ?? null },
  paidByDescription: paidByDescription.length,
  free: catalog.map((t) => t.mcpName).filter((n) => !paidByDescription.includes(n)),
  starters: starters ? { status: starters.status, source: starters.json?.source, reason: starters.json?.reason ?? null, questions: starters.json?.questions ?? [], cached: starters.json?.cached } : null,
};
console.log(JSON.stringify(result, null, 1));
if (out) await writeFile(out, `${JSON.stringify(result, null, 1)}\n`);
