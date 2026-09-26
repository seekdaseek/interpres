import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, worthFallingBack, classifyError, McpError } from '../src/mcp.ts';
import { SsrfError } from '../src/ssrf.ts';
import { reasonFor } from '../../../scripts/sweep.ts';

const netErr = (code: string, msg = code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(msg), { code }) });

test('describeError surfaces the cause chain undici hides behind "fetch failed"', () => {
  const d = describeError(netErr('ENOTFOUND', 'getaddrinfo ENOTFOUND nope.example'));
  assert.match(d, /^fetch failed <- getaddrinfo ENOTFOUND nope\.example$/);
  const coded = describeError(Object.assign(new Error('bad cert'), { code: 'CERT_HAS_EXPIRED' }));
  assert.equal(coded, 'bad cert [CERT_HAS_EXPIRED]', 'a code not already in the message is appended');
  assert.equal(describeError('plain string'), 'plain string');
});

test('a dead host is classified from its cause, not as a protocol error', () => {
  assert.equal(classifyError(netErr('ECONNREFUSED')).classification, 'unreachable');
  assert.equal(classifyError(netErr('ENOTFOUND')).classification, 'unreachable');
});

test('falling back to SSE is skipped when it cannot change the outcome', () => {
  // Same host, same missing credential: SSE would fail identically, slower.
  assert.equal(worthFallingBack(new SsrfError('blocked_address', 'x')), false);
  assert.equal(worthFallingBack(new Error('Error POSTing to endpoint (HTTP 401): Unauthorized')), false);
  assert.equal(worthFallingBack(netErr('ENOTFOUND')), false);
  assert.equal(worthFallingBack(netErr('ECONNREFUSED')), false);
  assert.equal(worthFallingBack(new Error('Request timed out')), false);
  assert.equal(worthFallingBack(netErr('CERT_HAS_EXPIRED', 'certificate has expired')), false);
});

test('falling back to SSE is tried when the server may simply be SSE-only', () => {
  // What a legacy SSE server answers to a Streamable HTTP POST.
  assert.equal(worthFallingBack(new Error('Error POSTing to endpoint (HTTP 405): Method Not Allowed')), true);
  assert.equal(worthFallingBack(new Error('Error POSTing to endpoint (HTTP 404): Not Found')), true);
  assert.equal(worthFallingBack(new Error('Unexpected content type: text/html')), true);
});

test('sweep reason codes are stable for the failures seen in the wild', () => {
  assert.equal(reasonFor('auth_required', 'Error POSTing to endpoint (HTTP 401): Unauthorized'), 'http_401');
  assert.equal(reasonFor('auth_required', 'HTTP 403 Forbidden'), 'http_403');
  assert.equal(reasonFor('unreachable', 'fetch failed <- getaddrinfo ENOTFOUND x [ENOTFOUND]'), 'dns');
  assert.equal(reasonFor('unreachable', 'fetch failed <- connect ECONNREFUSED 1.2.3.4:443'), 'refused');
  assert.equal(reasonFor('unreachable', 'Request timed out'), 'timeout');
  assert.equal(reasonFor('unreachable', 'Error POSTing to endpoint (HTTP 404): Not Found'), 'http_404');
  assert.equal(reasonFor('unreachable', 'Error POSTing to endpoint (HTTP 502): Bad Gateway'), 'http_5xx');
  assert.equal(reasonFor('unreachable', 'resolves to 10.0.0.5', 'blocked_address'), 'ssrf_blocked_address');
  assert.equal(reasonFor('protocol_error', 'MCP error -32601: Method not found'), 'jsonrpc_method_not_found');
  assert.equal(reasonFor('protocol_error', 'Unexpected token < in JSON at position 0'), 'not_mcp_response');
});

test('McpError carries its classification and detail', () => {
  const e = new McpError('auth_required', 'HTTP 401');
  assert.equal(e.classification, 'auth_required');
  assert.equal(e.detail, 'HTTP 401');
});
