/**
 * The error matrix a judge can hit, run against a base URL. Point it at the
 * public one: Cloudflare sits only in front of that, and it is what rewrote our
 * 502 bodies into HTML, which no local test could see.
 *
 *   node scripts/public-matrix.ts https://interpres.ochinimus.app data/public-matrix-before.json
 *
 * Every row records the status, the content type, whether the body parsed as
 * JSON, and the first characters of the body. Nothing here mints a token.
 */
import { writeFile } from 'node:fs/promises';

const base = (process.argv[2] ?? 'https://interpres.ochinimus.app').replace(/\/$/, '');
const out = process.argv[3];

type Case = { label: string; path: string; body: Record<string, unknown> };

const connect = (label: string, url: string): Case => ({ label, path: '/api/mcp/connect', body: { url } });

export const CASES: Case[] = [
  connect('no scheme', 'mcp.goji.agency/mcp'),
  connect('bare domain', 'goji.agency'),
  connect('http scheme', 'http://mcp.goji.agency/mcp'),
  connect('spaces around', '  https://mcp.goji.agency/mcp  '),
  connect('wrapped in quotes', '"https://mcp.goji.agency/mcp"'),
  connect('wrapped in <>', '<https://mcp.goji.agency/mcp>'),
  connect('not MCP', 'https://example.com'),
  connect('a website', 'https://goji.agency'),
  connect('inference.sh', 'https://api.inference.sh/mcp'),
  connect('no such host', 'https://nothing-here.invalid/mcp'),
  connect('closed port', 'https://example.com:81/mcp'),
  connect('private: loopback', 'https://127.0.0.1/mcp'),
  connect('private: 10/8', 'https://10.0.0.1/mcp'),
  connect('credentials', 'https://user:pass@mcp.goji.agency/mcp'),
  connect('javascript:', 'javascript:alert(1)'),
  connect('file:', 'file:///etc/passwd'),
  { label: 'starters, not MCP', path: '/api/mcp/starters', body: { url: 'https://example.com' } },
  { label: 'find-tools, not MCP', path: '/api/mcp/find-tools', body: { url: 'https://example.com', query: 'weather' } },
  { label: 'call, not MCP', path: '/api/mcp/call', body: { url: 'https://example.com', tool: 'anything', arguments: {} } },
];

export type Row = {
  label: string; path: string; input: unknown; status: number; contentType: string; ms: number;
  json: boolean; code?: string; message?: string; bodyHead: string;
};

export async function run(baseUrl: string, cases: Case[] = CASES): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of cases) {
    const started = Date.now();
    const res = await fetch(`${baseUrl}${c.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c.body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* recorded as json: false */ }
    rows.push({
      label: c.label,
      path: c.path,
      input: c.body.url,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      ms: Date.now() - started,
      json: parsed !== null,
      code: typeof parsed?.code === 'string' ? parsed.code : undefined,
      // /api/mcp/call answers a failed tool with 200 and a speakable result.
      message: typeof parsed?.error === 'string' ? parsed.error : typeof parsed?.spoken === 'string' ? parsed.spoken : undefined,
      bodyHead: text.slice(0, 90).replace(/\s+/g, ' '),
    });
  }
  return rows;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const rows = await run(base);
  const at = new Date().toISOString();
  console.log(`${base} at ${at}\n`);
  console.log('| case | input | status | JSON | code | message or body |');
  console.log('| --- | --- | ---: | --- | --- | --- |');
  for (const r of rows) {
    const shown = r.json ? (r.message ?? r.bodyHead) : r.bodyHead;
    console.log(`| ${r.label} | \`${String(r.input).replace(/\|/g, '\\|')}\` | ${r.status} | ${r.json ? 'yes' : '**no**'} | ${r.code ?? ''} | ${shown.replace(/\|/g, '\\|').slice(0, 110)} |`);
  }
  if (out) await writeFile(out, `${JSON.stringify({ base, at, rows }, null, 1)}\n`);
}
