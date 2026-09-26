import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeResult, flattenContent, looksStructured, truncateSpoken, stripStructure,
  SPOKEN_MAX_CHARS, buildShaperUserPrompt,
} from '../src/shape.ts';
import type { Shaper } from '../src/shape.ts';

const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

test('short prose passes through untouched', async () => {
  const r = await shapeResult('get_weather', text('It is 22 degrees and sunny in Tokyo.'));
  assert.equal(r.shaped, false);
  assert.equal(r.method, 'passthrough');
  assert.equal(r.spoken, 'It is 22 degrees and sunny in Tokyo.');
  assert.equal(JSON.parse(r.result).result, r.spoken);
});

test('the result field is always a JSON string, as tool.result requires', async () => {
  for (const input of [text('hi'), text(JSON.stringify({ a: 1 })), { isError: true, content: [{ type: 'text', text: 'boom' }] }, {}]) {
    const r = await shapeResult('t', input);
    assert.equal(typeof r.result, 'string');
    assert.doesNotThrow(() => JSON.parse(r.result), `must parse: ${r.result}`);
  }
});

test('small JSON is still shaped, because size alone is not the test', async () => {
  const r = await shapeResult('t', text('{"temp_c":22,"condition":"sunny"}'));
  assert.equal(r.shaped, true, 'a JSON object is unspeakable however short');
  assert.ok(!r.spoken.includes('{'), `braces must not be read aloud: ${r.spoken}`);
});

test('a markdown table is shaped', async () => {
  const table = '| name | qty |\n| --- | --- |\n| bolt | 4 |\n| nut | 9 |';
  const r = await shapeResult('t', text(table));
  assert.equal(r.shaped, true);
  assert.ok(!r.spoken.includes('|'));
});

test('a long prose result is shaped even though it is not structured', async () => {
  const long = 'This is a sentence of perfectly ordinary prose. '.repeat(80);
  const r = await shapeResult('t', text(long));
  assert.equal(r.shaped, true);
  assert.ok(r.spoken.length <= SPOKEN_MAX_CHARS);
});

test('the shaper is used when supplied, and told what was asked', async () => {
  const seen: any[] = [];
  const shaper: Shaper = async (input) => { seen.push(input); return 'Four bolts and nine nuts are in stock.'; };
  const r = await shapeResult('inventory', text('{"bolt":4,"nut":9}'), { shaper, question: 'how many bolts' });
  assert.equal(r.method, 'llm');
  assert.equal(r.refine, 'used');
  assert.equal(r.spoken, 'Four bolts and nine nuts are in stock.');
  assert.equal(seen[0].question, 'how many bolts');
  assert.equal(seen[0].toolName, 'inventory');
  assert.equal(seen[0].maxChars, SPOKEN_MAX_CHARS);
});

test('a shaper that throws must not leave the agent silent', async () => {
  const shaper: Shaper = async () => { throw new Error('gateway down'); };
  const r = await shapeResult('t', text('{"a":1,"b":2}'), { shaper });
  assert.equal(r.method, 'local');
  assert.equal(r.refine, 'error');
  assert.ok(r.spoken.length > 0, 'something must be said');
  assert.ok(!r.spoken.includes('{'));
});

test('a shaper that returns nothing falls back rather than saying nothing', async () => {
  const r = await shapeResult('t', text('{"a":1}'), { shaper: async () => '   ' });
  assert.equal(r.method, 'local');
  assert.equal(r.refine, 'error');
  assert.ok(r.spoken.length > 0);
});

test('a shaper that overruns the limit is trimmed anyway', async () => {
  const r = await shapeResult('t', text('{"a":1}'), { shaper: async () => 'word '.repeat(500) });
  assert.ok(r.spoken.length <= SPOKEN_MAX_CHARS, `got ${r.spoken.length}`);
});

test('an error keeps the server wording, which the model reads verbatim', async () => {
  const detail = "Could not resolve DROPOFF 'Central station'. Pickup resolved ('SW1A 1AA'). Ask for a UK postcode.";
  const r = await shapeResult('book_ride', { isError: true, content: [{ type: 'text', text: detail }] });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.result).error, detail, 'the failing field must survive unparaphrased');
  assert.equal(r.method, 'passthrough');
});

test('an error is never routed through the shaper', async () => {
  let called = false;
  await shapeResult('t', { isError: true, content: [{ type: 'text', text: 'x'.repeat(5000) }] }, { shaper: async () => { called = true; return 'summary'; } });
  assert.equal(called, false, 'paraphrasing an error loses the field name the agent needs');
});

test('an empty result says so instead of returning nothing', async () => {
  const r = await shapeResult('t', {});
  assert.equal(r.method, 'empty');
  assert.equal(JSON.parse(r.result).result, 'The tool returned nothing.');
  const e = await shapeResult('t', { isError: true });
  assert.equal(JSON.parse(e.result).error, 'The tool reported an error but gave no detail.');
});

test('the raw result is always kept for the UI', async () => {
  const raw = '{"secret":"not spoken","n":1}';
  const r = await shapeResult('t', text(raw), { shaper: async () => 'One item.' });
  assert.equal(r.raw, raw);
  assert.equal(r.rawChars, raw.length);
  assert.equal(r.spoken, 'One item.');
});

