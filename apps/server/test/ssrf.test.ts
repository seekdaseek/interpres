import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublicAddress, unmapIpv4, verifyUrl, SsrfError, enforceResponsePolicy,
  MAX_RESPONSE_BYTES, guardedFetch,
} from '../src/ssrf.ts';

// ------------------------------------------------------- address classification

test('a publicly routable address is allowed', () => {
  // The known-positive control. Without this, "everything is blocked" would
  // look like a passing guard.
  for (const ok of [
    '8.8.8.8', '1.1.1.1', '93.184.215.14', '167.233.69.154',
    '172.15.255.255', '172.32.0.0',        // just outside 172.16.0.0/12
    '100.63.255.255', '100.128.0.0',       // just outside 100.64.0.0/10
    '11.0.0.0', '9.255.255.255',           // just outside 10.0.0.0/8
    '192.167.255.255', '192.169.0.0',      // just outside 192.168.0.0/16
    '169.253.255.255', '169.255.0.0',      // just outside 169.254.0.0/16
    '2606:4700:10::6814:179a', '2001:4860:4860::8888',
  ]) assert.equal(isPublicAddress(ok), true, `${ok} should be allowed`);
});

test('loopback, private, link-local and metadata are blocked', () => {
  for (const bad of [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '169.254.0.1', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '198.18.0.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '192.0.0.1', '192.88.99.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1',
    '2001:db8::1', '64:ff9b::1', '100::1', '2002::1',
  ]) assert.equal(isPublicAddress(bad), false, `${bad} must be blocked`);
});

test('cloud metadata is blocked by every spelling we can think of', () => {
  // 169.254.169.254 is the whole reason this guard exists.
  for (const spelling of ['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe']) {
    assert.equal(isPublicAddress(spelling), false, `${spelling} must be blocked`);
  }
});

test('an IPv4-mapped IPv6 address is judged by the IPv4 rules', () => {
  assert.equal(unmapIpv4('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(unmapIpv4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(unmapIpv4('::127.0.0.1'), '127.0.0.1');
  assert.equal(unmapIpv4('2606:4700::1'), null);
  for (const bad of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.0.1', '::ffff:7f00:1']) {
    assert.equal(isPublicAddress(bad), false, `${bad} must be blocked`);
  }
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true, 'a mapped public address is still public');
});

test('a zone index does not smuggle a link-local address past the check', () => {
  assert.equal(isPublicAddress('fe80::1%eth0'), false);
});

test('nonsense is not treated as public', () => {
  for (const junk of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', 'localhost', '::ffff:999.1.1.1']) {
    assert.equal(isPublicAddress(junk), false, `${junk} must not be allowed`);
  }
});

// -------------------------------------------------------------- URL vetting

const code = async (url: string): Promise<string> => {
  try { await verifyUrl(url); return 'allowed'; } catch (e) { return e instanceof SsrfError ? e.code : 'other'; }
};

test('only https is accepted', async () => {
  assert.equal(await code('http://example.com/mcp'), 'bad_scheme');
  assert.equal(await code('file:///etc/passwd'), 'bad_scheme');
  assert.equal(await code('ftp://example.com/'), 'bad_scheme');
  assert.equal(await code('gopher://example.com/'), 'bad_scheme');
  assert.equal(await code('ws://example.com/'), 'bad_scheme');
  assert.equal(await code('data:text/plain,hi'), 'bad_scheme');
});

test('malformed input is refused before any lookup', async () => {
  assert.equal(await code('not a url'), 'not_a_url');
  assert.equal(await code(''), 'not_a_url');
  assert.equal(await code('https://'), 'not_a_url');
});

test('credentials in the URL are refused, never forwarded', async () => {
  assert.equal(await code('https://user:secret@example.com/mcp'), 'has_credentials');
  assert.equal(await code('https://user@example.com/mcp'), 'has_credentials');
});

test('a literal private address is blocked without touching DNS', async () => {
  for (const url of [
    'https://127.0.0.1/mcp', 'https://127.0.0.1:8080/mcp', 'https://10.0.0.5/mcp',
    'https://192.168.1.1/mcp', 'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/mcp', 'https://[fe80::1]/mcp', 'https://[::ffff:127.0.0.1]/mcp',
  ]) assert.equal(await code(url), 'blocked_address', `${url} must be blocked`);
});

test('a hostname that cannot resolve is refused, not attempted', async () => {
  assert.equal(await code('https://this-host-should-never-exist-interpres.invalid/mcp'), 'dns_failed');
});

test('localhost is blocked through DNS, not only as a literal', async () => {
  // localhost resolves to 127.0.0.1 or ::1, so the resolved-address check is
  // what stops it. Either code is correct depending on the resolver.
  assert.ok(['blocked_address', 'dns_failed'].includes(await code('https://localhost/mcp')));
});

test('a real public MCP URL is allowed and its addresses recorded', async () => {
  const t = await verifyUrl('https://www.assemblyai.com/docs/mcp');
  assert.equal(t.url.protocol, 'https:');
  assert.ok(t.addresses.length > 0, 'resolved addresses must be recorded for pinning');
  for (const a of t.addresses) assert.equal(isPublicAddress(a.address), true);
});

// ------------------------------------------------------------ response policy

const res = (status: number, body: string | null = '', headers: Record<string, string> = {}) =>
  new Response(body === null ? null : body, { status, headers });

test('a redirect is refused rather than followed', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    assert.throws(
      () => enforceResponsePolicy(res(status, null, { location: 'https://169.254.169.254/' }), 'evil.example'),
      (e: unknown) => e instanceof SsrfError && e.code === 'redirect_refused',
      `${status} must be refused`,
    );
  }
});

