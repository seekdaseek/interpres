/**
 * The Gateway refinement: an optional second pass over a result the local
 * extractive shaper has already made speakable.
 *
 * AssemblyAI's LLM Gateway, OpenAI-compatible, same API key as the Voice Agent
 * API. Two measured facts decide how it is used:
 *
 *   - this account reaches exactly one model, `qwen3.5-4b-32k-fast`; every other
 *     id answers `400 "Your account does not have access to this LLM Gateway
 *     model"`
 *   - that model answers `429 "too many requests for this action"` under any
 *     load: 4 refusals in 6 sequential calls on 2026-09-26
 *
 * So speech never waits on it. `packages/core` computes the local answer first
 * and gives this call `REFINE_DEADLINE_MS` (1.5 s) to beat it. After any 429 the
 * breaker opens and the Gateway is not asked at all for 60 seconds.
 */
import type { Shaper } from '@interpres/core';
import { SHAPER_SYSTEM_PROMPT, buildShaperUserPrompt, REFINE_DEADLINE_MS } from '@interpres/core';
import { config } from './config.ts';

export const BREAKER_OPEN_MS = 60_000;

/** Opens on a 429 and stays open for a fixed window. Nothing cleverer is needed. */
export class CircuitBreaker {
  readonly openMs: number;
  private openUntil = 0;
  trips = 0;

  constructor(openMs: number = BREAKER_OPEN_MS) {
    this.openMs = openMs;
  }

  isOpen(now: number = Date.now()): boolean {
    return now < this.openUntil;
  }

  trip(now: number = Date.now()): void {
    this.openUntil = now + this.openMs;
    this.trips++;
  }

  /** Seconds until the Gateway is tried again; 0 when closed. */
  secondsLeft(now: number = Date.now()): number {
    return Math.max(0, Math.ceil((this.openUntil - now) / 1000));
  }
}

export type ShaperStats = {
  calls: number;
  used: number;
  failures: number;
  rateLimited: number;
  timeouts: number;
  totalMs: number;
  /** Last failure, so a silent fallback is diagnosable from /api/status. */
  lastError?: string;
  lastErrorAt?: string;
};

export function newShaperStats(): ShaperStats {
  return { calls: 0, used: 0, failures: 0, rateLimited: 0, timeouts: 0, totalMs: 0 };
}

export function makeShaper(opts: {
  stats: ShaperStats;
  breaker: CircuitBreaker;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Shaper {
  const { stats, breaker } = opts;
  const apiKey = opts.apiKey ?? config.assemblyAiKey;
  const doFetch = opts.fetchImpl ?? fetch;
  // The same budget core races against, so the socket is released when the
  // race is lost rather than left to finish on its own.
  const timeoutMs = opts.timeoutMs ?? REFINE_DEADLINE_MS;

  return async ({ text, question, toolName, maxChars }) => {
    const started = Date.now();
    stats.calls++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(config.llmGateway, {
        method: 'POST',
        signal: ac.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.shaperModel,
          max_tokens: 300,
          temperature: 0,
          messages: [
            { role: 'system', content: SHAPER_SYSTEM_PROMPT },
            { role: 'user', content: buildShaperUserPrompt(toolName, clip(text, 12_000), question) },
          ],
        }),
      });
      if (res.status === 429) {
        // One refusal is enough: the next minute of calls would only queue up
        // more refusals, each spending some of a waiting turn's budget.
        breaker.trip();
        stats.rateLimited++;
        throw new Error('llm gateway 429: rate limited; breaker open');
      }
      if (!res.ok) {
        // The body names the reason - a gated model, a bad request.
        const detail = await res.text().catch(() => '');
        throw new Error(`llm gateway ${res.status}: ${detail.slice(0, 200)}`);
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content ?? '';
      if (content.trim() === '') throw new Error('llm gateway returned an empty completion');
      stats.used++;
      return content.trim().slice(0, maxChars * 2);
    } catch (err) {
      stats.failures++;
      const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      if (aborted) stats.timeouts++;
      stats.lastError = aborted ? `timeout after ${Date.now() - started}ms` : err instanceof Error ? err.message : String(err);
      stats.lastErrorAt = new Date().toISOString();
      throw err;
    } finally {
      stats.totalMs += Date.now() - started;
      clearTimeout(timer);
    }
  };
}

/** Keep a pathological tool result from becoming a pathological prompt. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[...truncated, ${text.length - max} more characters]`;
}
