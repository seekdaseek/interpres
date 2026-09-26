import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentProtocol } from '../src/protocol.ts';
import type { ExecResult, ServerEvent, ToolCall } from '../src/protocol.ts';

/** A controllable executor: each call waits until the test releases it. */
function harness(opts: { autoResolve?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const releases = new Map<string, (r: ExecResult) => void>();
  const fails = new Map<string, (e: unknown) => void>();
  const log: string[] = [];
  const proto = new AgentProtocol(
    (m) => { sent.push(m); log.push(`send ${String(m.type)}`); },
    (call: ToolCall) => new Promise<ExecResult>((resolve, reject) => {
      if (opts.autoResolve) { resolve({ result: JSON.stringify({ ok: call.name }) }); return; }
      releases.set(call.callId, resolve);
      fails.set(call.callId, reject);
    }),
    {
      onTurnIdle: () => log.push('IDLE'),
      onInterrupted: () => log.push('INTERRUPTED'),
      onResultsSent: (ids) => log.push(`sent-results ${ids.join(',')}`),
    },
  );
  const ev = (type: string, extra: Record<string, unknown> = {}) => proto.handle({ type, ...extra } as ServerEvent);
  const tick = () => new Promise((r) => setImmediate(r));
  return { proto, sent, log, ev, tick, releases, fails };
}

const results = (sent: Array<Record<string, unknown>>) => sent.filter((m) => m.type === 'tool.result');

test('a tool that finishes BEFORE reply.done is held until reply.done', async () => {
  const h = harness();
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c1', name: 'search', arguments: { q: 'x' } });
  h.releases.get('c1')!({ result: '"r1"' });
  await h.tick();
  assert.equal(results(h.sent).length, 0, 'must not send while the transition phrase is playing');
  h.ev('reply.done', { status: 'completed' });
  assert.equal(results(h.sent).length, 1, 'sent on reply.done');
  assert.ok(!h.log.includes('IDLE'), 'the answer has not been spoken yet');
});

test('a tool that finishes AFTER reply.done is sent the moment it finishes', async () => {
  // The docs' own warning: "Your tool may return after reply.done already fired."
  const h = harness();
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c1', name: 'search', arguments: {} });
  h.ev('reply.done', { status: 'completed' });
  assert.equal(results(h.sent).length, 0);
  assert.ok(!h.log.includes('IDLE'), 'a tool is still running, so the turn is not over');
  h.releases.get('c1')!({ result: '"late"' });
  await h.tick();
  assert.equal(results(h.sent).length, 1, 'flushed from the handler, not left waiting');
});

test('the turn ends on the reply AFTER the result, not on the transition phrase', async () => {
  const h = harness();
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c1', name: 'search', arguments: {} });
  h.releases.get('c1')!({ result: '"r"' });
  await h.tick();
  h.ev('reply.done', { status: 'completed' });     // transition phrase done, result goes out
  assert.ok(!h.log.includes('IDLE'));
  h.ev('reply.started');                           // auto-fired by tool.result
  h.ev('reply.done', { status: 'completed' });     // the answer
  assert.equal(h.log.filter((l) => l === 'IDLE').length, 1);
});

test('a result arriving mid-turn is held while the caller is speaking', async () => {
  const h = harness();
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c1', name: 'search', arguments: {} });
  h.ev('reply.done', { status: 'completed' });
  h.ev('input.speech.started');                    // the caller starts talking again
  h.releases.get('c1')!({ result: '"r"' });
  await h.tick();
  assert.equal(results(h.sent).length, 0, 'a turn is in flight; the result must wait for the next reply.done');
});

test('an interruption drops pending results and ends the turn', async () => {
  const h = harness();
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c1', name: 'search', arguments: {} });
  h.ev('reply.done', { status: 'interrupted' });
  assert.ok(h.log.includes('INTERRUPTED'));
  assert.ok(h.log.includes('IDLE'));
  // The handler finishes after the interruption. Its result belongs to a reply
  // that no longer exists and must never be sent into the next turn.
  h.releases.get('c1')!({ result: '"stale"' });
  await h.tick();
  h.ev('reply.started');
  h.ev('reply.done', { status: 'completed' });
  assert.equal(results(h.sent).length, 0, 'a stale result leaked into the next turn');
});

test('find_tools then the revealed tool, in one turn', async () => {
  // The sequence observed live on afg.ai: find_tools -> session.update ->
  // result -> the agent calls a tool it could not see before -> answer.
  const h = harness();
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'f1', name: 'find_tools', arguments: { query: 'job flow' } });
  h.releases.get('f1')!({ result: '{"available_tools":["afg_about"]}', sessionUpdate: { session: { tools: [] } } });
  await h.tick();
  const updateIdx = h.sent.findIndex((m) => m.type === 'session.update');
  assert.ok(updateIdx >= 0, 'the phase swap must be sent');
  h.ev('reply.done', { status: 'completed' });
  const resultIdx = h.sent.findIndex((m) => m.type === 'tool.result');
  assert.ok(updateIdx < resultIdx, 'session.update must precede the result that announces it');

  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'a1', name: 'afg_about', arguments: {} });
  h.ev('reply.done', { status: 'completed' });
  assert.ok(!h.log.includes('IDLE'), 'afg_about is still running');
  h.releases.get('a1')!({ result: '"about"' });
  await h.tick();
  assert.equal(results(h.sent).length, 2);
  h.ev('reply.started');
  h.ev('reply.done', { status: 'completed' });
  assert.equal(h.log.filter((l) => l === 'IDLE').length, 1, 'exactly one turn end, at the very end');
});

