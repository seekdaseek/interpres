import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, worthFallingBack, classifyError, httpStatus, McpError } from '../src/mcp.ts';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

// The SDK's real error shape: status on `code`, only the body in the message.
const sdkErr = (status: number, body: string) => new StreamableHTTPError(status, `Error POSTing to endpoint: ${body}`);

test('the SDK status survives describeError; a -1 "not MCP" code adds nothing', () => {
  assert.match(describeError(sdkErr(403, '<html>')), /\[HTTP 403\]$/);
  assert.equal(httpStatus(describeError(sdkErr(503, ''))), 503);
  assert.equal(httpStatus(describeError(new StreamableHTTPError(-1, 'Unexpected content type: text/html'))), null);
});

test('numbers inside a response body never decide the class (seen in the Sep 26 sweep)', () => {
  const css = sdkErr(400, '<html><style>h1{font-weight:500;margin:401px}</style></html>');
  assert.equal(classifyError(css).classification, 'protocol_error', 'a 400 whose body holds 500 and 401 is still a 400');
  assert.equal(reasonFor('protocol_error', describeError(css)), 'http_400');
  const challenge = sdkErr(403, '<!DOCTYPE html><title>Just a moment...</title><style>b{font-weight:500}</style>');
  assert.equal(classifyError(challenge).classification, 'auth_required');
  assert.equal(reasonFor('auth_required', describeError(challenge)), 'http_403');
  const down = sdkErr(503, '<title>Azure Container App - Unavailable</title>');
  assert.equal(classifyError(down).classification, 'unreachable');
  assert.equal(reasonFor('unreachable', describeError(down)), 'http_5xx');
  const empty = sdkErr(404, '');
  assert.equal(classifyError(empty).classification, 'unreachable');
  assert.equal(reasonFor('unreachable', describeError(empty)), 'http_404');
});

test('an auth wall sent with the wrong status is still an auth wall; a payment wall counts as one', () => {
  for (const body of ['{"message":"Unauthenticated."}', '{"error":"Missing Authorization header"}', 'no bearer token']) {
    assert.equal(classifyError(sdkErr(400, body)).classification, 'auth_required', body);
  }
  const pay = sdkErr(402, '{"x402Version":1}');
  assert.equal(classifyError(pay).classification, 'auth_required');
  assert.equal(reasonFor('auth_required', describeError(pay)), 'http_402');
  assert.equal(classifyError(sdkErr(429, 'slow down')).classification, 'unreachable');
});

test('an SSE-only server still gets its fallback under the real SDK error format', () => {
  assert.equal(worthFallingBack(sdkErr(405, '')), true);
  assert.equal(worthFallingBack(sdkErr(404, 'Not Found')), true);
  assert.equal(worthFallingBack(new StreamableHTTPError(-1, 'Unexpected content type: text/html')), true);
  assert.equal(worthFallingBack(sdkErr(401, '')), false);
});
