import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNameMap, convertCatalog } from '@interpres/core';
import { writeStarters } from '../src/starters.ts';
import { CircuitBreaker } from '../src/shaper.ts';
import type { Catalog } from '../src/catalog.ts';
import { loadFixture } from '../../../packages/core/test/fixtures.ts';

function catalog(): Catalog {
  const fx = loadFixture('most-recommended-books');
  const conversion = convertCatalog(fx.tools);
  return { url: 'https://mostrecommendedbooks.com/api/mcp', transport: 'streamable-http', server: fx.initialize.serverInfo, conversion, nameMap: buildNameMap(conversion.converted), fetchedAt: 0 };
}

const reply = (content: string, status = 200) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

test('the Gateway writes them when it can', async () => {
  const s = await writeStarters(catalog(), { breaker: new CircuitBreaker(), apiKey: 'k', fetchImpl: reply('{"questions": ["What books does Bill Gates recommend?", "What is the Dune reading order?", "Who recommends Sapiens?"]}') as typeof fetch });
  assert.equal(s.source, 'gateway');
  assert.equal(s.questions.length, 3);
  assert.equal(s.model, 'qwen3.5-4b-32k-fast');
});

test('a 429 falls back to templates and opens the shared breaker', async () => {
  const breaker = new CircuitBreaker();
  const s = await writeStarters(catalog(), { breaker, apiKey: 'k', fetchImpl: (async () => new Response('too many', { status: 429 })) as typeof fetch });
  assert.equal(s.source, 'template');
  assert.equal(s.reason, 'rate_limited');
  assert.equal(breaker.isOpen(), true);
});

test('an open breaker means the Gateway is not called at all', async () => {
  const breaker = new CircuitBreaker();
  breaker.trip();
  let called = 0;
  const s = await writeStarters(catalog(), { breaker, apiKey: 'k', fetchImpl: (async () => { called++; return new Response('{}'); }) as typeof fetch });
  assert.equal(called, 0);
  assert.equal(s.reason, 'breaker_open');
  assert.ok(s.questions.length > 0, 'templates still give the page something to show');
});

test('unusable output and a timeout both fall back to templates', async () => {
  const bad = await writeStarters(catalog(), { breaker: new CircuitBreaker(), apiKey: 'k', fetchImpl: reply('I cannot help with that.') as typeof fetch });
  assert.equal(bad.reason, 'unusable_output');
  const slow = await writeStarters(catalog(), {
    breaker: new CircuitBreaker(), apiKey: 'k', timeoutMs: 30,
    fetchImpl: ((_u: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as typeof fetch,
  });
  assert.equal(slow.reason, 'timeout');
});
