import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  findIdentifiers, isIdentifierShaped, identifierKind, collapseSpelled, appearsVerbatim,
  classifyWrite, sharedPrefixTokens, gateTools, ToolGate, callKey, isAffirmative, groupInFours,
  pastedTextResult, CONFIRM_WINDOW_MS, isReadOnlyTool,
} from '../src/gate.ts';
import { AgentProtocol } from '../src/protocol.ts';
import type { ExecResult, ToolCall } from '../src/protocol.ts';
import { loadFixture } from './fixtures.ts';

const EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TX64 = 'a3f1c9e2b7d4068f5e1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

// ------------------------------------------------ 1. identifier classifier

test('known positives are identifier-shaped', () => {
  assert.equal(identifierKind(EVM), 'hex0x');
  assert.equal(identifierKind(USDC_MINT), 'base58');
  assert.equal(identifierKind(TX64), 'hex');
  assert.equal(identifierKind(`0x${TX64}`), 'hex0x');
  assert.equal(identifierKind(UUID), 'uuid');
  for (const v of [EVM, USDC_MINT, TX64, UUID]) assert.equal(isIdentifierShaped(v), true, v);
});

test('known negatives are not', () => {
  for (const v of ['London', '2026-09-30', '+14155552671', '94107-1234', 'alex.smith42@example-company.com',
    'please check the reputation of my wallet today', 'afg_get_reputation', 'the tests failed 3 times on run 42']) {
    assert.equal(isIdentifierShaped(v), false, `wrongly an identifier: ${v}`);
  }
});

test('digit-only strings are out of scope, as the README says', () => {
  assert.equal(isIdentifierShaped('4242424242424242'), false);
  assert.equal(isIdentifierShaped('4242 4242 4242 4242'), false);
});

test('spelled-out speech is collapsed back into the value', () => {
  assert.equal(collapseSpelled('wallet 0 x 3 f 9 a 1 c 7 e 5 b 2 d 8 f 4 a'), 'wallet 0x3f9a1c7e5b2d8f4a');
  assert.equal(collapseSpelled('0x3f9a 1c7e 5b2d 8f4a 6c0e'), '0x3f9a1c7e5b2d8f4a6c0e');
  const hits = findIdentifiers('What is the reputation of wallet 0 x 3 f 9 a 1 c 7 e 5 b 2 d 8 f 4 a 6 c 0 e?');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.raw, '0x3f9a1c7e5b2d8f4a6c0e');
  assert.equal(collapseSpelled('the tests failed 3 times on run 42'), 'the tests failed 3 times on run 42', 'prose is untouched');
});

test('hex compares case-insensitively; base58 exactly', () => {
  const [hex] = findIdentifiers(EVM);
  assert.equal(appearsVerbatim(hex!, `pasted: ${EVM.toLowerCase()}`), true);
  const [b58] = findIdentifiers(USDC_MINT);
  assert.equal(appearsVerbatim(b58!, USDC_MINT), true);
  assert.equal(appearsVerbatim(b58!, USDC_MINT.toLowerCase()), false, 'base58 is case-sensitive');
});

// ------------------------------------------------------ 2. write classifier

test('destructiveHint and write-verb names are writes', () => {
  assert.equal(classifyWrite({ name: 'wipe', annotations: { destructiveHint: true } }).write, true);
  for (const n of ['create_wallet', 'delete_user', 'send_email', 'transfer_funds', 'submitOrder', 'post-message', 'upload_file']) {
    assert.equal(classifyWrite({ name: n }).write, true, n);
  }
});

test('read verbs are not writes', () => {
  for (const n of ['get_balance', 'list_orders', 'search_docs', 'fetch_page', 'read_file', 'find_tools', 'describe_table']) {
    assert.equal(classifyWrite({ name: n }).write, false, n);
  }
});

test('readOnlyHint wins over a write-looking name; destructiveHint wins over everything', () => {
  assert.equal(classifyWrite({ name: 'create_preview', annotations: { readOnlyHint: true } }).write, false);
  assert.equal(classifyWrite({ name: 'get_and_clear', annotations: { readOnlyHint: true, destructiveHint: true } }).write, true);
});

test('a prefix every tool shares is stripped first', () => {
  assert.equal(sharedPrefixTokens(['afg_create_wallet', 'afg_get_job', 'afg_fund']), 1);
  assert.equal(sharedPrefixTokens(['solo_tool']), 0, 'one tool: nothing is shared');
  assert.equal(classifyWrite({ name: 'afg_create_wallet' }, 1).write, true);
  assert.equal(classifyWrite({ name: 'afg_create_wallet' }, 0).write, false, 'without stripping, "afg" is the first token');
});

test("AFG's real 15 tools: the classifier agrees with the hand-written list, with and without annotations", () => {
  const fx = loadFixture('afg-marketplace');
  const hand = new Set(['afg_create_wallet', 'afg_post_job', 'afg_sign_contract', 'afg_fund', 'afg_submit', 'afg_dispute', 'afg_appeal', 'afg_upload_artifact', 'afg_discard_wallet']);
  const shared = sharedPrefixTokens(fx.tools.map((t) => t.name));
  for (const withAnnotations of [true, false]) {
    const disagreements = fx.tools
      .filter((t) => classifyWrite({ name: t.name, annotations: withAnnotations ? t.annotations : undefined }, shared).write !== hand.has(t.name))
      .map((t) => t.name);
    assert.deepEqual(disagreements, [], `${withAnnotations ? 'with' : 'without'} annotations`);
  }
});

