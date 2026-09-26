import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, makeShaper, newShaperStats, BREAKER_OPEN_MS } from '../src/shaper.ts';

const fakeFetch = (status: number, body: unknown = {}, delayMs = 0): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

const input = { text: '{"a":1}', toolName: 't', maxChars: 600 };

test('the breaker opens for exactly the configured window', () => {
  const b = new CircuitBreaker(1000);
  assert.equal(b.isOpen(0), false);
  b.trip(10_000);
  assert.equal(b.isOpen(10_000), true);
  assert.equal(b.isOpen(10_999), true);
  assert.equal(b.isOpen(11_000), false, 'closed again once the window passes');
  assert.equal(b.trips, 1);
});

test('the default window is 60 seconds', () => {
  assert.equal(BREAKER_OPEN_MS, 60_000);
  assert.equal(new CircuitBreaker().openMs, 60_000);
});

test('a single 429 trips the breaker', async () => {
  const breaker = new CircuitBreaker();
  const stats = newShaperStats();
  const shaper = makeShaper({ stats, breaker, apiKey: 'test', fetchImpl: fakeFetch(429, { message: 'too many requests for this action' }) });
  await assert.rejects(() => shaper(input), /429/);
  assert.equal(breaker.isOpen(), true, 'one refusal is enough');
  assert.equal(stats.rateLimited, 1);
  assert.ok(breaker.secondsLeft() > 55 && breaker.secondsLeft() <= 60);
});

test('other failures do not trip the breaker', async () => {
  for (const status of [400, 500, 503]) {
    const breaker = new CircuitBreaker();
    const shaper = makeShaper({ stats: newShaperStats(), breaker, apiKey: 'test', fetchImpl: fakeFetch(status, { message: 'x' }) });
    await assert.rejects(() => shaper(input));
    assert.equal(breaker.isOpen(), false, `${status} must not open it`);
  }
});

test('the network call is aborted at its own deadline, releasing the socket', async () => {
  const stats = newShaperStats();
  const shaper = makeShaper({ stats, breaker: new CircuitBreaker(), apiKey: 'test', fetchImpl: fakeFetch(200, {}, 5000), timeoutMs: 40 });
  const started = Date.now();
  await assert.rejects(() => shaper(input));
  assert.ok(Date.now() - started < 400, 'must abort near the deadline, not wait 5 s');
  assert.equal(stats.timeouts, 1);
  assert.match(stats.lastError ?? '', /timeout after/);
});

test('a good completion is returned and counted as used', async () => {
  const stats = newShaperStats();
  const shaper = makeShaper({
    stats, breaker: new CircuitBreaker(), apiKey: 'test',
    fetchImpl: fakeFetch(200, { choices: [{ message: { content: '  A is one.  ' } }] }),
  });
  assert.equal(await shaper(input), 'A is one.');
  assert.equal(stats.used, 1);
  assert.equal(stats.failures, 0);
});

test('an empty completion is a failure, not a silent answer', async () => {
  const stats = newShaperStats();
  const shaper = makeShaper({ stats, breaker: new CircuitBreaker(), apiKey: 'test', fetchImpl: fakeFetch(200, { choices: [{ message: { content: '' } }] }) });
  await assert.rejects(() => shaper(input), /empty completion/);
  assert.equal(stats.failures, 1, 'counted exactly once');
});
