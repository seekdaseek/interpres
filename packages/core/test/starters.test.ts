import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStarterPrompt, parseStarters, readOnlyTools, templateStarters, usableStarter, STARTER_COUNT } from '../src/starters.ts';
import { loadFixture } from './fixtures.ts';

test('only read-only tools feed the starters: AFG keeps 6 of its 15', () => {
  const ro = readOnlyTools(loadFixture('afg-marketplace').tools).map((t) => t.name);
  assert.equal(ro.length, 6);
  for (const w of ['afg_fund', 'afg_sign_contract', 'afg_create_wallet']) assert.ok(!ro.includes(w), `${w} changes state`);
});

test('the prompt lists the tools and asks for JSON', () => {
  const p = buildStarterPrompt('Books', 'Book picks.', readOnlyTools(loadFixture('most-recommended-books').tools));
  assert.match(p, /^Server: Books/);
  assert.match(p, /- get_series_reading_order: /);
});

test("the model's JSON is read even inside a code fence; identifiers and URLs are dropped", () => {
  const out = parseStarters('```json\n{"questions": ["What books does Oprah recommend?", "Check 0x3f9a1c7e5b2d8f4a6c0e9b3d7f1a5c8e2b4d6f09", "Open https://x.example"]}\n```');
  assert.deepEqual(out, ['What books does Oprah recommend?']);
  assert.equal(parseStarters('Sure! Here are some questions.'), null, 'no JSON: templates');
  assert.equal(parseStarters('{"questions": []}'), null, 'nothing usable: templates');
  assert.equal(parseStarters(`{"questions": ${JSON.stringify(Array(5).fill('What is the weather in Paris?').map((q, i) => `${q} ${i}`))}}`)?.length, STARTER_COUNT);
});

test('a starter is short and needs no spelling out', () => {
  assert.equal(usableStarter('What can I cook with rice?'), true);
  assert.equal(usableStarter('Hi'), false);
  assert.equal(usableStarter('x'.repeat(200)), false);
});

test('templates come from the descriptions, then from the names', () => {
  assert.deepEqual(templateStarters(readOnlyTools(loadFixture('most-recommended-books').tools)), [
    "Can you search Most Recommended Books' human-curated catalog by book title or author name?",
    'Can you return every book a specific person has recommended?',
    'Can you return every verified person who recommends a given book?',
  ]);
  // AdvisorsAI's descriptions address the agent ("Use when..."), so the names speak instead.
  assert.deepEqual(templateStarters(readOnlyTools(loadFixture('advisorsai-service-navigator').tools)), ['Can you list services?', 'Can you get service?', 'Can you match service?']);
  assert.deepEqual(templateStarters([]), ['What can you do?']);
});
