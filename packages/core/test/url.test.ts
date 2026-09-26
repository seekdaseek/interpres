import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseServerUrl, MAX_URL_CHARS } from '../src/url.ts';

type Expect = { url: string; notes?: string[] } | { code: string };

/**
 * What a person types, and what interpres makes of it. The first four are the
 * inputs a judge's browser and our server refused on Sep 26 (brief E, §0.2).
 */
const TABLE: Array<[string, Expect]> = [
  ['mcp.goji.agency/mcp', { url: 'https://mcp.goji.agency/mcp', notes: ['added_https'] }],
  ['goji.agency', { url: 'https://goji.agency/', notes: ['added_https'] }],
  ['http://mcp.goji.agency/mcp', { url: 'https://mcp.goji.agency/mcp', notes: ['switched_to_https'] }],
  ['  https://mcp.goji.agency/mcp  ', { url: 'https://mcp.goji.agency/mcp', notes: [] }],
  ['" https://mcp.goji.agency/mcp "', { url: 'https://mcp.goji.agency/mcp', notes: ['cleaned'] }],
  // Looks like goji, is loopback: the part before @ is a user name.
  ['mcp.goji.agency@127.0.0.1', { code: 'has_credentials' }],
  // Well-formed, so it passes here; the SSRF guard refuses it next (ssrf.test.ts, api.test.ts).
  ['https://[::1]/mcp', { url: 'https://[::1]/mcp', notes: [] }],
  ['javascript:alert(1)', { code: 'bad_scheme' }],
  ['file:///etc/passwd', { code: 'bad_scheme' }],
  ['bücher.example/mcp', { url: 'https://xn--bcher-kva.example/mcp', notes: ['added_https'] }],
  ['https://api.example.com/mcp?profile=public&v=2', { url: 'https://api.example.com/mcp?profile=public&v=2', notes: [] }],
  ['https://tandem.ac/mcp/', { url: 'https://tandem.ac/mcp/', notes: [] }],
  ['<https://mcp.goji.agency/mcp>', { url: 'https://mcp.goji.agency/mcp', notes: ['cleaned'] }],
  ['`afg.ai/mcp`', { url: 'https://afg.ai/mcp', notes: ['cleaned', 'added_https'] }],
  ['“https://tandem.ac/mcp”', { url: 'https://tandem.ac/mcp', notes: ['cleaned'] }],
  ['https://afg.ai/mcp.', { url: 'https://afg.ai/mcp', notes: ['cleaned'] }],
  ['https://afg.ai/mcp),', { url: 'https://afg.ai/mcp', notes: ['cleaned'] }],
  ['HTTPS://Mcp.Goji.AGENCY/mcp', { url: 'https://mcp.goji.agency/mcp', notes: [] }],
  ['goji.agency:443/mcp', { url: 'https://goji.agency/mcp', notes: ['added_https'] }],
  ['//mcp.goji.agency/mcp', { url: 'https://mcp.goji.agency/mcp', notes: ['added_https'] }],
  ['https://mcp.goji.agency/mcp#tools', { url: 'https://mcp.goji.agency/mcp', notes: [] }],
  ['http:mcp.goji.agency/mcp', { url: 'https://mcp.goji.agency/mcp', notes: ['switched_to_https'] }],
  ['ftp://example.com/mcp', { code: 'bad_scheme' }],
  ['data:text/html,<b>hi</b>', { code: 'bad_scheme' }],
  ['wss://example.com/mcp', { code: 'bad_scheme' }],
  ['mailto:someone@example.com', { code: 'bad_scheme' }],
  ['user:pass@mcp.goji.agency/mcp', { code: 'has_credentials' }],
  ['https://user:pass@mcp.goji.agency/mcp', { code: 'has_credentials' }],
  ['books', { code: 'not_a_url' }],
  ['https://', { code: 'not_a_url' }],
  ['mcp goji agency', { code: 'not_a_url' }],
  ['', { code: 'empty' }],
  ['  " "  ', { code: 'empty' }],
];

test('the input table: at least 20 rows, each mapped to its URL or its error code', () => {
  assert.ok(TABLE.length >= 20);
  for (const [input, want] of TABLE) {
    const got = normaliseServerUrl(input);
    if ('code' in want) {
      assert.equal(got.ok, false, `${JSON.stringify(input)} should fail`);
      if (!got.ok) {
        assert.equal(got.code, want.code, `${JSON.stringify(input)}`);
        assert.ok(got.message.length > 10, 'every refusal says why');
      }
    } else {
      assert.equal(got.ok, true, `${JSON.stringify(input)} should pass, got ${JSON.stringify(got)}`);
      if (got.ok) {
        assert.equal(got.url, want.url, `${JSON.stringify(input)}`);
        if (want.notes) assert.deepEqual(got.notes, want.notes, `${JSON.stringify(input)} notes`);
      }
    }
  }
});

test('an accepted URL is a fixed point: normalising it again changes nothing', () => {
  for (const [input] of TABLE) {
    const once = normaliseServerUrl(input);
    if (!once.ok) continue;
    const twice = normaliseServerUrl(once.url);
    assert.deepEqual(twice, { ok: true, url: once.url, notes: [] }, `${JSON.stringify(input)}`);
  }
});

test('every refused scheme names itself, so the page can say what was wrong', () => {
  const r = normaliseServerUrl('javascript:alert(1)');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /^javascript: /);
});

test('the credentials refusal says interpres never sends credentials', () => {
  const r = normaliseServerUrl('mcp.goji.agency@127.0.0.1');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /interpres never sends credentials/);
});

test('an overlong paste is refused before it is parsed', () => {
  const r = normaliseServerUrl(`https://example.com/${'a'.repeat(MAX_URL_CHARS)}`);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'not_a_url');
});
