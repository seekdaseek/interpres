import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, verifyUrl, guardedFetch, MAX_RESPONSE_BYTES } from '../src/ssrf.ts';

// LIVE: these resolve and fetch real public hosts. Run with `npm run test:live`.

test('a real public MCP URL is allowed and its addresses recorded', async () => {
  const t = await verifyUrl('https://www.assemblyai.com/docs/mcp');
  assert.equal(t.url.protocol, 'https:');
  assert.ok(t.addresses.length > 0, 'resolved addresses must be recorded for pinning');
  for (const a of t.addresses) assert.equal(isPublicAddress(a.address), true);
});

test('guardedFetch reaches a real public host and enforces the cap', async () => {
  const r = await guardedFetch('https://www.assemblyai.com/docs/llms.txt');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.length > 1000, `expected real content, got ${text.length} bytes`);
  assert.ok(text.length <= MAX_RESPONSE_BYTES);
});
