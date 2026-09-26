/** Configuration, all overridable by environment variable. */

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};

export const config = {
  port: num('PORT', 3030),
  /** 127.0.0.1 only. The VPS has no host firewall, so 0.0.0.0 would publish it. */
  host: process.env.HOST ?? '127.0.0.1',

  assemblyAiKey: process.env.ASSEMBLYAI_API_KEY ?? '',

  agentsApi: process.env.AGENTS_API ?? 'https://agents.assemblyai.com/v1',
  llmGateway: process.env.LLM_GATEWAY ?? 'https://llm-gateway.assemblyai.com/v1/chat/completions',
  /**
   * Only job is turning a tool result into one spoken sentence.
   *
   * The docs list about forty models, but this account can reach exactly one:
   * every other id we tried answered `400 "Your account does not have access to
   * this LLM Gateway model"`. `qwen3.5-4b-32k-fast` is the model AssemblyAI
   * serves itself, and it is enough - text in, one sentence out, no tools and no
   * structured output needed. Its 32k context is why `shaper.ts` clips the input.
   */
  shaperModel: process.env.SHAPER_MODEL ?? 'qwen3.5-4b-32k-fast',

  token: {
    /** Redemption window for the token, not the session length. 1-600. */
    expiresInSeconds: num('TOKEN_EXPIRES_IN', 120),
    /** Session length cap. 60-10800. 300 on the public demo. */
    maxSessionDurationSeconds: num('MAX_SESSION_SECONDS', 300),
  },

  limits: {
    /** Token mints per IP per hour. */
    perIpPerHour: num('RATE_PER_IP_HOUR', 6),
    /** Token mints across all callers per day, so the credit grant survives. */
    globalPerDay: num('RATE_GLOBAL_DAY', 400),
    /** How long a converted catalog is reused for one URL. */
    catalogCacheMs: num('CATALOG_CACHE_MS', 10 * 60 * 1000),
    /** Cached catalogs held at once. */
    catalogCacheEntries: num('CATALOG_CACHE_ENTRIES', 200),
  },

  logPath: process.env.LOG_PATH ?? 'data/events.jsonl',
} as const;

export function assertConfigured(): void {
  if (config.assemblyAiKey === '') {
    throw new Error('ASSEMBLYAI_API_KEY is not set. Put it in .env; it never reaches the browser.');
  }
  const { expiresInSeconds, maxSessionDurationSeconds } = config.token;
  // Documented bounds. Outside them the token endpoint 4xxs, which would only
  // show up as a browser that cannot connect.
  if (expiresInSeconds < 1 || expiresInSeconds > 600) {
    throw new Error(`TOKEN_EXPIRES_IN must be 1-600, got ${expiresInSeconds}`);
  }
  if (maxSessionDurationSeconds < 60 || maxSessionDurationSeconds > 10800) {
    throw new Error(`MAX_SESSION_SECONDS must be 60-10800, got ${maxSessionDurationSeconds}`);
  }
}
