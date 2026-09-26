# interpres

**Make any MCP server talkable.** Paste a remote MCP server URL, press Talk, and
AssemblyAI's Voice Agent API calls that server's tools live.

## Why

OpenAI's Realtime API has a native `mcp` tool type: you hand it a `server_url`
and the API executes the remote MCP server's tools for you. AssemblyAI's Voice
Agent API has only `function` (client-side) and `http` (server-side) tools — no
MCP. AssemblyAI's own migration guide sells the switch on price ($4.50/hr vs
$18.00/hr) and never mentions MCP, so every team that migrates silently loses
its MCP tools.

interpres is the missing adapter.

## Result shaping, and the LLM Gateway

MCP tools answer to a text-model reader: JSON, markdown tables, 20-50 KB search
dumps. Read aloud, that is unusable, so every large or structured result is
turned into at most 600 characters of plain speech before the agent sees it.

**The local path is primary.** A deterministic extractive summariser in
`packages/core/src/extract.ts` strips what has no spoken form (URLs, markdown,
table rules, record labels), scores sentences against the caller's question,
and returns at most four of them in document order. Every sentence it speaks
appears in the tool output; it cannot invent a fact.

**The LLM Gateway only refines, and no reply depends on it.** The local answer
is computed first. AssemblyAI's LLM Gateway then gets a hard **1.5 s** window to
replace it with a better sentence. If it is slow, fails, or is rate-limited, the
local answer goes out. After any `429`, a circuit breaker skips the Gateway
entirely for **60 s**, so a rate-limited Gateway costs no waiting at all. The
most the Gateway can ever add to a turn is 1.5 s, and in `interactive` mode that
window overlaps the agent's own "let me check that" phrase.

**Which Gateway models this account can reach** (measured 2026-09-26, Free plan
with hackathon credits):

| model id | result |
|---|---|
| `qwen3.5-4b-32k-fast` | **200 - used for refinement** |
| `gemini-2.5-flash`, `gemini-3.8-flash` | 400 "Your account does not have access to this LLM Gateway model" |
| `claude-haiku-4-5-20251001` | 400, same |
| `gpt-5-nano`, `gpt-oss-20b` | 400, same |
| `gemma-4-31b`, `nemotron-nano-9b-v2`, `deepseek-v4.1-flash` | 400, same |

`qwen3.5-4b-32k-fast` is the model AssemblyAI serves itself. It is also
rate-limited hard on this plan: 4 of 6 sequential calls returned
`429 "too many requests for this action"`, which is why the breaker exists.
Set `SHAPER_MODEL` to use another model on an account that can reach one.

## Status

Under construction for the lablab.ai AssemblyAI Voice Agent Hackathon
(submissions close Wed Sep 30 2026). See `BUILDLOG.md` for what is built and
what is proven.

## License

MIT — see `LICENSE`.
