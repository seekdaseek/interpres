import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyterms, buildTranscriptionPrompt, isIdentifierLike, KEYTERMS_MAX, TRANSCRIPTION_PROMPT_MAX } from '../src/keyterms.ts';
import { convertCatalog } from '../src/convert.ts';
import { allFixtures, loadFixture } from './fixtures.ts';

for (const fx of allFixtures()) {
  test(`keyterms and prompt stay inside the documented limits: ${fx.name}`, () => {
    const catalog = convertCatalog(fx.tools).converted;
    const kt = buildKeyterms(catalog, fx.initialize.serverInfo);
    assert.ok(kt.length <= KEYTERMS_MAX, `${kt.length} keyterms, limit ${KEYTERMS_MAX}`);
    assert.equal(new Set(kt.map((t) => t.toLowerCase())).size, kt.length, 'no duplicates');
    for (const t of kt) assert.ok(t.trim() !== '', 'no blank keyterms');
    const tp = buildTranscriptionPrompt(catalog, fx.initialize.serverInfo, fx.initialize.instructions);
    assert.ok(tp.length <= TRANSCRIPTION_PROMPT_MAX, `${tp.length} chars, limit ${TRANSCRIPTION_PROMPT_MAX}`);
    assert.ok(tp.length > 0);
  });
}

test('enum values lead, because the caller says those literally', () => {
  const kt = buildKeyterms(
    convertCatalog([
      { name: 'route_call', description: 'd', inputSchema: { type: 'object', properties: { dept: { type: 'string', description: 'd', enum: ['billing', 'sales'] } } } },
    ]).converted,
    { name: 'acme' },
  );
  assert.deepEqual(kt.slice(0, 2), ['billing', 'sales']);
});

test('an identifier-shaped example is boosted but prose is not', () => {
  const kt = buildKeyterms(
    convertCatalog([
      { name: 't', description: 'd', inputSchema: { type: 'object', properties: {
        code: { type: 'string', description: 'd', examples: ['AB-12345'] },
        note: { type: 'string', description: 'd', examples: ['a sentence of prose'] },
      } } },
    ]).converted,
    undefined,
  );
  assert.ok(kt.includes('AB-12345'));
  assert.ok(!kt.includes('a sentence of prose'));
});

test('the cap is enforced against a catalog that overflows it', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    name: `tool_${i}`,
    description: 'd',
    inputSchema: { type: 'object', properties: { x: { type: 'string', description: 'd', enum: [`enumvalue${i}a`, `enumvalue${i}b`, `enumvalue${i}c`] } } },
  }));
  const kt = buildKeyterms(convertCatalog(many).converted, { name: 'big' });
  assert.equal(kt.length, KEYTERMS_MAX);
});

test('stopwords do not waste one of the hundred slots', () => {
  const kt = buildKeyterms(convertCatalog([{ name: 'get_the_thing_from_a_place', description: 'd' }]).converted, undefined);
  for (const w of ['get', 'the', 'from']) assert.ok(!kt.includes(w), `${w} should be filtered`);
  assert.ok(kt.includes('thing') && kt.includes('place'));
});

test("the prompt uses the server's own instructions when it sent some", () => {
  const fx = loadFixture('assemblyai-docs-mcp');
  assert.ok(fx.initialize.instructions, 'this fixture must carry instructions');
  const tp = buildTranscriptionPrompt(convertCatalog(fx.tools).converted, fx.initialize.serverInfo, fx.initialize.instructions);
  assert.match(tp, /Model Context Protocol server/);
  assert.match(tp, /^The caller is talking to AssemblyAI by voice\./);
});

test('the prompt truncates on a word boundary when it overflows', () => {
  const tp = buildTranscriptionPrompt([], { name: 'x' }, 'word '.repeat(1000), 200);
  assert.ok(tp.length <= 200);
  assert.ok(!tp.endsWith('wor'), 'must not cut mid-word');
});

test('identifier detection distinguishes tokens from prose', () => {
  for (const yes of ['AB-12345', 'sk_test_1', 'v2', 'snake_case', 'a/b']) assert.equal(isIdentifierLike(yes), true, yes);
  for (const no of ['billing', 'a sentence here', '', 'x'.repeat(60)]) assert.equal(isIdentifierLike(no), false, no);
});
