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

**Speech never waits on the LLM Gateway.** Gateway refinement is off unless
`SHAPER_REFINE=on`, because it was measured and found to cost audible silence:
across 20 tool-calling turns of real speech, the agent never spoke a transition
phrase before calling a tool (0 of 20), so the time between `tool.call` and the
result is silence the caller hears. With refinement on, the Gateway added
582-1,133 ms of it to every call it refined, and median voice-to-voice rose from
4,476 ms to 5,208 ms. When switched on, it still cannot fail a turn: the local
answer is computed first, the Gateway gets a hard 1.5 s to replace it, and a
circuit breaker skips it for 60 s after any `429`.

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
Set `SHAPER_REFINE=on` to use it, and `SHAPER_MODEL` to use another model on an
account that can reach one.

## Identifiers and state-changing tools

**Voice for intent, keyboard for identifiers, and nothing misheard gets executed.**

Speech-to-text cannot carry a long identifier. Measured with real speech through
the Voice Agent API, it fails in three distinct ways:

1. **A repetition loop.** `0x` followed by 39 zeros and a `1` came back as roughly
   900 zeros, with no `1`.
2. **Merged doubled letters.** `5 a a e b` became `5aeb`, and `b e a e d` became `bead`:
   38 characters where 40 were said, and the server rejected it.
3. **A valid-looking wrong value.** `... 6 c 0 e 9 b ... 5 c 8 e ...` became
   `... 6ce09b ... 5cad ...`: still 40 hex characters, a *different* address, and the
   server answered confidently about a wallet nobody asked for.

Names fail too: in a live test "ochinimus.app" was heard as "okinimus.app".

So a gate sits in front of every MCP request, in the browser and in both proof
scripts:

- **An identifier-shaped argument** - `0x` + 16 or more hex, 24+ hex or base58 mixing
  digits and letters, a UUID, or 16+ characters without spaces holding at least 3
  digits and 3 letters - runs only if it appears verbatim in the paste box or in an
  earlier tool result (hex compared case-insensitively, base58 exactly). A result
  that merely echoes back the argument it was sent does not count. Otherwise no
  request is made: the agent gets `needs_confirmation`, says the last four
  characters, and the page shows the full heard value in large type, grouped in
  fours. If the server's own schema has a `pattern` for that argument and the value
  fails it, the answer is `invalid`: paste it.
- **A tool that changes state** - `destructiveHint`, or not `readOnlyHint` and a
  name whose first word (after any prefix every tool shares) is a write verb such as
  create, send, transfer or sign - is held the same way, and the line names what it
  will do and on which server.
- **An identical repeat within 120 s, after the person says yes, runs exactly once.**
  A changed repeat is held again.
- Digit-only strings are **not** treated as identifiers yet: card numbers, phone
  numbers and order numbers pass through. That is the next thing to add.

**The paste box** under the Talk button is the other half. Its text reaches tools
through a built-in `use_pasted_text` tool, verbatim: measured, the sha256 of the
pasted address equalled the sha256 of the argument the MCP server received. Its
word parts also become keyterms, which fixes names: "check ochinimus dot app"
was transcribed correctly 3 times out of 3 with the pasted keyterm, and 0 out of 3
without it (heard as "aginimus").

One limit, measured: a spoken "yes" after hearing only the last four characters
does not verify the middle. The confirmed spoken address above still carried its
`c8e` -> `cad` error, because the last four were right. Read the value on the
card - or paste it.

## Tests

```bash
npm test            # 290 tests, no network needed: runs offline
npm run test:live   # 6 more that reach www.assemblyai.com and afg.ai
```

`npm test` is hermetic: it passes inside a macOS sandbox that denies all
outbound network (`sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' npm test`),
where the live suite fails 6 of 6.

## Status

Under construction for the lablab.ai AssemblyAI Voice Agent Hackathon
(submissions close Wed Sep 30 2026). See `BUILDLOG.md` for what is built and
what is proven.

## License

MIT — see `LICENSE`.