// --------------------------------------------------------- 3. protocol level

const AFG_TOOLS = () => {
  const fx = loadFixture('afg-marketplace');
  return gateTools(fx.tools.map((t) => ({ voiceName: t.name, source: t })), []);
};

/** AgentProtocol + ToolGate + a transport that only counts. */
function rig() {
  const gate = new ToolGate(AFG_TOOLS(), 'afg.ai');
  let requests = 0;
  const cards: string[] = [];
  const results: string[] = [];
  let now = 1_000_000;
  const proto = new AgentProtocol(
    (m) => { if (m.type === 'tool.result') results.push(String(m.result)); },
    async (call: ToolCall): Promise<ExecResult> => {
      const d = gate.check(call.name, call.arguments, now);
      if (d.action !== 'execute') { cards.push(d.action); return { result: d.result }; }
      requests++;                                   // the fake MCP transport
      const raw = JSON.stringify({ ok: true, echoed: call.arguments });
      gate.recordToolResult(raw, call.arguments);
      return { result: raw };
    },
  );
  const tick = () => new Promise((r) => setImmediate(r));
  const call = async (id: string, name: string, args: Record<string, unknown>) => {
    proto.handle({ type: 'reply.started' });
    proto.handle({ type: 'tool.call', call_id: id, name, arguments: args });
    await tick();
    proto.handle({ type: 'reply.done', status: 'completed' });
    proto.handle({ type: 'reply.started' });
    proto.handle({ type: 'reply.done', status: 'completed' });
  };
  return { gate, call, get requests() { return requests; }, cards, results, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}

test('D4: a spoken identifier needs a paste, "yes, that\'s right" releases nothing, and the paste runs exactly once', async () => {
  const r = rig();
  // The measured mishearing: said ...6c0e9b...5c8e..., heard ...6ce09b...5cad...
  const heard = { address: '0x3f9a1c7e5b2d8f4a6ce09b3d7f1a5cad2b4d6f09' };
  await r.call('c1', 'afg_get_reputation', heard);
  assert.equal(r.requests, 0, 'held: no MCP request');
  const body = JSON.parse(r.results[0]!);
  assert.equal(body.status, 'needs_paste');
  assert.equal(body.heard, heard.address);
  assert.match(body.say, /may have misheard/);

  r.advance(5000);
  r.gate.recordUserTurn("yes, that's right", r.now);
  await r.call('c2', 'afg_get_reputation', heard);
  assert.equal(r.requests, 0, 'a spoken yes releases nothing: still 0 requests');
  assert.deepEqual(r.cards, ['paste', 'paste']);

  // The paste path: the value itself, exactly one request, byte-identical.
  const said = '0x3f9a1c7e5b2d8f4a6c0e9b3d7f1a5c8e2b4d6f09';
  r.gate.recordPaste(said);
  await r.call('c3', 'afg_get_reputation', { address: said });
  assert.equal(r.requests, 1, 'the pasted value runs, once');
  const sha = (x: string) => createHash('sha256').update(x).digest('hex');
  assert.equal(sha(JSON.parse(r.results[2]!).echoed.address), sha(said));
});

test('Trigger A applies first: a state change carrying a spoken identifier needs a paste, even after yes', async () => {
  const r = rig();
  const args = { job_id: 'job 7', recipient: '0x3f9a1c7e5b2d8f4a6ce09b3d7f1a5cad2b4d6f09' };
  await r.call('c1', 'afg_fund', args);
  assert.equal(JSON.parse(r.results[0]!).status, 'needs_paste');
  r.gate.recordUserTurn('yes, go ahead', r.now);
  await r.call('c2', 'afg_fund', args);
  assert.equal(r.requests, 0);
  assert.deepEqual(r.cards, ['paste', 'paste']);
});

test('a changed repeat is gated again, even after a yes', async () => {
  const r = rig();
  await r.call('c1', 'afg_get_reputation', { address: '0x3f9a1c7e5b2d8f4a6ce09b3d7f1a5cad2b4d6f09' });
  r.gate.recordUserTurn('yes', r.now);
  await r.call('c2', 'afg_get_reputation', { address: '0x3f9a1c7e5b2d8f4a6c0e9b3d7f1a5c8e2b4d6f09' });
  assert.equal(r.requests, 0);
  assert.deepEqual(r.cards, ['paste', 'paste']);
});

test('a no, or a yes outside the window, does not release a state change', async () => {
  const r = rig();
  const args = { job_id: 'job 7' };
  await r.call('c1', 'afg_fund', args);
  r.gate.recordUserTurn("no, that's wrong", r.now);
  await r.call('c2', 'afg_fund', args);
  assert.equal(r.requests, 0, 'a no is not a yes');
  r.advance(CONFIRM_WINDOW_MS + 1000);
  r.gate.recordUserTurn('yes', r.now);
  await r.call('c3', 'afg_fund', args);
  assert.equal(r.requests, 0, 'a yes after the 120 s window confirms nothing');
});

test('a pasted value passes straight through, exactly', async () => {
  const r = rig();
  r.gate.recordPaste(EVM);
  await r.call('c1', 'afg_get_reputation', { address: EVM });
  assert.equal(r.requests, 1);
  assert.equal(JSON.parse(r.results[0]!).echoed.address, EVM);
});

test('an identifier from an earlier tool result passes through', async () => {
  const r = rig();
  r.gate.recordToolResult(JSON.stringify({ job_id: 'job_7f3a9c2e1b4d6f80a5c3' }));
  await r.call('c1', 'afg_get_job', { job_id: 'job_7f3a9c2e1b4d6f80a5c3' });
  assert.equal(r.requests, 1);
});

test('a state-changing tool is gated, names what it will do, and runs once after yes', async () => {
  const r = rig();
  await r.call('c1', 'afg_fund', { job_id: 'job 7' });
  assert.equal(r.requests, 0);
  const body = JSON.parse(r.results[0]!);
  assert.equal(body.reason, 'changes_state');
  assert.match(body.say, /on afg\.ai\. Should I go ahead\?$/);
  r.gate.recordUserTurn('go ahead', r.now);
  await r.call('c2', 'afg_fund', { job_id: 'job 7' });
  assert.equal(r.requests, 1);
});

test('a read-only tool with plain arguments is never gated', async () => {
  const r = rig();
  await r.call('c1', 'afg_contract_template', { category: 'code_fix_test_suite_pass' });
  assert.equal(r.requests, 1);
  assert.deepEqual(r.cards, []);
});

test('the original schema pattern is enforced before any request', () => {
  const gate = new ToolGate([{ voiceName: 'lookup', mcpName: 'lookup', what: 'Looks up.', write: false, writeReason: '', patterns: { address: '^0x[0-9a-fA-F]{40}$' } }], 'x');
  const d = gate.check('lookup', { address: '0x3f9a1c7e5b2d8f4a6ce0e9b3d7f1a5cade2b4d6f09' }, 0);   // 42 hex: the measured mishearing
  assert.equal(d.action, 'invalid');
  assert.equal(JSON.parse(d.action === 'invalid' ? d.result : '{}').status, 'invalid');
});

test('the call key ignores hex case and speech spacing, so a re-cased repeat still matches', () => {
  assert.equal(callKey('t', { a: EVM }), callKey('t', { a: EVM.toLowerCase() }));
  assert.notEqual(callKey('t', { a: EVM }), callKey('t', { a: `${EVM.slice(0, -1)}0` }));
});

test('affirmatives and negatives', () => {
  for (const y of ['yes', "yes, that's right", 'yeah go ahead', 'correct', 'do it', 'sure']) assert.equal(isAffirmative(y), true, y);
  for (const n of ['no', "no that's wrong", 'wait', 'cancel it', 'what is the price']) assert.equal(isAffirmative(n), false, n);
});

test('grouping and the paste tool result', () => {
  assert.equal(groupInFours('0x3f9a1c7e'), '0x3f 9a1c 7e');
  const pasted = JSON.parse(pastedTextResult(`  ${EVM} `));
  assert.equal(pasted.text, EVM, 'trimmed, otherwise exact');
  assert.match(pasted.next, /call that tool now/);
  assert.equal(JSON.parse(pastedTextResult('   ')).status, 'empty');
});

test('a tool that echoes its argument does not launder a misheard value', () => {
  const gate = new ToolGate(AFG_TOOLS(), 'afg.ai');
  const heard = { address: '0x3f9a1c7e5b2d8f4a6ce09b3d7f1a5cad2b4d6f09' };
  gate.recordToolResult(JSON.stringify({ address: heard.address.toUpperCase(), jobs: 0 }), heard);
  assert.equal(gate.check('afg_get_reputation', heard, 0).action, 'paste', 'the echo is not evidence');
  // But a value the tool produced on its own - not in the arguments - still counts.
  gate.recordToolResult(JSON.stringify({ job_id: 'job_9c1e7a3b5d2f40e86b1a' }), { category: 'x' });
  assert.equal(gate.check('afg_get_job', { job_id: 'job_9c1e7a3b5d2f40e86b1a' }, 0).action, 'execute');
});

test('read-only for the spoken sweep: the hint when there is one, the classifier when there is not', () => {
  assert.equal(isReadOnlyTool({ name: 'delete_thing', annotations: { readOnlyHint: true } }), true, 'the hint wins');
  assert.equal(isReadOnlyTool({ name: 'get_thing', annotations: { readOnlyHint: false } }), false, 'an explicit false is taken at its word');
  assert.equal(isReadOnlyTool({ name: 'get_thing' }), true, 'unannotated, and a read verb');
  assert.equal(isReadOnlyTool({ name: 'send_payment' }), false, 'unannotated, and a write verb');
  assert.equal(isReadOnlyTool({ name: 'lookup', annotations: { destructiveHint: true } }), false);
});
