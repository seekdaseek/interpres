import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialPhase, handleFindTools, assertPhaseValid, phaseSessionUpdate, keytermsSessionUpdate,
  MAX_TOOLS_PER_PHASE, FIND_TOOLS_NAME, findToolsDefinition, TRANSCRIPTION_MODE,
} from '../src/phases.ts';
import { convertCatalog } from '../src/convert.ts';
import { buildSystemPrompt, ANTI_FABRICATION, buildGreeting } from '../src/prompt.ts';
import type { McpTool } from '../src/types.ts';
import { loadFixture } from './fixtures.ts';

const mkTools = (n: number): McpTool[] =>
  Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: `Does job ${i}.` }));

const inputOf = (tools: McpTool[]) => ({
  catalog: convertCatalog(tools).converted,
  server: { name: 'test-server', title: 'Test Server' },
});

test('a catalog that fits is shown whole, with use_pasted_text and no discovery tool', () => {
  // use_pasted_text takes one of the ten slots, so nine catalog tools is the most that fits.
  for (const n of [1, 5, MAX_TOOLS_PER_PHASE - 1]) {
    const phase = initialPhase(inputOf(mkTools(n)));
    assertPhaseValid(phase);
    assert.equal(phase.tools.length, n + 1, `${n} tools plus use_pasted_text should all be visible`);
    assert.equal(phase.hasFindTools, false, `find_tools would waste a slot at ${n} tools`);
    assert.ok(!phase.tools.some((t) => t.name === FIND_TOOLS_NAME));
    assert.ok(phase.tools.some((t) => t.name === 'use_pasted_text'), 'the paste box is always reachable');
  }
});

test('a catalog that overflows gets find_tools, use_pasted_text and eight', () => {
  for (const n of [MAX_TOOLS_PER_PHASE, 15, 40]) {
    const phase = initialPhase(inputOf(mkTools(n)));
    assertPhaseValid(phase);
    assert.equal(phase.tools.length, MAX_TOOLS_PER_PHASE, `${n} tools must narrow to ${MAX_TOOLS_PER_PHASE}`);
    assert.equal(phase.hasFindTools, true);
    assert.equal(phase.tools[0]!.name, FIND_TOOLS_NAME, 'discovery goes first');
    assert.equal(phase.tools[1]!.name, 'use_pasted_text', 'then the paste box');
    assert.equal(phase.visible.length, MAX_TOOLS_PER_PHASE - 2);
  }
});

test('find_tools keeps both built-ins and reveals eight catalog tools', () => {
  const { phase, available, toolResult } = handleFindTools(inputOf(mkTools(30)), 'job 17');
  assertPhaseValid(phase);
  assert.equal(phase.visible.length, 8);
  assert.ok(available.includes('use_pasted_text') && available.includes(FIND_TOOLS_NAME));
  const listed = JSON.parse(toolResult).available_tools as string[];
  assert.ok(!listed.includes('use_pasted_text') && !listed.includes(FIND_TOOLS_NAME), 'the result lists only catalog tools');
});

test('the prompt tells the agent to use the paste box for anything pasted', () => {
  assert.match(initialPhase(inputOf(mkTools(3))).systemPrompt, /call\s+use_pasted_text/);
});

test('the documented ceiling is never exceeded, whatever find_tools is asked', () => {
  const input = inputOf(mkTools(40));
  for (const q of ['job 7', '', 'something with no match at all', 'tool']) {
    const { phase } = handleFindTools(input, q);
    assertPhaseValid(phase);
    assert.ok(phase.tools.length <= MAX_TOOLS_PER_PHASE, `${q}: ${phase.tools.length} tools`);
  }
});

test('find_tools reports back exactly the names that are now callable', () => {
  const input = inputOf(mkTools(30));
  const out = handleFindTools(input, 'job 17');
  assert.deepEqual(out.available, out.phase.tools.map((t) => t.name));
  assert.ok(out.available.includes('tool_17'), `expected tool_17 among ${out.available.join(',')}`);
  assert.ok(out.available.includes(FIND_TOOLS_NAME), 'discovery must stay reachable');
});

test('a server tool named find_tools cannot shadow the meta-tool', () => {
  const catalog = convertCatalog(
    [{ name: 'find_tools', description: 'the server has its own' }, ...mkTools(12)],
    { reserved: [FIND_TOOLS_NAME] },
  ).converted;
  const phase = initialPhase({ catalog, server: undefined });
  assertPhaseValid(phase);
  const names = phase.tools.map((t) => t.name);
  assert.equal(names.filter((n) => n === FIND_TOOLS_NAME).length, 1, 'exactly one find_tools');
});

test('a phase over the limit is rejected rather than sent', () => {
  // The API validates none of this, so our own guard is the only one there is.
  const input = inputOf(mkTools(20));
  const phase = initialPhase(input);
  phase.tools.push(...input.catalog.slice(0, 5).map((c) => c.tool));
  assert.throws(() => assertPhaseValid(phase), /over the 10 limit/);
});

test('a duplicate tool name in a phase is rejected', () => {
  const phase = initialPhase(inputOf(mkTools(3)));
  phase.tools.push(phase.tools[0]!);
  assert.throws(() => assertPhaseValid(phase), /duplicate tool names/);
});

test('an empty description is rejected, since the API requires one', () => {
  const phase = initialPhase(inputOf(mkTools(2)));
  phase.tools[0]!.description = '';
  assert.throws(() => assertPhaseValid(phase), /empty description/);
});

