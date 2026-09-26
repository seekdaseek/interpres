import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactIps, scrub, EventLog, publicEvent } from '../src/logs.ts';

test('redaction removes a known IPv4 address (the positive control)', () => {
  // G1: prove the matcher fires on a real address before trusting a clean log.
  assert.equal(redactIps('client 203.0.113.9 connected'), 'client <ip> connected');
  assert.equal(redactIps('resolves to 10.0.0.5, which is not publicly routable'), 'resolves to <ip>, which is not publicly routable');
  assert.equal(redactIps('https://1.2.3.4/mcp'), 'https://<ip>/mcp');
});

test('redaction removes IPv6 in compressed, full and IPv4-mapped forms', () => {
  for (const addr of ['::1', 'fe80::1', '2606:4700:10::6814:179a', '2001:4860:4860:0:0:0:0:8888', '::ffff:169.254.169.254']) {
    const out = redactIps(`peer ${addr} here`);
    assert.ok(!out.includes(addr), `${addr} survived: ${out}`);
    assert.match(out, /<ip>/);
  }
});

test('clock times, UUIDs and version numbers are left alone', () => {
  // The false positives that would make the log useless if the matcher were loose.
  for (const keep of [
    '2026-09-26T09:32:34.407Z',
    'took 09:32:34',
    'request_id 987f298a-85b7-40dd-b26d-e98e2e0110fe',
    'mcp-protocol-version 2025-06-18',
    'node v24.16.0',
  ]) assert.equal(redactIps(keep), keep, `wrongly redacted: ${keep}`);
});

test('scrub redacts IPs at every depth, in arrays too', () => {
  const out = scrub({
    url: 'https://8.8.8.8/mcp',
    nested: { detail: 'resolves to 192.168.1.20' },
    list: ['a', 'from 10.1.1.1'],
    n: 42,
  });
  const blob = JSON.stringify(out);
  for (const ip of ['8.8.8.8', '192.168.1.20', '10.1.1.1']) assert.ok(!blob.includes(ip), `${ip} survived`);
  assert.equal(out.n, 42, 'numbers pass through');
});

test('keys that can only hold a client address are dropped outright', () => {
  const out = scrub({ ip: '1.1.1.1', clientKey: 'cf:1.1.1.1', remoteAddress: '::1', kept: 'yes' });
  assert.deepEqual(Object.keys(out), ['kept']);
});

test('secret-named keys are still redacted to a length', () => {
  const out = scrub({ apiKey: 'abcdef', authorization: 'Bearer x', token: 't' });
  assert.equal(out.apiKey, '<redacted 6 chars>');
  assert.equal(out.authorization, '<redacted 8 chars>');
});

test('nothing with an IP reaches the file, even when a caller passes one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'interpres-log-'));
  const log = new EventLog(join(dir, 'events.jsonl'));
  await log.write({ at: new Date().toISOString(), kind: 'mcp.connect.failed', url: 'https://10.0.0.5/mcp', detail: 'resolves to 172.16.4.4', ip: '203.0.113.9' });
  const text = await readFile(join(dir, 'events.jsonl'), 'utf8');
  for (const ip of ['10.0.0.5', '172.16.4.4', '203.0.113.9']) assert.ok(!text.includes(ip), `${ip} reached the file`);
  assert.match(text, /<ip>/, 'redaction markers are present, so the line was really written');
});

test('the public view shows a host, never a URL path, a query or an error text', () => {
  const secret = 'hooks_9f8e7d6c5b4a39281706f5e4d3c2b1a0';
  const event = {
    at: '2026-09-26T12:00:00.000Z', kind: 'find_tools' as const,
    url: `https://mcp.zapier.example/api/mcp/s/${secret}/mcp`,
    query: 'check the wallet I pasted', error: `fetch failed for /s/${secret}`,
    revealed: 3, top: ['get_reputation'],
  };
  assert.ok(JSON.stringify(event).includes(secret), 'positive control: the raw event holds the secret');
  const out = publicEvent(event);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(secret), 'the path secret must not survive');
  assert.ok(!text.includes('wallet I pasted'), 'what someone said must not survive');
  assert.equal(out.host, 'mcp.zapier.example');
  assert.equal(out.revealed, 3);
  assert.deepEqual(Object.keys(out).sort(), ['at', 'host', 'kind', 'revealed', 'top']);
});

test('a field nobody listed stays private', () => {
  assert.deepEqual(Object.keys(publicEvent({ at: 'x', kind: 'tool.call', futureField: 'anything' })), ['at', 'kind']);
});