test('two parallel tool calls are both sent, in one flush', async () => {
  const h = harness();
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c1', name: 'a', arguments: {} });
  h.ev('tool.call', { call_id: 'c2', name: 'b', arguments: {} });
  h.releases.get('c1')!({ result: '"1"' });
  h.releases.get('c2')!({ result: '"2"' });
  await h.tick();
  h.ev('reply.done', { status: 'completed' });
  assert.deepEqual(results(h.sent).map((m) => m.call_id), ['c1', 'c2']);
});

test('a failing tool still produces a result the agent can speak', async () => {
  const h = harness();
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c1', name: 'broken', arguments: {} });
  h.fails.get('c1')!(new Error('upstream 503'));
  await h.tick();
  h.ev('reply.done', { status: 'completed' });
  const r = results(h.sent);
  assert.equal(r.length, 1, 'silence would stall the turn until the tool timeout');
  assert.match(JSON.parse(String(r[0]!.result)).error, /upstream 503/);
});

test('a plain reply with no tools ends the turn at once', () => {
  const h = harness();
  h.ev('reply.started');
  h.ev('reply.done', { status: 'completed' });
  assert.deepEqual(h.log, ['IDLE']);
});

test('tool.result carries exactly call_id and a string result', async () => {
  const h = harness({ autoResolve: true });
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c9', name: 'x', arguments: { a: 1 } });
  await h.tick();
  h.ev('reply.done', { status: 'completed' });
  const r = results(h.sent)[0]!;
  assert.deepEqual(Object.keys(r).sort(), ['call_id', 'result', 'type']);
  assert.equal(typeof r.result, 'string');
});

test('malformed tool.call arguments do not crash the protocol', async () => {
  const h = harness({ autoResolve: true });
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c1', name: 'x', arguments: 'not an object' });
  await h.tick();
  h.ev('reply.done', { status: 'completed' });
  assert.equal(results(h.sent).length, 1);
});

test('a result dropped by the epoch check is reported through onDropped', async () => {
  const dropped: string[] = [];
  let release!: (r: ExecResult) => void;
  const proto = new AgentProtocol(
    () => {},
    () => new Promise<ExecResult>((res) => { release = res; }),
    { onDropped: (c) => dropped.push(c.name) },
  );
  proto.handle({ type: 'reply.started' });
  proto.handle({ type: 'tool.call', call_id: 'c1', name: 'slow_tool', arguments: {} });
  proto.handle({ type: 'reply.done', status: 'interrupted' });
  release({ result: '"late"' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(dropped, ['slow_tool']);
});

test('a chained call whose result is ready before its reply ends does not end the turn', async () => {
  // Measured with warm MCP connections: the second call finished before the reply
  // that asked for it was done, and the turn was declared over while the agent
  // was about to answer (Session History showed the answer arriving after it).
  const h = harness();
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c1', name: 'search', arguments: {} });
  h.ev('reply.done', { status: 'completed' });
  h.releases.get('c1')!({ result: '"r1"' });
  await h.tick();                                    // first result out: an answer is expected
  h.ev('reply.started');
  h.ev('tool.call', { call_id: 'c2', name: 'read', arguments: {} });   // it chains instead of answering
  h.releases.get('c2')!({ result: '"r2"' });
  await h.tick();                                    // ready before this reply ends
  h.ev('reply.done', { status: 'completed' });       // so c2 goes out now
  assert.equal(results(h.sent).length, 2);
  assert.ok(!h.log.includes('IDLE'), 'the answer to c2 has not been spoken');
  h.ev('reply.started');
  h.ev('reply.done', { status: 'completed' });       // the answer
  assert.equal(h.log.filter((l) => l === 'IDLE').length, 1);
});
