/**
 * Which LLM Gateway models this account can reach, and how often the one that
 * answers turns a request away: one tiny completion per model id, then six
 * sequential calls to the model interpres uses. Writes the raw outcomes to
 * data/ and the table the README quotes to docs/GATEWAY.md.
 *
 *   node --env-file=.env scripts/gateway-models.ts
 *
 * Nothing secret is written: statuses, and the first 100 characters of an
 * error body, which names the model and never the key.
 */
import { writeFile } from 'node:fs/promises';
import { config } from '../apps/server/src/config.ts';

export const MODELS = [
  'qwen3.5-4b-32k-fast',
  'gemini-2.5-flash', 'gemini-3.8-flash',
  'claude-haiku-4-5-20251001',
  'gpt-5-nano', 'gpt-oss-20b',
  'gemma-4-31b', 'nemotron-nano-9b-v2', 'deepseek-v4.1-flash',
];

async function ask(model: string): Promise<{ status: number; ms: number; error?: string }> {
  const started = Date.now();
  const res = await fetch(config.llmGateway, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.assemblyAiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with the word OK.' }] }),
  });
  const text = await res.text();
  let error: string | undefined;
  if (!res.ok) {
    // The specific reason is in metadata.errors; `message` is the generic "invalid request body".
    try {
      const j = JSON.parse(text) as { metadata?: { errors?: string[] }; error?: { message?: string } | string; message?: string };
      error = j.metadata?.errors?.[0] ?? (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message;
    } catch { error = text; }
    error = (error ?? '').slice(0, 100);
  }
  return { status: res.status, ms: Date.now() - started, ...(error ? { error } : {}) };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (config.assemblyAiKey === '') throw new Error('ASSEMBLYAI_API_KEY is not set');
  const at = new Date().toISOString();
  const models: Array<{ model: string; status: number; ms: number; error?: string }> = [];
  for (const m of MODELS) models.push({ model: m, ...(await ask(m)) });
  const burst: Array<{ status: number; ms: number; error?: string }> = [];
  for (let i = 0; i < 6; i++) burst.push(await ask(config.shaperModel));

  await writeFile(`data/gateway-models-${at.slice(0, 10)}.json`, `${JSON.stringify({ at, gateway: config.llmGateway, models, burst: { model: config.shaperModel, calls: burst } }, null, 1)}\n`);

  // One row per distinct outcome, models grouped, in the order first seen.
  const rows = new Map<string, string[]>();
  for (const m of models) {
    const outcome = m.status === 200 ? '200' : `${m.status}${m.error ? ` "${m.error.replace(/\|/g, '/')}"` : ''}`;
    rows.set(outcome, [...(rows.get(outcome) ?? []), `\`${m.model}\``]);
  }
  const refused = burst.filter((b) => b.status === 429).length;
  const md = [
    '# LLM Gateway models this account can reach',
    '',
    `Measured ${at} by \`scripts/gateway-models.ts\`; raw outcomes in \`data/gateway-models-${at.slice(0, 10)}.json\`. One five-token completion per model id, then six sequential calls to \`${config.shaperModel}\`.`,
    '',
    '| model id | result |',
    '| --- | --- |',
    ...[...rows].map(([outcome, ms]) => `| ${ms.join(', ')} | ${outcome} |`),
    `| \`${config.shaperModel}\`, six calls in a row | ${refused} of 6 answered 429 |`,
    '',
  ].join('\n');
  await writeFile('docs/GATEWAY.md', md);
  console.log(md);
}