test('a normal response passes the policy unchanged', async () => {
  const out = enforceResponsePolicy(res(200, 'hello', { 'content-type': 'text/plain' }), 'example.com');
  assert.equal(out.status, 200);
  assert.equal(out.headers.get('content-type'), 'text/plain');
  assert.equal(await out.text(), 'hello');
});

test('a 4xx or 5xx is passed through, since the caller must see it', () => {
  for (const status of [400, 401, 404, 500, 503]) {
    assert.equal(enforceResponsePolicy(res(status, 'x'), 'example.com').status, status);
  }
});

test('an oversized content-length is refused before the body is read', () => {
  assert.throws(
    () => enforceResponsePolicy(res(200, 'x', { 'content-length': String(MAX_RESPONSE_BYTES + 1) }), 'example.com'),
    (e: unknown) => e instanceof SsrfError && e.code === 'too_large',
  );
  assert.doesNotThrow(() => enforceResponsePolicy(res(200, 'x', { 'content-length': String(MAX_RESPONSE_BYTES) }), 'example.com'));
});

test('a body that lies about its length still hits the cap while streaming', async () => {
  // The real defence: a chunked response with no content-length at all.
  const chunk = new Uint8Array(64 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); },   // endless
  });
  const out = enforceResponsePolicy(new Response(stream, { status: 200 }), 'example.com');
  await assert.rejects(
    async () => { await out.arrayBuffer(); },
    (e: unknown) => e instanceof SsrfError && e.code === 'too_large',
  );
});

test('a body just under the cap is delivered whole', async () => {
  const body = new Uint8Array(MAX_RESPONSE_BYTES - 1);
  const out = enforceResponsePolicy(new Response(body, { status: 200 }), 'example.com');
  assert.equal((await out.arrayBuffer()).byteLength, MAX_RESPONSE_BYTES - 1);
});

// ------------------------------------------------------------- guardedFetch

test('guardedFetch refuses a blocked target before opening a socket', async () => {
  for (const url of ['http://example.com/', 'https://127.0.0.1/', 'https://169.254.169.254/']) {
    await assert.rejects(async () => { await guardedFetch(url); }, (e: unknown) => e instanceof SsrfError, url);
  }
});

test('guardedFetch reaches a real public host and enforces the cap', async () => {
  const r = await guardedFetch('https://www.assemblyai.com/docs/llms.txt');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.length > 1000, `expected real content, got ${text.length} bytes`);
  assert.ok(text.length <= MAX_RESPONSE_BYTES);
});
