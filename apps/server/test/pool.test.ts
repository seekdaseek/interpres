import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpPool } from '../src/mcp.ts';
import type { Opener } from '../src/mcp.ts';
import { PinnedAgents, SsrfError } from '../src/ssrf.ts';

// ------------------------------------------------ a counting fake MCP server

const counts = { initialize: 0, calls: 0 };
const sessions = new Set<string>();
let server: http.Server;
let base: URL;

before(async () => {
  let n = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(405).end(); return; }   // no standalone event stream
    if (req.method === 'DELETE') { sessions.delete(String(req.headers['mcp-session-id'])); res.writeHead(200).end(); return; }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw);
      const json = (body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (msg.method === 'initialize') {
        counts.initialize++;
        const id = `s${++n}`;
        sessions.add(id);
        json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }, { 'mcp-session-id': id });
        return;
      }
      // The spec: a request carrying a session the server no longer knows gets 404.
      if (!sessions.has(String(req.headers['mcp-session-id']))) { res.writeHead(404).end(); return; }
      if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      if (msg.method === 'tools/call') {
        counts.calls++;
        json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `ok ${counts.calls}` }] } });
        return;
      }
      json({ jsonrpc: '2.0', id: msg.id, result: {} });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});

after(() => new Promise<void>((r) => server.close(() => r())));

// The SSRF guard refuses 127.0.0.1, as it should, so the test opens clients directly.
const opener: Opener = async (url, kind, timeoutMs) => {
  const client = new Client({ name: 'pool-test', version: '0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(url), { timeout: timeoutMs });
  return { client, transport: kind };
};

const reset = () => { counts.initialize = 0; counts.calls = 0; };
const text = (r: { result: Record<string, unknown> }) => ((r.result.content as Array<{ text: string }>)[0]!.text);

// ---------------------------------------------------------------- the pool

test('one initialize for N calls in one voice session', async () => {
  reset();
  const pool = new McpPool({ opener });
  for (let i = 1; i <= 5; i++) assert.equal(text(await pool.call('sess_a', base, 'echo', {}, 5000)), `ok ${i}`);
  assert.equal(counts.initialize, 1, 'the counting server saw one initialize');
  assert.equal(counts.calls, 5);
  assert.equal(pool.opened, 1);
  await pool.drop(`sess_a\n${base.href}`);
});

test('another voice session gets its own client', async () => {
  reset();
  const pool = new McpPool({ opener });
  await pool.call('sess_a', base, 'echo', {}, 5000);
  await pool.call('sess_b', base, 'echo', {}, 5000);
  await pool.call('sess_a', base, 'echo', {}, 5000);
  assert.equal(counts.initialize, 2);
  assert.equal(pool.size, 2);
});

test('two calls racing on a cold key share one open', async () => {
  reset();
  const pool = new McpPool({ opener });
  await Promise.all([pool.call('sess_r', base, 'echo', {}, 5000), pool.call('sess_r', base, 'echo', {}, 5000)]);
  assert.equal(counts.initialize, 1);
  assert.equal(counts.calls, 2);
});

test('an idle client is closed, and the next call opens a new one', async () => {
  reset();
  const pool = new McpPool({ opener, idleMs: 80 });
  await pool.call('sess_i', base, 'echo', {}, 5000);
  assert.equal(pool.size, 1);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(pool.size, 0, 'closed after the idle time');
  await pool.call('sess_i', base, 'echo', {}, 5000);
  assert.equal(counts.initialize, 2);
});

test('the pool is capped, least recently used out first', async () => {
  reset();
  const pool = new McpPool({ opener, max: 2 });
  await pool.call('a', base, 'echo', {}, 5000);
  await pool.call('b', base, 'echo', {}, 5000);
  await pool.call('a', base, 'echo', {}, 5000);   // a is now the most recent
  await pool.call('c', base, 'echo', {}, 5000);   // evicts b
  assert.equal(pool.size, 2);
  assert.equal(counts.initialize, 3);
  await pool.call('a', base, 'echo', {}, 5000);
  assert.equal(counts.initialize, 3, 'a survived');
  await pool.call('b', base, 'echo', {}, 5000);
  assert.equal(counts.initialize, 4, 'b had been evicted');
});

test('a session the server forgot is reopened once, and the call still answers', async () => {
  reset();
  const pool = new McpPool({ opener });
  await pool.call('sess_x', base, 'echo', {}, 5000);
  sessions.clear();                                  // the server restarted
  const r = await pool.call('sess_x', base, 'echo', {}, 5000);
  assert.equal(text(r), 'ok 2');
  assert.equal(counts.initialize, 2, 'exactly one reopen');
});

// ------------------------------------------------------ pinned keep-alive agents

test('a pinned agent is reused within the TTL, and the host is verified again after it', async () => {
  let verified = 0;
  let t = 0;
  let addrs = [{ address: '93.184.216.34', family: 4 }];
  const agents = new PinnedAgents({ ttlMs: 1000, now: () => t, verify: async (raw) => { verified++; return { url: new URL(raw), addresses: addrs }; } });
  const u = new URL('https://example.com/mcp');
  const a1 = await agents.get(u);
  assert.equal(await agents.get(u), a1);
  assert.equal(verified, 1, 'no second DNS lookup inside the TTL');
  t = 1500;
  assert.equal(await agents.get(u), a1, 'verified again, same addresses: the warm agent stays');
  assert.equal(verified, 2);
  t = 3000;
  addrs = [{ address: '93.184.216.35', family: 4 }];
  assert.notEqual(await agents.get(u), a1, 'new addresses: a new agent, pinned to them');
});

test('a host that turns private is refused at re-verification, never served from the cache', async () => {
  let t = 0;
  let turned = false;
  const agents = new PinnedAgents({
    ttlMs: 1000, now: () => t,
    verify: async (raw) => {
      if (turned) throw new SsrfError('blocked_address', 'resolves to 10.0.0.5');
      return { url: new URL(raw), addresses: [{ address: '93.184.216.34', family: 4 }] };
    },
  });
  const u = new URL('https://rebind.example/mcp');
  await agents.get(u);
  turned = true;
  t = 1500;
  await assert.rejects(agents.get(u), (e: unknown) => e instanceof SsrfError && e.code === 'blocked_address');
});
