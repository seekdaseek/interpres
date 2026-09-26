/**
 * The result shaper's LLM call, against AssemblyAI's LLM Gateway.
 *
 * OpenAI-compatible, same API key as the Voice Agent API. `packages/core` owns
 * the decision of *whether* to shape; this is only the network call, so core
 * stays testable without one.
 */
import type { Shaper } from '@interpres/core';
import { SHAPER_SYSTEM_PROMPT, buildShaperUserPrompt } from '@interpres/core';
import { config } from './config.ts';

export type ShaperStats = {
  calls: number;
  failures: number;
  totalMs: number;
  /** Retries spent on a 429. */
  retries: number;
  /** Last failure, so a silent fallback is diagnosable from /api/status. */
  lastError?: string;
  lastErrorAt?: string;
};

/**
 * One retry, and only for 429.
 *
 * Measured on 2026-09-26: 4 of 6 shaping calls on this account came back
 * `429 "too many requests for this action"`. A single short retry converts some
 * of those without keeping a voice turn waiting; the local extractive shaper in
 * `packages/core` handles the rest, so a refusal degrades instead of failing.
 */
const RETRY_AFTER_429_MS = 700;

export function makeShaper(stats: ShaperStats, apiKey: string = config.assemblyAiKey): Shaper {
  return async ({ text, question, toolName, maxChars }) => {
    const started = Date.now();
    stats.calls++;
    const ac = new AbortController();
    // A voice turn is waiting. Better a local answer than a pause.
    const timer = setTimeout(() => ac.abort(), 8000);

    const attempt = async (retried: boolean): Promise<string> => {
      const res = await fetch(config.llmGateway, {
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
      if (!res.ok) {
        // The body names the reason - a gated model, a rate limit - and without
        // it a failure is invisible behind the local fallback.
        const detail = await res.text().catch(() => '');
        if (res.status === 429 && !retried) {
          stats.retries++;
          await new Promise((r) => setTimeout(r, RETRY_AFTER_429_MS));
          return attempt(true);
        }
        throw new Error(`llm gateway ${res.status}: ${detail.slice(0, 200)}`);
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content ?? '';
      if (content.trim() === '') {
        throw new Error('llm gateway returned an empty completion');
      }
      return content.trim().slice(0, maxChars * 2);
    };

    try {
      return await attempt(false);
    } catch (err) {
      // Counted in exactly one place. Incrementing at each throw site as well
      // made a single failure show up as two in /api/status.
      stats.failures++;
      stats.lastError = err instanceof Error
        ? (err.name === 'AbortError' || err.name === 'TimeoutError' ? `timeout after ${Date.now() - started}ms` : err.message)
        : String(err);
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
