# LLM Gateway models this account can reach

Measured 2026-09-26T19:13:32.878Z by `scripts/gateway-models.ts`; raw outcomes in `data/gateway-models-2026-09-26.json`. One five-token completion per model id, then six sequential calls to `qwen3.5-4b-32k-fast`.

| model id | result |
| --- | --- |
| `qwen3.5-4b-32k-fast` | 200 |
| `gemini-2.5-flash`, `gemini-3.8-flash`, `claude-haiku-4-5-20251001`, `gpt-5-nano`, `gpt-oss-20b`, `gemma-4-31b`, `nemotron-nano-9b-v2`, `deepseek-v4.1-flash` | 400 "Your account does not have access to this LLM Gateway model" |
| `qwen3.5-4b-32k-fast`, six calls in a row | 6 of 6 answered 429 |
