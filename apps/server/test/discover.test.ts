import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryCache, discover, domainOf, isSiteRoot, probeUrls } from '../src/discover.ts';
import type { Probe } from '../src/discover.ts';
import type { RegistryServer } from '../src/registry.ts';

const reg = (url: string, tools = 3): RegistryServer => ({ name: `x/${url}`, url, host: new URL(url).host, tools, transport: 'streamable-http' });

/** A probe that answers for the given URLs and records every call. */
function fakeProbe(answers: Record<string, number>, calls: string[] = []): Probe {
  return async (url) => {
    calls.push(url);
    if (url in answers) return { tools: answers[url]! };
    throw new Error('not MCP');
  };
}

test('a site root is a bare domain or a slash; anything after it is not', () => {
  assert.equal(isSiteRoot(new URL('https://goji.agency/')), true);
  assert.equal(isSiteRoot(new URL('https://goji.agency/mcp')), false);
  assert.equal(isSiteRoot(new URL('https://goji.agency/?q=1')), false);
  assert.equal(domainOf(new URL('https://www.goji.agency/')), 'goji.agency');
});

test('the probes: /mcp, /sse, then mcp.<domain>/mcp, and the root itself last', () => {
  assert.deepEqual(probeUrls(new URL('https://example.com/')), [
    'https://example.com/mcp', 'https://example.com/sse', 'https://mcp.example.com/mcp', 'https://example.com/',
  ]);
  assert.deepEqual(probeUrls(new URL('https://mcp.goji.agency/docs')), ['https://mcp.goji.agency/mcp', 'https://mcp.goji.agency/sse'], 'no mcp.mcp., and a path is not the root');
  assert.deepEqual(probeUrls(new URL('https://8.8.8.8/')), ['https://8.8.8.8/mcp', 'https://8.8.8.8/sse', 'https://8.8.8.8/'], 'no mcp. before an IP');
});

test('one registry server that answers is the result, and no probe is made', async () => {
  const calls: string[] = [];
  const d = await discover(new URL('https://goji.agency/'), {
    forDomain: () => [reg('https://mcp.goji.agency/mcp', 9)],
    probe: fakeProbe({ 'https://mcp.goji.agency/mcp': 9 }, calls),
  });
  assert.equal(d.kind, 'one');
  if (d.kind === 'one') {
    assert.equal(d.found.url, 'https://mcp.goji.agency/mcp');
    assert.equal(d.found.source, 'registry');
    assert.equal(d.found.note, 'Found in the official MCP registry');
    assert.equal(d.found.tools, 9);
  }
  assert.deepEqual(calls, ['https://mcp.goji.agency/mcp']);
});

test('several registry servers that answer come back as a pick list of at most five', async () => {
  const urls = Array.from({ length: 7 }, (_, i) => `https://s${i}.big.example/mcp`);
  const d = await discover(new URL('https://big.example/'), {
    forDomain: () => urls.map((u) => reg(u)),
    probe: fakeProbe(Object.fromEntries(urls.map((u, i) => [u, i + 1]))),
  });
  assert.equal(d.kind, 'several');
  if (d.kind === 'several') {
    assert.equal(d.candidates.length, 5);
    assert.deepEqual(d.candidates.map((c) => c.tools), [1, 2, 3, 4, 5]);
  }
});

test('when the registry has nothing live, the probes run in order and stop at the first answer', async () => {
  const calls: string[] = [];
  const d = await discover(new URL('https://tandem.ac/'), {
    forDomain: () => [reg('https://old.tandem.ac/mcp')],
    probe: fakeProbe({ 'https://tandem.ac/sse': 13, 'https://mcp.tandem.ac/mcp': 2 }, calls),
  });
  assert.equal(d.kind, 'one');
  if (d.kind === 'one') {
    assert.equal(d.found.url, 'https://tandem.ac/sse');
    assert.equal(d.found.note, 'Found at /sse');
    assert.equal(d.found.source, 'probe');
  }
  assert.deepEqual(calls, ['https://old.tandem.ac/mcp', 'https://tandem.ac/mcp', 'https://tandem.ac/sse']);
});

test('nothing anywhere: every place tried is listed, and a URL already tried is skipped', async () => {
  const d = await discover(new URL('https://example.com/docs'), { forDomain: () => [], probe: fakeProbe({}) }, { skip: ['https://example.com/mcp'] });
  assert.equal(d.kind, 'none');
  assert.deepEqual(d.tried, ['https://example.com/sse', 'https://mcp.example.com/mcp']);
});

test('a probe that never answers is given up on at the timeout', async () => {
  const started = Date.now();
  const d = await discover(new URL('https://slow.example/'), {
    forDomain: () => [],
    probe: () => new Promise(() => {}),
    timeoutMs: 40,
  });
  assert.equal(d.kind, 'none');
  assert.equal(d.tried.length, 4);
  assert.ok(Date.now() - started < 1000, 'four probes at 40 ms each, not forever');
});

test('the cache keeps a result for its window, then forgets it', () => {
  let now = 0;
  const cache = new DiscoveryCache({ ttlMs: 1000, now: () => now });
  const r = { kind: 'none' as const, domain: 'x', tried: [], ms: 1 };
  cache.set('x|root', r);
  now = 999;
  assert.equal(cache.get('x|root'), r);
  now = 1000;
  assert.equal(cache.get('x|root'), undefined);
});