test('content blocks flatten, including the unspeakable ones', () => {
  assert.equal(flattenContent({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.match(flattenContent({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }), /cannot be spoken/);
  assert.match(flattenContent({ content: [{ type: 'audio', data: 'x' }] }), /cannot be spoken/);
  assert.equal(flattenContent({ content: [{ type: 'resource', resource: { text: 'inner' } }] }), 'inner');
  assert.equal(flattenContent({ structuredContent: { a: 1 } }), '{"a":1}');
  assert.equal(flattenContent({}), '');
});

test('structure detection catches data and leaves prose alone', () => {
  for (const yes of [
    '{"a":1}', '[1,2,3]',
    '| a | b |\n| - | - |\n| 1 | 2 |',
    'name: bolt\nqty: 4\nsku: AB1\ncolour: red',
  ]) assert.equal(looksStructured(yes), true, `should be structured: ${yes}`);

  for (const no of [
    'It is 22 degrees and sunny in Tokyo.',
    'There are four bolts left, so you may want to reorder.',
    '',
    'Speaker diarization separates who spoke when.',
  ]) assert.equal(looksStructured(no), false, `should be prose: ${no}`);
});

test('truncateSpoken prefers a sentence end and never cuts a word', () => {
  assert.equal(truncateSpoken('Short.', 100), 'Short.');
  const s = truncateSpoken('First sentence here. Second sentence that overflows the budget.', 30);
  assert.equal(s, 'First sentence here.');
  const w = truncateSpoken('aaaa bbbb cccc dddd eeee', 12);
  assert.ok(w.length <= 12);
  assert.ok(!w.includes('cc'));
  assert.equal(truncateSpoken('a\n\nb   c', 100), 'a b c', 'whitespace is collapsed for speech');
});

test('stripStructure pulls words out of JSON rather than reading braces', () => {
  const out = stripStructure('{"temp_c":22,"condition":"sunny"}');
  assert.ok(!out.includes('{') && !out.includes('"'));
  assert.match(out, /temp c 22/);
  assert.match(out, /condition sunny/);
});

test('stripStructure flattens a markdown table and survives non-JSON', () => {
  const out = stripStructure('| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(!out.includes('|'));
  assert.ok(!out.includes('---'));
  assert.equal(stripStructure('just prose'), 'just prose');
});

test('stripStructure is bounded on a huge array', () => {
  const big = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `n${i}` })));
  const out = stripStructure(big);
  assert.ok(out.length < 4000, `bounded, got ${out.length}`);
});

test('the shaper prompt carries the tool, the question and the result', () => {
  const p = buildShaperUserPrompt('get_weather', '{"t":22}', 'what is the weather');
  assert.match(p, /Tool: get_weather/);
  assert.match(p, /The person asked: what is the weather/);
  assert.match(p, /\{"t":22\}/);
  assert.ok(!buildShaperUserPrompt('t', 'x').includes('The person asked'));
});

test('a result just over the threshold is shaped and just under is not', async () => {
  const under = 'a. '.repeat(600);       // ~1800 chars of prose
  const over = 'a. '.repeat(800);        // ~2400 chars
  assert.equal((await shapeResult('t', text(under))).shaped, false);
  assert.equal((await shapeResult('t', text(over))).shaped, true);
});

// ------------------------------------------- the Gateway can never delay speech

test('a slow Gateway is abandoned at the deadline and the local answer is sent', async () => {
  const slow: Shaper = () => new Promise((resolve) => setTimeout(() => resolve('too late'), 5000));
  const started = Date.now();
  const r = await shapeResult('t', text('{"temp_c":22,"condition":"sunny"}'), { shaper: slow, refineDeadlineMs: 60 });
  const elapsed = Date.now() - started;
  assert.equal(r.method, 'local');
  assert.equal(r.refine, 'timeout');
  assert.ok(elapsed < 60 + 150, `waited ${elapsed}ms against a 60ms deadline`);
  assert.ok(r.refineMs >= 55 && r.refineMs < 60 + 150, `refineMs ${r.refineMs}`);
  assert.ok(!r.spoken.includes('too late'));
  assert.ok(r.spoken.length > 0);
});

test('the default deadline is the documented 1.5 s', async () => {
  const { REFINE_DEADLINE_MS } = await import('../src/shape.ts');
  assert.equal(REFINE_DEADLINE_MS, 1500);
});

test('an open breaker means the Gateway is not called at all', async () => {
  let called = 0;
  const shaper: Shaper = async () => { called++; return 'x'; };
  const started = Date.now();
  const r = await shapeResult('t', text('{"a":1}'), { shaper, shaperAvailable: () => false });
  assert.equal(called, 0, 'an open breaker must cost no network call');
  assert.equal(r.refine, 'circuit_open');
  assert.equal(r.method, 'local');
  assert.ok(Date.now() - started < 50, 'and no wait');
});

test('a Gateway that rejects after losing the race leaves no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const late: Shaper = () => new Promise((_, reject) => setTimeout(() => reject(new Error('late 429')), 80));
    const r = await shapeResult('t', text('{"a":1}'), { shaper: late, refineDeadlineMs: 20 });
    assert.equal(r.refine, 'timeout');
    await new Promise((r2) => setTimeout(r2, 150));   // let the late rejection land
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a fast Gateway answer is used and its time recorded', async () => {
  const r = await shapeResult('t', text('{"a":1}'), { shaper: async () => 'A is one.', refineDeadlineMs: 500 });
  assert.equal(r.method, 'llm');
  assert.equal(r.refine, 'used');
  assert.ok(r.refineMs < 500);
});

test('speakable prose never goes near the Gateway', async () => {
  let called = 0;
  const r = await shapeResult('t', text('It is 22 degrees and sunny.'), { shaper: async () => { called++; return 'x'; } });
  assert.equal(called, 0);
  assert.equal(r.refine, 'not_needed');
  assert.equal(r.refineMs, 0);
});