test('parameters that are not an object schema are rejected', () => {
  const phase = initialPhase(inputOf(mkTools(2)));
  phase.tools[0]!.parameters = { type: 'string' };
  assert.throws(() => assertPhaseValid(phase), /must be type:"object"/);
});

test('the session.update body carries only mutable fields', () => {
  const upd = phaseSessionUpdate(initialPhase(inputOf(mkTools(12))));
  assert.equal(upd.type, 'session.update');
  assert.deepEqual(Object.keys(upd.session).sort(), ['input', 'system_prompt', 'tools']);
  // greeting, output.voice and output.format raise immutable_field after
  // session.ready, so a phase update must never mention them.
  const blob = JSON.stringify(upd);
  for (const banned of ['greeting', '"voice"', '"output"']) {
    assert.ok(!blob.includes(banned), `${banned} must not appear in a mid-session update`);
  }
  assert.deepEqual(Object.keys(upd.session.input as object).sort(), ['keyterms', 'transcription_mode', 'transcription_prompt']);
});

test('every update carries the transcription mode: the phase update, after a swap too, and the paste update', () => {
  // Round H: min_latency, measured against balanced in docs/LATENCY.md. The field is mutable,
  // and an update that left it out would leave the mode to whatever the API does then.
  assert.equal(TRANSCRIPTION_MODE, 'min_latency');
  const input = inputOf(mkTools(30));
  for (const phase of [initialPhase(input), handleFindTools(input, 'job 3').phase]) {
    assert.equal((phaseSessionUpdate(phase).session.input as Record<string, unknown>).transcription_mode, 'min_latency');
  }
  const paste = keytermsSessionUpdate(['ochinimus', 'AgentFeed']);
  assert.deepEqual(paste, { type: 'session.update', session: { input: { keyterms: ['ochinimus', 'AgentFeed'], transcription_mode: 'min_latency' } } });
});

test('tools and system_prompt always move together', () => {
  // "Tool-only gating where the prompt still references a now-hidden tool can
  // underperform not gating at all." So every prompt must name every visible
  // tool, and no hidden one.
  const input = inputOf(mkTools(30));
  const { phase } = handleFindTools(input, 'job 3');
  for (const c of phase.visible) {
    assert.ok(phase.systemPrompt.includes(c.tool.name), `prompt must name visible ${c.tool.name}`);
  }
  const hidden = input.catalog.filter((c) => !phase.visible.includes(c));
  for (const c of hidden) {
    assert.ok(!phase.systemPrompt.includes(`- ${c.tool.name}:`), `prompt must not list hidden ${c.tool.name}`);
  }
});

test('the prompt carries the anti-fabrication clause and the call-the-tool rule', () => {
  const phase = initialPhase(inputOf(mkTools(3)));
  assert.ok(phase.systemPrompt.includes(ANTI_FABRICATION));
  assert.match(phase.systemPrompt, /When in doubt, call the tool/);
});

test('the prompt only explains find_tools when find_tools exists', () => {
  assert.ok(!initialPhase(inputOf(mkTools(4))).systemPrompt.includes('find_tools'));
  const big = initialPhase(inputOf(mkTools(25)));
  assert.match(big.systemPrompt, /call\s+find_tools/);
  assert.match(big.systemPrompt, /25 tools in total/);
});

test("the server's own instructions reach the prompt", () => {
  const fx = loadFixture('afg-marketplace');
  const phase = initialPhase({
    catalog: convertCatalog(fx.tools).converted,
    server: fx.initialize.serverInfo,
    instructions: fx.initialize.instructions,
  });
  assert.match(phase.systemPrompt, /in its own words/);
  assert.match(phase.systemPrompt, /Agent Fulfillment Guarantee/);
});

test('the phase records why it exists, for the timeline', () => {
  assert.match(initialPhase(inputOf(mkTools(3))).reason, /fits in one phase/);
  assert.match(initialPhase(inputOf(mkTools(30))).reason, /exceeds the 10-tool limit/);
  assert.match(handleFindTools(inputOf(mkTools(30)), 'job 1').phase.reason, /^find_tools\("job 1"\)$/);
});

test('the discovery tool describes a trigger and an anti-trigger', () => {
  const t = findToolsDefinition(30, 9);
  assert.equal(t.type, 'function');
  assert.match(t.description, /21 tools/, 'it should say how many are hidden');
  assert.match(t.description, /Do not call it/, 'an anti-trigger prevents it firing on small talk');
  assert.deepEqual(t.parameters.required, ['query']);
  assert.ok(Array.isArray((t.parameters.properties!.query as any).examples));
});

test('a phase built from a real catalog passes every guard', () => {
  const fx = loadFixture('afg-marketplace');
  const input = { catalog: convertCatalog(fx.tools).converted, server: fx.initialize.serverInfo, instructions: fx.initialize.instructions };
  assertPhaseValid(initialPhase(input));
  for (const q of ['dispute a job', 'create a wallet', 'reputation']) {
    assertPhaseValid(handleFindTools(input, q).phase);
  }
});

test('the greeting names the server and its tool count', () => {
  assert.equal(buildGreeting({ title: 'Acme' }, 3), 'Connected to Acme, with 3 tools available. What would you like to do?');
  assert.match(buildGreeting({ title: 'Acme' }, 1), /1 tool available/);
  assert.match(buildGreeting(undefined, 2), /^Connected to this server/);
});

test('a prompt for an unnamed server still reads properly', () => {
  const p = buildSystemPrompt({ server: undefined, visible: [], catalogSize: 0, hasFindTools: false });
  assert.match(p, /voice interface to an MCP server/);
});
