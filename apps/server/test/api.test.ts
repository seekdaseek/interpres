import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the log at a throwaway file and give the token route a key shape it can
// fail on cleanly, before the module reads its config at import time.
process.env.LOG_PATH = join(tmpdir(), `interpres-test-${process.pid}.jsonl`);
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

test('connect refuses a URL the SSRF guard blocks, with a code the UI can use', async () => {
  const cases: Array<[string, string]> = [
    ['http://example.com/mcp', 'bad_scheme'],
    ['https://127.0.0.1/mcp', 'blocked_address'],
    ['https://169.254.169.254/mcp', 'blocked_address'],
    ['https://user:pw@example.com/mcp', 'has_credentials'],
    ['not-a-url', 'not_a_url'],
  ];
  for (const [url, code] of cases) {
    const r = await post('/api/mcp/connect', { url });
    assert.equal(r.status, 400, `${url} should be 400`);
    assert.equal((await r.json()).code, code, `${url} should report ${code}`);
  }
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
    assert.ok([200, 502].includes(r.status), `unexpected ${r.status}`);
  }
  assert.equal(sawLimit, true, 'the limit must engage within 9 attempts of a 6/hour budget');
});

test('an unknown tool name gets a recoverable tool result, not an HTTP error', async () => {
  const r = await post('/api/mcp/call', {
    url: 'https://www.assemblyai.com/docs/mcp',
    tool: 'no_such_tool_exists_here',
    arguments: {},
  });
  assert.equal(r.status, 200, 'a conversational failure is not an HTTP failure');
  const body = await r.json();
  assert.equal(body.isError, true);
  assert.equal(body.unknownTool, true);
  assert.match(JSON.parse(body.result).error, /find_tools/, 'the agent must be told how to recover');
});

test('connect against a real MCP server returns a usable phase', async () => {
  const r = await post('/api/mcp/connect', { url: 'https://www.assemblyai.com/docs/mcp' });
  assert.equal(r.status, 200, `connect failed: ${await r.clone().text()}`);
  const body = await r.json();
  assert.equal(body.transport, 'streamable-http');
  assert.ok(body.catalog.length >= 3, `expected tools, got ${body.catalog.length}`);
  assert.equal(body.stats.failed, 0);
  assert.ok(body.phase.tools.length > 0 && body.phase.tools.length <= 10);
  assert.ok(body.phase.systemPrompt.includes(body.catalog[0].voiceName));
  assert.match(body.greeting, /Connected to/);
  // The session.update the browser will send must be valid on its face.
  const upd = body.phase.sessionUpdate;
  assert.equal(upd.type, 'session.update');
  assert.deepEqual(Object.keys(upd.session).sort(), ['input', 'system_prompt', 'tools']);
  assert.ok(upd.session.input.keyterms.length <= 100);
  assert.ok(upd.session.input.transcription_prompt.length <= 1750);
});

test('the second connect to the same URL is served from cache', async () => {
  const url = 'https://www.assemblyai.com/docs/mcp';
  await post('/api/mcp/connect', { url });
  const r = await post('/api/mcp/connect', { url });
  assert.equal((await r.json()).cached, true);
});

test('find-tools on a catalog over the limit reveals a bounded set', async () => {
  const r = await post('/api/mcp/find-tools', { url: 'https://afg.ai/mcp', query: 'dispute the result of a job' });
  assert.equal(r.status, 200, `find-tools failed: ${await r.clone().text()}`);
  const body = await r.json();
  assert.ok(body.available.length <= 10, `revealed ${body.available.length}`);
  assert.ok(body.available.includes('find_tools'), 'discovery must stay reachable');
  assert.ok(body.available.includes('afg_dispute'), `expected afg_dispute among ${body.available.join(',')}`);
  // Whatever the agent is handed must be a JSON string, per tool.result.
  assert.equal(typeof body.toolResult, 'string');
  assert.doesNotThrow(() => JSON.parse(body.toolResult));
});
