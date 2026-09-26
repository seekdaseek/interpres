import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, clientKey } from '../src/ratelimit.ts';

const headers = (h: Record<string, string> = {}) => new Headers(h);

test('the per-IP allowance is spent exactly, then refused', () => {
  const rl = new RateLimiter({ perIpPerHour: 3, globalPerDay: 100 });
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) {
    const d = rl.take('sock:1.2.3.4', now);
    assert.equal(d.allowed, true, `call ${i + 1} of 3 should pass`);
    assert.equal(d.allowed && d.remaining, 2 - i);
  }
  const over = rl.take('sock:1.2.3.4', now);
  assert.equal(over.allowed, false);
  assert.equal(over.allowed === false && over.reason, 'per_ip');
  assert.ok(over.allowed === false && over.retryAfterSeconds > 0);
});

test('one address being over the limit does not block another', () => {
  const rl = new RateLimiter({ perIpPerHour: 1, globalPerDay: 100 });
  const now = 1_000_000;
  assert.equal(rl.take('sock:1.1.1.1', now).allowed, true);
  assert.equal(rl.take('sock:1.1.1.1', now).allowed, false);
  assert.equal(rl.take('sock:2.2.2.2', now).allowed, true, 'a different caller is unaffected');
});

test('the hourly window rolls over', () => {
  const rl = new RateLimiter({ perIpPerHour: 1, globalPerDay: 100, hourMs: 1000 });
  assert.equal(rl.take('k', 0).allowed, true);
  assert.equal(rl.take('k', 500).allowed, false, 'still inside the window');
  assert.equal(rl.take('k', 1500).allowed, true, 'next window starts fresh');
});

test('the global cap stops everyone, however many addresses they use', () => {
  const rl = new RateLimiter({ perIpPerHour: 100, globalPerDay: 3 });
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(rl.take(`sock:10.0.0.${i}`, now).allowed, true);
  const d = rl.take('sock:10.0.0.99', now);
  assert.equal(d.allowed, false);
  assert.equal(d.allowed === false && d.reason, 'global', 'a fresh address must not get past the daily cap');
});

test('the daily window rolls over too', () => {
  const rl = new RateLimiter({ perIpPerHour: 100, globalPerDay: 1, dayMs: 1000 });
  assert.equal(rl.take('a', 0).allowed, true);
  assert.equal(rl.take('b', 100).allowed, false);
  assert.equal(rl.take('b', 1100).allowed, true);
});

test('a refusal does not consume allowance', () => {
  const rl = new RateLimiter({ perIpPerHour: 1, globalPerDay: 10 });
  rl.take('k', 0);
  assert.equal(rl.globalUsed, 1);
  rl.take('k', 0);
  rl.take('k', 0);
  assert.equal(rl.globalUsed, 1, 'refused attempts must not eat the global budget');
});

test('the global cap is checked before the per-IP one', () => {
  // Otherwise a caller with allowance left would be told "per_ip" when the real
  // reason is that the demo is out of budget for the day.
  const rl = new RateLimiter({ perIpPerHour: 5, globalPerDay: 1 });
  rl.take('a', 0);
  const d = rl.take('b', 0);
  assert.equal(d.allowed === false && d.reason, 'global');
});

test('the key comes from Cloudflare or the socket, never a forgeable header', () => {
  assert.equal(clientKey(headers({ 'cf-connecting-ip': '9.9.9.9' }), '10.0.0.1'), 'cf:9.9.9.9');
  assert.equal(clientKey(headers(), '10.0.0.1'), 'sock:10.0.0.1');
  assert.equal(clientKey(headers(), undefined), 'unknown');
  assert.equal(clientKey(headers({ 'cf-connecting-ip': '  ' }), '10.0.0.1'), 'sock:10.0.0.1', 'blank cf header falls through');
});

test('X-Forwarded-For is ignored, because a client can write anything there', () => {
  const forged = headers({ 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2', 'true-client-ip': '3.3.3.3' });
  assert.equal(clientKey(forged, '10.0.0.1'), 'sock:10.0.0.1');
});

test('rotating a forged header cannot buy more allowance', () => {
  const rl = new RateLimiter({ perIpPerHour: 2, globalPerDay: 100 });
  const attempt = (xff: string) => rl.take(clientKey(headers({ 'x-forwarded-for': xff }), '10.0.0.7'), 0);
  assert.equal(attempt('1.1.1.1').allowed, true);
  assert.equal(attempt('2.2.2.2').allowed, true);
  assert.equal(attempt('3.3.3.3').allowed, false, 'all three charged the same socket');
});

test('bucket memory is swept rather than grown without bound', () => {
  const rl = new RateLimiter({ perIpPerHour: 1, globalPerDay: 1_000_000, hourMs: 1000 });
  for (let i = 0; i < 10_050; i++) rl.take(`k${i}`, 0);
  assert.ok(rl.trackedKeys >= 10_000, 'the first window accumulates');
  rl.take('next-window', 5000);
  assert.ok(rl.trackedKeys < 100, `stale buckets must be dropped, still holding ${rl.trackedKeys}`);
});
