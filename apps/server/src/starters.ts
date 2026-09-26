/**
 * Starter questions at connect time: the LLM Gateway writes three, off the
 * speech path, and templates stand in when it cannot. The Gateway breaker is
 * the shaper's own: a 429 is the account's, whichever feature earned it.
 */
import type { StarterTool } from '@interpres/core';
import { STARTER_SYSTEM_PROMPT, buildStarterPrompt, parseStarters, starterTools, templateStarters } from '@interpres/core';
import type { Catalog } from './catalog.ts';
import type { CircuitBreaker } from './shaper.ts';
import { config } from './config.ts';

/** Nothing is speaking yet, so it can wait longer than a shaped result may. */
export const STARTERS_TIMEOUT_MS = 4_000;

export type Starters = {
  source: 'gateway' | 'template';
  questions: string[];
  ms: number;
  model?: string;
  /** Why the templates were used. */
  reason?: string;
};

/**
 * The tools starters are written from: read-only, and free when at least three
 * are (see core's starterTools). `paidNames` are the MCP names that have
 * already answered with a payment request.
 */
export function catalogTools(catalog: Catalog, paidNames: Iterable<string> = []): StarterTool[] {
  return starterTools(catalog.conversion.converted.map((c) => c.source).filter((s): s is NonNullable<typeof s> => s !== undefined), { paidNames });
}

export async function writeStarters(
  catalog: Catalog,
  opts: { breaker: CircuitBreaker; apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number; paidNames?: Iterable<string> },
): Promise<Starters> {
  const started = Date.now();
  const tools = catalogTools(catalog, opts.paidNames);
  const template = (reason: string): Starters => ({ source: 'template', questions: templateStarters(tools), ms: Date.now() - started, reason });
  if (tools.length === 0) return template('no_read_only_tools');
  if (opts.breaker.isOpen()) return template('breaker_open');

  const apiKey = opts.apiKey ?? config.assemblyAiKey;
  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? STARTERS_TIMEOUT_MS);
  try {
    const res = await doFetch(config.llmGateway, {
      method: 'POST',
      signal: ac.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.shaperModel,
        max_tokens: 200,
        temperature: 0.3,
        messages: [
          { role: 'system', content: STARTER_SYSTEM_PROMPT },
          { role: 'user', content: buildStarterPrompt(catalog.server?.title ?? catalog.server?.name ?? new URL(catalog.url).host, catalog.instructions, tools) },
        ],
      }),
    });
    if (res.status === 429) {
      opts.breaker.trip();
      return template('rate_limited');
    }
    if (!res.ok) return template(`gateway_${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const questions = parseStarters(body.choices?.[0]?.message?.content ?? '');
    if (questions === null) return template('unusable_output');
    return { source: 'gateway', questions, ms: Date.now() - started, model: config.shaperModel };
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return template(aborted ? 'timeout' : 'gateway_error');
  } finally {
    clearTimeout(timer);
  }
}
