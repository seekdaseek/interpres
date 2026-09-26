/**
 * Paid tools. Some MCP servers charge per call over x402: a tool that has not
 * been paid for answers with a payment-required result instead of data.
 * interpres never pays, so that result becomes one plain sentence the agent can
 * say and the page can show - never the raw x402 JSON.
 *
 * AgentFeed (x402.ochinimus.app, 59 tools, found by typing `ochinimus.app`) is
 * the case this was measured on, Sep 26: a paid tool returns `isError` with the
 * x402 v2 object as its text and as `structuredContent`.
 */

/** A result, or HTTP answer, that asks for payment. `price` when it could be read. */
export type PaymentRequired = { price?: string };

/**
 * USDC, six decimals. Only the two mints seen in real payment requests
 * (test/results, AgentFeed, Sep 26), copied from them: a set typed from memory
 * had a wrong letter in the Solana mint. Any other asset needs `extra.decimals`,
 * or the price comes from the tool's description instead.
 */
const USDC_ASSETS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // Solana mainnet
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',     // Base
].map((a) => a.toLowerCase()));
const USDC_DECIMALS = 6;

/** 0.00100 -> "0.001": no float noise, no trailing zeros. */
function formatUnits(atomic: string, decimals: number): string | undefined {
  if (!/^\d+$/.test(atomic) || decimals < 0 || decimals > 36) return undefined;
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '');
  const frac = decimals > 0 ? padded.slice(padded.length - decimals).replace(/0+$/, '') : '';
  return frac === '' ? whole : `${whole}.${frac}`;
}

type Accept = { amount?: unknown; maxAmountRequired?: unknown; asset?: unknown; extra?: { decimals?: unknown; name?: unknown } };

/**
 * The price an x402 `accepts` list asks, as "0.001 USDC". x402 v2 calls it
 * `amount`, v1 `maxAmountRequired`; both are atomic units of `asset`. The
 * first entry whose asset and decimals are known wins.
 */
export function priceFromAccepts(accepts: unknown): string | undefined {
  if (!Array.isArray(accepts)) return undefined;
  for (const a of accepts as Accept[]) {
    if (a === null || typeof a !== 'object') continue;
    const atomic = typeof a.amount === 'string' || typeof a.amount === 'number' ? String(a.amount)
      : typeof a.maxAmountRequired === 'string' || typeof a.maxAmountRequired === 'number' ? String(a.maxAmountRequired) : undefined;
    if (atomic === undefined) continue;
    const isUsdc = typeof a.asset === 'string' && USDC_ASSETS.has(a.asset.toLowerCase());
    const decimals = typeof a.extra?.decimals === 'number' ? a.extra.decimals : isUsdc ? USDC_DECIMALS : undefined;
    if (decimals === undefined) continue;
    const value = formatUnits(atomic, decimals);
    if (value === undefined) continue;
    const unit = isUsdc ? 'USDC' : typeof a.extra?.name === 'string' && a.extra.name.trim() !== '' ? a.extra.name.trim() : undefined;
    if (unit === undefined) continue;
    return `${value} ${unit}`;
  }
  return undefined;
}

const PRICE_USDC = /\bcosts?\s+\$?(\d+(?:\.\d+)?)\s*USDC\b|(\d+(?:\.\d+)?)\s*USDC\s+(?:per|a|\/)\s*(?:call|request)\b/i;
const PRICE_DOLLARS = /\bcosts?\s+\$(\d+(?:\.\d+)?)\b|\$(\d+(?:\.\d+)?)\s+(?:per|a|\/)\s*(?:call|request)\b/i;

/** The per-call price a tool's description states: "Costs 0.001 USDC per call" -> "0.001 USDC". */
export function priceFromDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const u = description.match(PRICE_USDC);
  if (u) return `${u[1] ?? u[2]} USDC`;
  const d = description.match(PRICE_DOLLARS);
  if (d) return `$${d[1] ?? d[2]}`;
  return undefined;
}

/**
 * Does the description say the tool is paid? Only a stated per-call price in
 * USDC, or the word x402, counts: "returns every tool with its USDC price" is
 * AgentFeed's free price list, not a paid tool.
 */
export function isPaidDescription(description: string | undefined): boolean {
  if (!description) return false;
  return PRICE_USDC.test(description) || /\bx402\b/i.test(description);
}

type X402 = { x402Version?: unknown; error?: unknown; accepts?: unknown };

function asX402(value: unknown): PaymentRequired | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as X402;
  if (typeof v.x402Version !== 'number') return null;
  const asksPayment = (typeof v.error === 'string' && /payment/i.test(v.error)) || (Array.isArray(v.accepts) && v.accepts.length > 0);
  if (!asksPayment) return null;
  const price = priceFromAccepts(v.accepts);
  return price ? { price } : {};
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Is this tool result a payment request? The x402 shape - `x402Version` with a
 * payment error or an `accepts` list - in `structuredContent` or in a text
 * part, or an HTTP 402. A result that merely mentions USDC is not one.
 */
export function detectPaymentRequired(result: unknown, opts: { httpStatus?: number } = {}): PaymentRequired | null {
  const r = (result ?? {}) as { structuredContent?: unknown; content?: unknown };
  const direct = asX402(result) ?? asX402(r.structuredContent);
  if (direct) return direct;
  if (Array.isArray(r.content)) {
    for (const part of r.content as Array<{ type?: unknown; text?: unknown }>) {
      if (typeof part?.text !== 'string') continue;
      const found = asX402(parseJson(part.text));
      if (found) return found;
      // Cut short by a size limit, the JSON no longer parses; its opening still says it all.
      if (/^\s*\{\s*"x402Version"\s*:\s*\d+/.test(part.text) && /payment required/i.test(part.text)) return {};
    }
  }
  if (typeof result === 'string') {
    const found = asX402(parseJson(result));
    if (found) return found;
  }
  return opts.httpStatus === 402 ? {} : null;
}

/** What the agent says and the page shows for a paid tool. */
export function paidSentence(price?: string): string {
  const head = price ? `That tool is paid: ${price} per call over x402.` : 'That tool is paid per call over x402.';
  return `${head} interpres doesn't pay for tools, so try a free one.`;
}
