import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyterms, buildTranscriptionPrompt, isIdentifierLike, speechForm, brandTokens, KEYTERMS_MAX, TRANSCRIPTION_PROMPT_MAX, KEYTERM_MAX_CHARS, KEYTERM_MAX_WORDS } from '../src/keyterms.ts';
import { COMMON_WORDS, isCommonWord } from '../src/common-words.ts';
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
      { name: 'route_call', description: 'd', inputSchema: { type: 'object', properties: { dept: { type: 'string', description: 'd', enum: ['underwriting', 'reinsurance'] } } } },
    ]).converted,
    { name: 'acme' },
  );
  assert.deepEqual(kt.slice(0, 2), ['underwriting', 'reinsurance']);
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

test('common words do not waste one of the hundred slots', () => {
  // The docs: "Don't add common English words ... it dilutes the boost."
  const kt = buildKeyterms(convertCatalog([{ name: 'get_the_thing_from_a_zeppelin', description: 'd' }]).converted, undefined);
  for (const w of ['get', 'the', 'thing', 'from']) assert.ok(!kt.includes(w), `${w} should be filtered`);
  assert.ok(kt.includes('zeppelin'), 'the rare word survives');
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

// ------------------------------------------------ 0c: keyterm quality

/** The 21 terms Sergiu's key-terms pane showed for AdvisorsAI on 2026-09-26. */
const SERGIU_21 = [
  'ar', 'en', 'store-assistant', 'store-audit', 'ai-visibility', 'custom-monitor', 'agent-team', 'https://example.com',
  'store-audit.first-audit', 'advisors', 'catalog', 'services', 'service', 'match', 'site', 'check', 'basics', 'order',
  'prepare', 'link', 'navigator',
];

test('the bundled common-word list actually loads', () => {
  assert.ok(COMMON_WORDS.size >= 500, `only ${COMMON_WORDS.size} words loaded`);
  for (const w of ['check', 'site', 'match', 'link', 'order', 'service']) assert.ok(isCommonWord(w), `${w} must be common`);
  assert.ok(isCommonWord('services') && isCommonWord('signed') && isCommonWord('listing'), 'plurals and inflections');
  for (const w of ['navigator', 'advisors', 'AssemblyAI', 'speccheck', 'Ozempic']) assert.ok(!isCommonWord(w), `${w} must not be common`);
});

test("every junk term in Sergiu's 21 is gone, and the names survive", () => {
  const kept = SERGIU_21.map(speechForm).filter((t): t is string => t !== null);
  for (const junk of ['https://example.com', 'ar', 'en', 'store-audit.first-audit', 'check', 'site', 'match', 'link', 'order', 'service', 'services']) {
    assert.ok(!kept.includes(junk), `${junk} survived`);
  }
  assert.deepEqual(kept, ['store assistant', 'store audit', 'AI visibility', 'custom monitor', 'agent team', 'advisors', 'navigator']);
});

test('the AdvisorsAI catalog builds exactly the cleaned set, 21 -> 7', () => {
  const fx = loadFixture('advisorsai-service-navigator');
  const kt = buildKeyterms(convertCatalog(fx.tools).converted, fx.initialize.serverInfo);
  assert.deepEqual(kt, ['store assistant', 'store audit', 'AI visibility', 'custom monitor', 'agent team', 'advisors', 'navigator']);
});

test('slugs are written the way speech-to-text writes them', () => {
  assert.equal(speechForm('store-assistant'), 'store assistant');
  assert.equal(speechForm('ai-visibility'), 'AI visibility');
  assert.equal(speechForm('mcp_server_status'), 'MCP server status');
  assert.equal(speechForm('AB-12345'), 'AB-12345', 'a code with digits is not a slug');
});

test('each drop rule, with a survivor next to it as the control', () => {
  const cases: Array<[string, string | null]> = [
    ['https://example.com', null], ['www.acme.io', null], ['example.org', null], ['alex@acme.com', null],
    ['io.github.seekdaseek/agentfeed', null], ['store-audit.first-audit', null], ['v2.1', null],
    ['0x3f9a1c7e5b2d8f4a6c0e9b3d7f1a5c8e2b4d6f09', null], ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', null],
    ['ar', null], ['en', null], ['check', null], ['services', null],
    ['one-two-three-four', null], ['x'.repeat(51), null],
    ['Ozempic', 'Ozempic'], ['filesystem', 'filesystem'],
  ];
  for (const [input, want] of cases) assert.equal(speechForm(input), want, input);
});

test("brand tokens keep a server's own spelling", () => {
  assert.deepEqual(brandTokens('AssemblyAI'), ['AssemblyAI']);
  assert.deepEqual(brandTokens('AFG: Agent Fulfillment Guarantee'), ['AFG', 'fulfillment', 'guarantee']);
  assert.deepEqual(brandTokens('Advisors AI Service Navigator'), ['advisors', 'navigator']);
});

test('a fragment of a kept brand is not repeated', () => {
  const fx = loadFixture('assemblyai-docs-mcp');
  const kt = buildKeyterms(convertCatalog(fx.tools).converted, fx.initialize.serverInfo);
  assert.ok(kt.includes('AssemblyAI'), 'the docs use AssemblyAI as their own keyterm example');
  assert.ok(!kt.includes('assembly'), 'the fragment adds nothing');
});

for (const fx of allFixtures()) {
  test(`every keyterm obeys the documented limits: ${fx.name}`, () => {
    const kt = buildKeyterms(convertCatalog(fx.tools).converted, fx.initialize.serverInfo);
    for (const t of kt) {
      assert.ok(t.length <= KEYTERM_MAX_CHARS, `"${t}" is over ${KEYTERM_MAX_CHARS} chars, which the API ignores`);
      assert.ok(t.split(' ').length <= KEYTERM_MAX_WORDS, `"${t}" is a phrase, not a term`);
      assert.ok(!/^https?:|\//.test(t), `"${t}" is a URL or path`);
    }
  });
}
