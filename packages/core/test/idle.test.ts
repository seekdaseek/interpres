import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdleClock, IDLE_LIMIT_MS } from '../src/idle.ts';

test('an untouched session runs out 60 s after it opened', () => {
  const c = new IdleClock(0);
  assert.equal(IDLE_LIMIT_MS, 60_000);
  assert.equal(c.remainingMs(59_999), 1);
  assert.equal(c.expired(59_999), false);
  assert.equal(c.expired(60_000), true);
});

test('the person speaking starts the count over', () => {
  const c = new IdleClock(0);
  c.hold('user');
  assert.equal(c.remainingMs(50_000), null, 'nothing counts while they talk');
  c.release('user', 52_000);
  c.userSpoke(52_000);
  assert.equal(c.remainingMs(100_000), 12_000);
  assert.equal(c.expired(112_000), true);
});

test('an agent reply and a running tool hold the clock, and it restarts when both end', () => {
  const c = new IdleClock(0);
  c.hold('agent');
  c.hold('tool');
  assert.equal(c.remainingMs(90_000), null, 'a long answer is not idleness');
  c.release('agent', 90_000);
  assert.equal(c.remainingMs(95_000), null, 'the tool is still running');
  c.release('tool', 100_000);
  assert.equal(c.remainingMs(100_000), 60_000);
  assert.equal(c.expired(159_999), false);
  assert.equal(c.expired(160_000), true);
});

test('nested holds of one kind need as many releases', () => {
  const c = new IdleClock(0);
  c.hold('tool');
  c.hold('tool');
  c.release('tool', 10);
  assert.equal(c.remainingMs(20), null);
  c.release('tool', 30);
  assert.equal(c.remainingMs(30), 60_000);
});
