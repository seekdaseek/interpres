import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBody, noDetailsMessage } from '../src/http.ts';

// The first bytes Cloudflare sent in place of our 502 JSON (data/public-matrix-before.json).
const CLOUDFLARE_PAGE = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->';

test('an HTML error page becomes a plain sentence with the status, never a parser message', () => {
  // The control: parsing it directly gives exactly the message a judge saw.
  assert.throws(() => JSON.parse(CLOUDFLARE_PAGE), /Unexpected token '<'/);
  const r = readBody(502, false, CLOUDFLARE_PAGE);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.message, 'interpres answered 502 without any details. Try again in a moment.');
    assert.doesNotMatch(r.message, /Unexpected token|JSON|DOCTYPE/);
  }
});

test("our JSON failure is shown in the server's own words, with its code and detail", () => {
  const r = readBody(424, false, JSON.stringify({ error: 'That address answered, but not as an MCP server.', code: 'protocol_error', kind: 'not_mcp', detail: 'raw' }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual([r.message, r.code, r.kind, r.detail], ['That address answered, but not as an MCP server.', 'protocol_error', 'not_mcp', 'raw']);
});

test('a success is passed through', () => {
  const r = readBody<{ presets: unknown[] }>(200, true, '{"presets":[]}');
  assert.deepEqual(r, { ok: true, status: 200, data: { presets: [] } });
});

test('an empty body, a bare string and no answer at all each get a sentence', () => {
  for (const [status, text] of [[500, ''], [200, '"hello"'], [404, 'null']] as const) {
    const r = readBody(status, status < 400, text);
    assert.equal(r.ok, false, `${status} ${text}`);
    if (!r.ok) assert.equal(r.message, noDetailsMessage(status));
  }
  assert.match(noDetailsMessage(0), /Couldn't reach interpres/);
});
