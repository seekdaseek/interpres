import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectPaymentRequired, isPaidDescription, paidSentence, priceFromAccepts, priceFromDescription } from '../src/paid.ts';
import { starterTools, readOnlyTools } from '../src/starters.ts';
import { loadFixture } from './fixtures.ts';

/** Real results from x402.ochinimus.app, captured Sep 26 (packages/core/test/results). */
const result = (name: string) => JSON.parse(readFileSync(new URL(`./results/${name}.json`, import.meta.url), 'utf8')).result;
const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

test('a real x402 payment request is detected, with the price from its accepts', () => {
  assert.deepEqual(detectPaymentRequired(result('agentfeed-get-sol-price-402')), { price: '0.001 USDC' });
  assert.deepEqual(detectPaymentRequired(result('agentfeed-get-exit-quote-402')), { price: '0.02 USDC' });
});

test('the request is found in the text part alone, and a cut-short one still counts', () => {
  const r = result('agentfeed-get-sol-price-402');
  const textOnly = { isError: true, content: r.content };
  assert.deepEqual(detectPaymentRequired(textOnly), { price: '0.001 USDC' });
  // What the old shaper handed the agent: the first 321 characters, no longer valid JSON.
  const cut = { isError: true, content: [{ type: 'text', text: r.content[0].text.slice(0, 321) }] };
  assert.deepEqual(detectPaymentRequired(cut), {});
});

test('an HTTP 402 is a payment request even without a body', () => {
  assert.deepEqual(detectPaymentRequired(undefined, { httpStatus: 402 }), {});
  assert.equal(detectPaymentRequired(undefined, { httpStatus: 401 }), null);
});

test('results that are not payment requests stay results', () => {
  // A real isError from the same server: a validation failure, not a price.
  assert.equal(detectPaymentRequired(result('agentfeed-validation-error')), null);
  // Mentions USDC and even money, but is data.
  const balance = { content: [{ type: 'text', text: JSON.stringify({ wallet: 'x', token: 'USDC', balance: '12.5', note: 'costs 0.001 USDC per transfer' }) }] };
  assert.equal(detectPaymentRequired(balance), null);
  assert.equal(detectPaymentRequired({ structuredContent: { asset: SOL, amount: '1000' } }), null);
  // Says "payment required" but not in the x402 shape.
  assert.equal(detectPaymentRequired({ isError: true, content: [{ type: 'text', text: '{"error":"Payment required"}' }] }), null);
  assert.equal(detectPaymentRequired({ isError: true, content: [{ type: 'text', text: 'rate limited' }] }), null);
  // x402Version alone, with nothing asked for.
  assert.equal(detectPaymentRequired({ structuredContent: { x402Version: 2, note: 'we support x402' } }), null);
});

test('prices from accepts: v2 amount, v1 maxAmountRequired, known USDC or stated decimals', () => {
  assert.equal(priceFromAccepts([{ amount: '1000', asset: SOL }]), '0.001 USDC');
  assert.equal(priceFromAccepts([{ amount: '20000', asset: BASE.toLowerCase() }]), '0.02 USDC');
  assert.equal(priceFromAccepts([{ maxAmountRequired: '10000', asset: BASE }]), '0.01 USDC');
  assert.equal(priceFromAccepts([{ amount: '1500000', asset: BASE }]), '1.5 USDC');
  assert.equal(priceFromAccepts([{ amount: '500000', asset: 'eurc-mint', extra: { decimals: 6, name: 'EURC' } }]), '0.5 EURC');
  // Unknown asset and no decimals: no guess.
  assert.equal(priceFromAccepts([{ amount: '1000', asset: 'mystery' }]), undefined);
  assert.equal(priceFromAccepts([{ amount: '1e3', asset: SOL }]), undefined);
  assert.equal(priceFromAccepts('nope'), undefined);
  // The first entry that can be read wins.
  assert.equal(priceFromAccepts([{ amount: '1', asset: 'mystery' }, { amount: '1000', asset: SOL }]), '0.001 USDC');
});

test('prices from descriptions, and only stated prices', () => {
  assert.equal(priceFromDescription('Live SOL/USD. Costs 0.001 USDC per call (x402, USDC on Solana or Base).'), '0.001 USDC');
  assert.equal(priceFromDescription('Quote. 0.25 USDC per call.'), '0.25 USDC');
  assert.equal(priceFromDescription('Costs $0.01 per call.'), '$0.01');
  assert.equal(priceFromDescription('Crypto Fear & Greed index (0-100) with classification. Free.'), undefined);
  assert.equal(priceFromDescription('Returns every agentfeed tool with its USDC price and description. Free.'), undefined);
  assert.equal(priceFromDescription(undefined), undefined);
});

test('a tool is paid only when its description states a USDC price or names x402', () => {
  assert.equal(isPaidDescription('Costs 0.001 USDC per call (x402, USDC on Solana or Base).'), true);
  assert.equal(isPaidDescription('Settles over x402 on Base.'), true);
  assert.equal(isPaidDescription('Returns every agentfeed tool with its USDC price and description. Free.'), false);
  assert.equal(isPaidDescription('USDC depeg monitor for Solana stablecoins.'), false);
  assert.equal(isPaidDescription(undefined), false);
});

test('the sentence the agent and the page get', () => {
  assert.equal(paidSentence('0.001 USDC'), "That tool is paid: 0.001 USDC per call over x402. interpres doesn't pay for tools, so try a free one.");
  assert.equal(paidSentence(), "That tool is paid per call over x402. interpres doesn't pay for tools, so try a free one.");
});

test('AgentFeed: 52 tools state a price in their own descriptions, and starters use only the free ones', () => {
  const tools = loadFixture('agentfeed').tools;
  assert.equal(tools.length, 59);
  assert.equal(tools.filter((t) => isPaidDescription(t.description)).length, 52);
  const starters = starterTools(tools).map((t) => t.name);
  assert.ok(starters.length >= 3);
  for (const n of starters) assert.equal(isPaidDescription(tools.find((t) => t.name === n)!.description), false, n);
  assert.ok(starters.includes('get_fear_greed'));
  assert.ok(starters.includes('pricing'), 'mentions USDC, but free');
  // Its price is past the converter's cut, but the full description still counts.
  assert.ok(!starters.includes('get_exit_quote'));
  // A tool that already asked for payment is left out too.
  assert.ok(!starterTools(tools, { paidNames: ['get_fear_greed'] }).map((t) => t.name).includes('get_fear_greed'));
});

test('with fewer than three free tools, starters fall back to every read-only tool', () => {
  const t = (name: string, paid: boolean) => ({ name: `get_${name}`, description: `Returns ${name}.${paid ? ' Costs 0.01 USDC per call.' : ''}`, inputSchema: { type: 'object' as const } });
  const two = [t('a', false), t('b', false), t('c', true), t('d', true)];
  assert.deepEqual(starterTools(two).map((x) => x.name), ['get_a', 'get_b', 'get_c', 'get_d']);
  const three = [...two, t('e', false)];
  assert.deepEqual(starterTools(three).map((x) => x.name), ['get_a', 'get_b', 'get_e']);
  // readOnlyTools keeps its old meaning: every read-only tool.
  assert.equal(readOnlyTools(three).length, 5);
});
