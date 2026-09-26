/**
 * Capture a remote MCP server's initialize + tools/list response verbatim,
 * as a test fixture. Deliberately independent of packages/core's own MCP
 * client: a fixture produced by the code under test proves nothing.
 *
 *   node scripts/capture-fixture.ts <name> <url>
 */
const PROTO = '2025-06-18';

type Rpc = { status: number; sid: string | null; json: any; raw: string };

async function post(url: string, body: unknown, sid?: string | null, timeoutMs = 15000): Promise<Rpc> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTO,
        ...(sid ? { 'mcp-session-id': sid } : {}),
      },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    let json: any = null;
    const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
    if (dataLine) json = JSON.parse(dataLine.slice(6));
    else try { json = JSON.parse(raw); } catch { /* leave null */ }
    return { status: r.status, sid: r.headers.get('mcp-session-id'), json, raw };
  } finally {
    clearTimeout(timer);
  }
}

const [name, url] = process.argv.slice(2);
if (!name || !url) {
  console.error('usage: node scripts/capture-fixture.ts <name> <url>');
  process.exit(2);
}

const init = await post(url, {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'interpres-fixture', version: '0.1.0' } },
});
if (!init.json?.result) {
  console.error(`initialize failed: ${init.status} ${init.raw.slice(0, 300)}`);
  process.exit(1);
}
// Required by the MCP spec once initialize succeeds. Stateful servers reject
// tools/list with "Missing session ID" without the header, and some reject it
// without this notification too.
if (init.sid) await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid);

const list = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sid);
if (!list.json?.result?.tools) {
  console.error(`tools/list failed: ${list.json?.error?.message ?? list.status} ${list.raw.slice(0, 300)}`);
  process.exit(1);
}

const out = {
  _captured: {
    url,
    at: new Date().toISOString(),
    statefulSession: Boolean(init.sid),
    note: 'Verbatim JSON-RPC results. Captured independently of packages/core.',
  },
  initialize: init.json.result,
  toolsList: list.json.result,
};
const path = `packages/core/test/fixtures/${name}.json`;
await (await import('node:fs/promises')).writeFile(path, JSON.stringify(out, null, 2) + '\n');
const blob = JSON.stringify(list.json.result.tools);
console.log(
  `${path}: ${list.json.result.tools.length} tools, ` +
  `server "${init.json.result.serverInfo?.name}" v${init.json.result.serverInfo?.version}, ` +
  `session=${init.sid ? 'stateful' : 'stateless'}, ` +
  `$ref=${(blob.match(/"\$ref"/g) || []).length} $defs=${(blob.match(/"\$defs"/g) || []).length} ` +
  `allOf=${(blob.match(/"allOf"/g) || []).length} anyOf=${(blob.match(/"anyOf"/g) || []).length}`,
);
