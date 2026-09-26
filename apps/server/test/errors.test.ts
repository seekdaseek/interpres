import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { MESSAGES, UPSTREAM_FAILED, UrlError, explainFailure, requireServerUrl } from '../src/errors.ts';
import { McpError } from '../src/mcp.ts';
import { SsrfError } from '../src/ssrf.ts';
import { PRESETS } from '../src/presets.ts';

test('upstream MCP failures are 424 with one plain sentence per class', () => {
  const cases: Array<[McpError, string, string]> = [
    [new McpError('auth_required', 'Unauthorized [HTTP 401]'), 'auth', MESSAGES.auth],
    [new McpError('protocol_error', 'Unexpected content type: text/html'), 'not_mcp', MESSAGES.notMcp],
    [new McpError('unreachable', 'Not Found [HTTP 404]'), 'not_mcp', MESSAGES.notMcp],
    [new McpError('unreachable', 'Method Not Allowed [HTTP 405]'), 'not_mcp', MESSAGES.notMcp],
    [new McpError('unreachable', 'fetch failed <- getaddrinfo ENOTFOUND x.example'), 'unreachable', MESSAGES.unreachable],
    [new McpError('unreachable', 'Too Many Requests [HTTP 429]'), 'busy', MESSAGES.busy],
    [new McpError('unreachable', 'Service Unavailable [HTTP 503]'), 'server_error', MESSAGES.serverError(503)],
  ];
  for (const [err, kind, message] of cases) {
    const f = explainFailure(err);
    assert.equal(f.status, UPSTREAM_FAILED, err.detail);
    assert.equal(f.body.kind, kind, err.detail);
    assert.equal(f.body.error, message, err.detail);
    assert.equal(f.body.code, err.classification);
  }
});

test('an upstream body never becomes the sentence: it is kept, clipped, as detail', () => {
  const html = `Streamable HTTP error: Error POSTing to endpoint: <!doctype html>${'<p>x</p>'.repeat(200)}`;
  const f = explainFailure(new McpError('protocol_error', html));
  assert.equal(f.body.error, MESSAGES.notMcp);
  assert.ok(!f.body.error.includes('<'), 'no markup in the sentence');
  assert.ok((f.body.detail ?? '').length <= 301, 'detail is clipped');
});

test('SSRF refusals stay 400 and keep their wording; a timeout is upstream', () => {
  const blocked = explainFailure(new SsrfError('blocked_address', '10.0.0.1 is not a publicly routable address.'));
  assert.deepEqual([blocked.status, blocked.body.error, blocked.body.kind], [400, '10.0.0.1 is not a publicly routable address.', 'blocked']);
  const dns = explainFailure(new SsrfError('dns_failed', 'Could not resolve nothing.invalid.'));
  assert.deepEqual([dns.status, dns.body.error], [400, MESSAGES.unreachable]);
  const slow = explainFailure(new SsrfError('timeout', 'No response within 10000ms.'));
  assert.deepEqual([slow.status, slow.body.error, slow.body.kind], [UPSTREAM_FAILED, MESSAGES.unreachable, 'unreachable']);
  const redirect = explainFailure(new SsrfError('redirect_refused', 'x.example answered 307 and redirects to https://x.example/mcp/; interpres does not follow redirects.'));
  assert.equal(redirect.status, 400);
  assert.match(redirect.body.error, /redirects to https:\/\/x\.example\/mcp\//);
});

test('a URL the normaliser refuses is a 400 with its own message', () => {
  assert.throws(() => requireServerUrl('javascript:alert(1)'), (e: unknown) => e instanceof UrlError && e.code === 'bad_scheme');
  const f = explainFailure(new UrlError('has_credentials', 'interpres never sends credentials.'));
  assert.deepEqual([f.status, f.body.code, f.body.kind], [400, 'has_credentials', 'input']);
  assert.deepEqual(requireServerUrl('mcp.goji.agency/mcp'), { url: 'https://mcp.goji.agency/mcp', notes: ['added_https'] });
});

test('our own bug is a 500, in JSON, with a plain sentence', () => {
  const f = explainFailure(new TypeError('cannot read properties of undefined'));
  assert.deepEqual([f.status, f.body.code, f.body.error], [500, 'internal', MESSAGES.internal]);
});

test('no failure of any kind maps to 502, 503 or 504', () => {
  const errs: unknown[] = [
    new McpError('auth_required', 'x'), new McpError('unreachable', 'x [HTTP 502]'), new McpError('unreachable', 'x [HTTP 504]'),
    new McpError('protocol_error', 'x'), new SsrfError('timeout', 'x'), new SsrfError('too_large', 'x'),
    new UrlError('not_a_url', 'x'), new Error('x'), 'a string',
  ];
  for (const e of errs) assert.ok(![502, 503, 504].includes(explainFailure(e).status), String(e));
});

test('no server source file answers with a 502, 503 or 504 status literal', () => {
  // A status as c.json's second argument, a `status:` field, or a ternary arm.
  const pattern = /\},\s*50[234]\s*[,)]|status\s*[:=]\s*50[234]\b|[?:]\s*50[234]\s*[;,):]/;
  // Known-positive controls: every shape the old code used must be caught.
  for (const old of [
    "return c.json({ error: 'x', code: 'token_upstream' }, 502);",
    'const status = err instanceof SsrfError ? 400 : 502;',
    "return err.code === 'timeout' ? 504 : 400;",
    '{ status: 504, body }',
  ]) assert.match(old, pattern, old);
  // And prose about those statuses is not code.
  assert.doesNotMatch('No route answers 502, 503 or 504; Cloudflare rewrites a 502/504 body.', pattern);
  const dir = 'apps/server/src';
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    assert.doesNotMatch(src, pattern, `${f} answers with a gateway status`);
  }
});

test('every preset URL is already normal, so its cache key and deep link never change', () => {
  for (const p of PRESETS) assert.deepEqual(requireServerUrl(p.url), { url: p.url, notes: [] }, p.label);
});
