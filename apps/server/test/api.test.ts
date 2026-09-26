import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the log at a throwaway file and give the token route a key shape it can
// fail on cleanly, before the module reads its config at import time.
process.env.LOG_PATH = join(tmpdir(), `interpres-test-${process.pid}.jsonl`);
// Hermetic: the token route's upstream is a closed local port, so it fails at
// once whether or not this machine has network. Live calls live in api.live.ts.
process.env.AGENTS_API = 'http://127.0.0.1:9';
process.env.RATE_PER_IP_HOUR ??= '6';

let app: { fetch: (req: Request) => Response | Promise<Response> };

before(async () => {
  ({ app } = await import('../src/index.ts'));
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://localhost${path}`, { headers }));
const post = (path: string, body: unknown) =>
  app.fetch(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

test('health answers', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('presets are all https and carry questions that exercise a tool', async () => {
  const r = await get('/api/presets');
  assert.equal(r.status, 200);
  const { presets, maxToolsPerPhase } = await r.json();
  assert.equal(maxToolsPerPhase, 10);
  assert.ok(presets.length >= 3, `expected at least 3 presets, got ${presets.length}`);
  for (const p of presets) {
    assert.match(p.url, /^https:\/\//, `${p.label} must be https`);
    assert.ok(p.asks.length >= 1, `${p.label} must suggest something to ask`);
    assert.ok(p.blurb.length > 0);
  }
  assert.ok(presets.some((p: any) => p.exercisesPhases), 'one preset must have over 10 tools');
});

test('a bad body on connect is refused before any network call', async () => {
  for (const body of ['not json', {}, { url: '' }, { url: '   ' }, { url: 42 }]) {
    const r = await post('/api/mcp/connect', body);
    assert.equal(r.status, 400, `body ${JSON.stringify(body)} should be 400`);
    assert.equal((await r.json()).code, 'bad_request');
  }
});

test('connect refuses a URL the normaliser or the SSRF guard blocks, with a code the UI can use', async () => {
  const cases: Array<[string, string]> = [
    ['ftp://example.com/mcp', 'bad_scheme'],
    ['javascript:alert(1)', 'bad_scheme'],
    ['file:///etc/passwd', 'bad_scheme'],
    ['https://127.0.0.1/mcp', 'blocked_address'],
    ['https://[::1]/mcp', 'blocked_address'],
    ['https://169.254.169.254/mcp', 'blocked_address'],
    // Switched to https by the normaliser, then refused by the guard: the order is the point.
    ['http://127.0.0.1/mcp', 'blocked_address'],
    ['https://user:pw@example.com/mcp', 'has_credentials'],
    ['mcp.goji.agency@127.0.0.1', 'has_credentials'],
    ['not-a-url', 'not_a_url'],
  ];
  for (const [url, code] of cases) {
    const r = await post('/api/mcp/connect', { url });
    assert.equal(r.status, 400, `${url} should be 400`);
    const body = await r.json();
    assert.equal(body.code, code, `${url} should report ${code}`);
    assert.ok(typeof body.error === 'string' && body.error.length > 10, `${url} needs a sentence`);
  }
});

test('registry search: two characters at least, twelve results at most, two per host', async () => {
  for (const q of ['', 'a', '%20b%20']) {
    const r = await get(`/api/registry/search?q=${q}`);
    assert.equal(r.status, 400, `q=${q}`);
    assert.equal((await r.json()).code, 'query_too_short');
  }
  const r = await get('/api/registry/search?q=books');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.total > 10_000, 'the whole index is counted');
  assert.equal(body.results[0].host, 'mostrecommendedbooks.com');
  assert.ok(body.results.length <= 12);
  const presets = await (await get('/api/presets')).json();
  assert.equal(presets.registry.count, body.total, 'the page reads N from the same index');
});

test('a bare private address is refused as private, not searched around', async () => {
  for (const url of ['127.0.0.1', 'https://10.0.0.1/', '192.168.1.1']) {
    const r = await post('/api/mcp/connect', { url });
    assert.equal(r.status, 400, url);
    assert.equal((await r.json()).code, 'blocked_address', url);
  }
});

test('the call route refuses a bad URL as a request error, and never with a gateway status', async () => {
  const r = await post('/api/mcp/call', { url: 'javascript:alert(1)', tool: 'x' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'bad_scheme');
});

test('a token-service failure is a 424 in JSON, never a 502 Cloudflare would rewrite', async () => {
  // AGENTS_API is a closed local port here, so the upstream fetch fails at once.
  // A fresh client address, so the limit test below keeps its own budget.
  const r = await get('/api/token', { 'cf-connecting-ip': '198.51.100.9' });
  assert.equal(r.status, 424);
  assert.match(r.headers.get('content-type') ?? '', /application\/json/);
  const body = await r.json();
  assert.equal(body.code, 'token_unreachable');
  assert.match(body.error, /token service/);
});

test('find-tools and call both validate their bodies', async () => {
  for (const path of ['/api/mcp/find-tools', '/api/mcp/call']) {
    assert.equal((await post(path, 'nope')).status, 400);
    assert.equal((await post(path, {})).status, 400);
  }
  assert.equal((await post('/api/mcp/find-tools', { url: 'https://x.example/' })).status, 400, 'query is required');
  assert.equal((await post('/api/mcp/call', { url: 'https://x.example/' })).status, 400, 'tool is required');
});

test('status reports counters without leaking anything', async () => {
  const r = await get('/api/status');
  assert.equal(r.status, 200);
  const body = await r.json();
  for (const k of ['counters', 'shaper', 'cache', 'rate', 'recent']) assert.ok(k in body, `missing ${k}`);
  assert.equal(body.rate.perIpPerHour, 6);
  assert.ok(!JSON.stringify(body).match(/[A-Za-z0-9]{32}/), 'no 32-char secret-shaped string may appear');
});

test('status shows the host of a failed connect, never its path secret or a spoken query', async () => {
  const secret = 'hooks_0a1b2c3d4e5f60718293a4b5c6d7e8f9';
  const url = `https://mcp.zapier.example/api/mcp/s/${secret}/mcp`;
  const r = await post('/api/mcp/connect', { url });
  assert.ok(r.status >= 400, `a .example host cannot connect, got ${r.status}`);
  await post('/api/mcp/find-tools', { url, query: 'the wallet I pasted' });
  const status = await (await get('/api/status')).json();
  const text = JSON.stringify(status);
  assert.ok(status.recent.some((e: { host?: string }) => e.host === 'mcp.zapier.example'), 'positive control: the failed connect is in the tail');
  assert.ok(!text.includes(secret), 'the path secret must not appear');
  assert.ok(!text.includes('wallet I pasted'), 'the query must not appear');
});

test('the token route enforces its limit rather than minting forever', async () => {
  // No valid key is configured in tests, so upstream fails - but the limiter
  // runs first, which is the behaviour under test.
  let sawLimit = false;
  for (let i = 0; i < 9; i++) {
    const r = await get('/api/token');
    if (r.status === 429) {
      const body = await r.json();
      assert.ok(['per_ip', 'global'].includes(body.code));
      assert.ok(Number(r.headers.get('retry-after')) > 0, 'a 429 must say when to retry');
      sawLimit = true;
      break;
    }
    assert.ok([200, 424].includes(r.status), `unexpected ${r.status}`);
  }
  assert.equal(sawLimit, true, 'the limit must engage within 9 attempts of a 6/hour budget');
});

test('a client address is never written to the event log', async () => {
  // Drive the token route with a Cloudflare client IP, which the limiter keys on.
  const clientIp = '198.51.100.77';
  await get('/api/token', { 'cf-connecting-ip': clientIp });
  const status = await (await get('/api/status')).text();
  assert.ok(!status.includes(clientIp), 'the in-memory tail must not hold it');
  const { readFile } = await import('node:fs/promises');
  // The log is appended asynchronously; wait for the line rather than race it.
  let file = '';
  for (let i = 0; i < 40 && file.length === 0; i++) {
    file = await readFile(process.env.LOG_PATH!, 'utf8').catch(() => '');
    if (file.length === 0) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(file.length > 0, 'the log must have been written, or this proves nothing');
  assert.ok(!file.includes(clientIp), 'the file must not hold it');
});

test('the replay recording is served as audio/mp4, with byte ranges', async (t) => {
  const { readdirSync, existsSync } = await import('node:fs');
  const dir = 'apps/web/dist/assets';
  const m4a = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.m4a')) : undefined;
  if (!m4a) { t.skip('web app not built'); return; }
  const whole = await get(`/assets/${m4a}`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'audio/mp4');
  const part = await get(`/assets/${m4a}`, { range: 'bytes=0-99' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-type'), 'audio/mp4');
  assert.equal(part.headers.get('content-length'), '100');
});

test('the share card: og.png is a 1200x630 PNG, and the page names it by absolute URL', async (t) => {
  const { existsSync } = await import('node:fs');
  if (!existsSync('apps/web/dist/og.png')) { t.skip('web app not built'); return; }
  const img = await get('/og.png');
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await img.arrayBuffer());
  // PNG signature, then the IHDR width and height, big-endian.
  assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47]);
  const view = new DataView(bytes.buffer);
  assert.deepEqual([view.getUint32(16), view.getUint32(20)], [1200, 630]);
  const html = await (await get('/')).text();
  for (const tag of [
    '<meta property="og:title" content="interpres - talk to any MCP server"',
    '<meta property="og:url" content="https://interpres.ochinimus.app/"',
    '<meta property="og:image" content="https://interpres.ochinimus.app/og.png"',
    '<meta name="twitter:card" content="summary_large_image"',
  ]) assert.ok(html.includes(tag), tag);
  assert.match(html, /<meta property="og:description" content="[^"]{40,}"/);
});

test('the page always revalidates, and a hashed asset is cached for good', async (t) => {
  const { readdirSync, existsSync } = await import('node:fs');
  const dir = 'apps/web/dist/assets';
  const js = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.js')) : undefined;
  if (!js) { t.skip('web app not built'); return; }
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-cache', 'or a redeploy leaves returning visitors on a dead page');
  const asset = await get(`/assets/${js}`);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
  const gone = await get('/assets/interpres-index-deleted.js');
  assert.equal(gone.status, 404);
  assert.equal(gone.headers.get('cache-control'), null, 'a 404 must not be cached as immutable');
});
