import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the log at a throwaway file and give the token route a key shape it can
// fail on cleanly, before the module reads its config at import time.
process.env.LOG_PATH = join(tmpdir(), `interpres-test-${process.pid}.jsonl`);
// LIVE: these reach www.assemblyai.com and afg.ai. Run with `npm run test:live`.
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

