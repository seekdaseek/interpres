import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTools, tokenize, stem } from '../src/rank.ts';
import { convertCatalog } from '../src/convert.ts';
import { loadFixture } from './fixtures.ts';

/**
 * A spoken-query set written against three real catalogs. It exists to pin the
 * measured accuracy: `find_tools` reveals nine tools, so recall inside the top
 * nine is the number that decides whether the agent can do the job at all,
 * while top-1 is a quality signal.
 */
const QUERY_SETS: Record<string, Record<string, string>> = {
  'afg-marketplace': {
    'how do I create a wallet': 'afg_create_wallet',
    'I want to post a job': 'afg_post_job',
    'what is my reputation': 'afg_get_reputation',
    'dispute the outcome': 'afg_dispute',
    'sign the contract': 'afg_sign_contract',
    'upload an artifact': 'afg_upload_artifact',
    'fund the escrow': 'afg_fund',
    'appeal the decision': 'afg_appeal',
    'check the status of my job': 'afg_get_job',
    'throw away that wallet': 'afg_discard_wallet',
    'what is this service': 'afg_about',
    'submit my work': 'afg_submit',
  },
  'assemblyai-docs-mcp': {
    'search the documentation for speaker diarization': 'search_assembly_ai',
    'I want to leave feedback on this page': 'submit_feedback',
  },
  'advisorsai-service-navigator': {
    'list the available services': 'advisors_catalog_list_services',
    'tell me about that one service': 'advisors_catalog_get_service',
    'match a service to what I need': 'advisors_catalog_match_service',
    'check the basics of my site': 'advisors_site_check_basics',
    'prepare an order link': 'advisors_order_prepare_link',
  },
};

function evaluate() {
  let top1 = 0, recall9 = 0, total = 0;
  const misses: string[] = [];
  for (const [fixture, cases] of Object.entries(QUERY_SETS)) {
    const catalog = convertCatalog(loadFixture(fixture).tools).converted;
    for (const [query, want] of Object.entries(cases)) {
      total++;
      const ranked = rankTools(catalog, query);
      if (ranked[0]?.tool.report.mcpName === want) top1++;
      else misses.push(`${query} -> ${ranked[0]?.tool.report.mcpName} (want ${want})`);
      if (ranked.slice(0, 9).some((r) => r.tool.report.mcpName === want)) recall9++;
    }
  }
  return { top1, recall9, total, misses };
}

test('every intended tool is inside the nine that find_tools reveals', () => {
  const { recall9, total } = evaluate();
  assert.equal(recall9, total, `recall@9 must be perfect, got ${recall9}/${total}`);
});

test('top-1 accuracy holds at the measured level', () => {
  const { top1, total, misses } = evaluate();
  // Measured 17/19 on 2026-09-26. Both misses are synonym gaps a keyword
  // ranker cannot close ("throw away" for discard, "tell me about" for get).
  assert.ok(top1 / total >= 0.85, `top-1 fell to ${top1}/${total}: ${misses.join(' | ')}`);
  assert.ok(top1 <= total, 'sanity');
});

test('ranking is deterministic and does not depend on catalog order', () => {
  const tools = loadFixture('afg-marketplace').tools;
  const a = rankTools(convertCatalog(tools).converted, 'post a job');
  const b = rankTools(convertCatalog([...tools].reverse()).converted, 'post a job');
  assert.deepEqual(a.map((r) => r.tool.report.mcpName), b.map((r) => r.tool.report.mcpName));
});

test('a precise name match beats a description that merely mentions the word', () => {
  const catalog = convertCatalog([
    { name: 'dispute_job', description: 'Raise a dispute.' },
    { name: 'get_reputation', description: 'Counts of jobs, released, refunded, disputed, disputes won, and the outcome rate.' },
  ]).converted;
  assert.equal(rankTools(catalog, 'dispute the outcome')[0]!.tool.report.mcpName, 'dispute_job');
});

test('an empty query returns the whole catalog rather than nothing', () => {
  const catalog = convertCatalog(loadFixture('afg-marketplace').tools).converted;
  assert.equal(rankTools(catalog, '').length, catalog.length);
  assert.equal(rankTools(catalog, 'the and of').length, catalog.length, 'stopwords only is still empty');
});

test('an empty catalog ranks to nothing without throwing', () => {
  assert.deepEqual(rankTools([], 'anything'), []);
});

test('stopwords and short tokens are dropped', () => {
  assert.deepEqual(tokenize('I want to know the status of my order'), ['know', 'status', 'order']);
});

test('the stemmer keeps a word family together', () => {
  assert.equal(stem('dispute'), stem('disputed'));
  assert.equal(stem('dispute'), stem('disputes'));
  assert.equal(stem('service'), stem('services'));
  assert.equal(stem('query'), stem('queries'));
});
