# BUILDLOG

Every entry records: the file changed, what it does, and the command output that
proved it. Nothing is called working unless it was run and the output observed.

---

## 2026-09-26 — step 1: scaffold

### Environment facts measured on the Mac

```
$ which node; node -v; npm -v
/usr/local/bin/node
v24.16.0
11.13.0

$ git config --global user.name; git config --global user.email
seekdaseek
ochinimus@gmail.com

$ git config --global core.hooksPath
/Users/ochinimus/.git-hooks     # commit-msg hook present, strips AI trailers

$ gh auth status
✓ Logged in to github.com account seekdaseek (keyring)

$ git -C /Volumes/D/interpres rev-parse --show-toplevel
fatal: not a git repository        # no repo yet — safe to git init

$ awk -F= '{print $1, length($2), "chars"}' .env
ASSEMBLYAI_API_KEY 32 chars
```

**Difference from the brief:** the brief says "Node lives on /Volumes/D". It does
not — `which node` resolves to `/usr/local/bin/node` (v24.16.0). Version gate
(>= 20) is satisfied either way.

### Files

- `.gitignore` — written **before** the first `git add`. Contains `.env*`,
  `node_modules/`, `dist/`, `*.log`, `.DS_Store`, `data/raw/`.
- `LICENSE` — MIT, © 2026 seekdaseek (lablab requires MIT-compliant entries).
- `README.md` — stub: the one-sentence pitch and the OpenAI-vs-AssemblyAI gap.
- `BUILDLOG.md` — this file.

### Docs re-read on 2026-09-26 (§0 says trust the docs over the brief)

Sources used, in order of authority:
- `https://www.assemblyai.com/docs/api-reference/specs/voice-agent-api.yaml` — AsyncAPI 3.0.0, 1080 lines. Machine-readable, authoritative for field types and bounds.
- `https://www.assemblyai.com/docs/llms-full.txt` — 3.5 MB, 89,950 lines. Full prose docs; **more complete than the AsyncAPI spec** (see difference 2).
- `AssemblyAI/voice-agent-starter-js` @ depth-1 clone — the official browser audio implementation.

#### Confirmed exactly as the brief states

- WebSocket `wss://agents.assemblyai.com/v1/ws`; browser path is `?token=`, one use per token.
- `GET https://agents.assemblyai.com/v1/token`, `Authorization: Bearer <key>`. `expires_in_seconds` 1–600, `max_session_duration_seconds` 60–10800 (default 10800). Response `{token, expires_in_seconds}`.
- Audio: `audio/pcm` = 24,000 Hz, 16-bit signed LE, mono, base64. Also `audio/pcmu`/`audio/pcma` at 8 kHz for telephony.
- Mutability after `session.ready`: immutable = `greeting`, `output.voice`, `output.format` (error code `immutable_field`). Mutable = `system_prompt`, `input.turn_detection`, `input.keyterms` (≤100, next utterance), `input.transcription_mode`, `input.transcription_prompt` (≤1750 chars), `output.volume`. `session.tools` is accepted in later updates.
- Client→server: `session.update`, `session.resume`, `session.end`, `input.audio`, `tool.result`, `reply.create`, `conversation.message {role: user|system, content}`.
- Server→client: all 13 events the brief lists, `transcript.agent.delta` included.
- `tool.call {call_id, name, arguments}` — `arguments` is a dict. `tool.result {call_id, result}` — `result` is a JSON **string**. Send it when `reply.done` is the latest event; drop pending results when `reply.done` has `status: "interrupted"`.
- ≤10 tools per phase: *"Past that, selection accuracy drops."*
- Parameter hints `enum` / `pattern` / `format` / `examples` (2–4), `execution_mode` `interactive|hold`, `timeout_seconds`.

#### 13 differences and additions found — these change the build

1. **No tool-name charset rule exists in the docs.** The brief says "Sanitise tool names to the charset the Voice Agent API allows. Check the rule in the docs." There is no such rule. Evidence: `grep -c pattern voice-agent-api.yaml` → `0` (control: `grep -c 'tool\.result'` → `8`, so the file and the grep both work); `ToolDefinition.name` is a bare `type: string` with no `pattern` and no `maxLength`; the manage-agents validation table names only voice, `http.url` and `timeout_seconds` rules. The only guidance is a convention in the client-side-tools field table: *"snake_case, verb-noun."*
   → **Decision:** sanitise to `[A-Za-z0-9_-]`, collapse runs to `_`, cap at 64 chars. This is our conservative choice, not a documented limit, and the README will say so.

2. **The AsyncAPI spec is missing two documented events.** `conversation.message` and `transcript.agent.delta` appear in the prose docs but not in `voice-agent-api.yaml` (0 hits in the spec, present at llms-full.txt:53039 and :53222). The brief is right and the machine-readable spec is behind. `scripts/e2e.ts` depends on `conversation.message`, so this mattered.

3. **`reply.audio` carries `data`, not `audio`.** `input.audio` uses `{"audio": "<base64>"}`; `reply.audio` uses `{"data": "<base64>"}`. The brief flagged this as "confirm the payload field names" — confirmed, the names differ by direction.

4. **The brief's first demo target is deprecated and past its shutdown date.** The legacy docs MCP endpoint the brief named (on AssemblyAI's `mcp.` subdomain; deliberately not linked here, so nobody copies it) answers `initialize` 200 with no auth, but all 4 of its tool descriptions begin:
   `[DEPRECATED — moved to https://www.assemblyai.com/docs/mcp, fully disabled July 16, 2026. Content here is kept in sync for now, but reconnect to the new MCP server before shutdown.]`
   Today is 2026-09-26 — that date passed 10 weeks ago and the server is living on borrowed time.
   The live replacement `https://www.assemblyai.com/docs/mcp` serves `serverInfo {name: "AssemblyAI", version: "1.0.0"}`, carries an `instructions` string, and has **0** tools mentioning deprecation.
   → **Decision:** preset #1 is `https://www.assemblyai.com/docs/mcp`. Building the flagship demo on an endpoint whose own tools tell us to leave is the Drift mistake again.

5. **Session History is two hops, not one.** `GET /v1/sessions` returns metadata only: `id`, `agent_id`, `status`, `public_close_reason`, `duration_seconds`, `created_at`, `ended_at`, plus `has_more` / `response_metadata.next_cursor` (`limit` 1–200, default 50). Tool-call logs and time-to-first-audio are in the **timeline artifact**: `GET /v1/sessions/{id}` → `artifacts[]` where `type == "timeline"` → download that pre-signed `url` **with no Authorization header**. Per turn it gives `time_to_first_audio_ms`, `status`, `user_transcript`, `agent_text`, and `tool_calls[]` with `duration_ms` and `is_error`. That is exactly what `docs/PROOF.md` needs, and `scripts/proof.ts` must do both hops.
   Empty arrays are **omitted**: a session with no turns has no `turns` key; a turn with no tools has no `tool_calls`. Default them on read.

6. **`session.tools` updates REPLACE the array, they do not merge.** The phase planner must send the complete tool list every time, never a delta.

7. **Progressive reveal must update `system_prompt` together with `tools`.** Docs: *"Tool-only gating where the prompt still references a now-hidden tool can underperform not gating at all."* The brief's phase planner only re-sends tools, keyterms and prompt-for-transcription; it must also rewrite `system_prompt`.

8. **`pattern` is a Python regex matched against the whole value** — no `^`/`$` needed — and it is matched against the value *as the agent produces it*, which for spoken digit strings can still contain spaces. This is the precise rule the converter's pattern-safety check needs.

9. **`parameters` is not validated server-side.** *"Malformed schemas (missing `type: "object"`, broken `enum`) are accepted silently and break tool calling at runtime. Validate locally."* This is the strongest argument for the converter being fully unit-tested — a bad conversion fails silently in production, not at `session.update`.

10. **A browser may ignore `new AudioContext({sampleRate: 24000})`.** The brief asked whether Brave honours it. The official starter answers the question and sidesteps it: *"Both worklets resample, since a browser may ignore the rate an AudioContext asks for."* We adapt its `CaptureProcessor`/`PlaybackProcessor` — linear resampling both directions, a 30-second ring buffer for playback, `'stop'` to flush on barge-in, pre-allocated scratch buffers, and a `!int16.length` guard (an empty chunk would make `_rsPrev` NaN and silence the ring permanently). No dependency on what Brave does.

11. **Registry entries are versioned, so the sweep must dedupe.** `GET /v0/servers` returns `{servers: [{server, _meta}], metadata: {nextCursor, count}}` — note each entry nests under `server`. The same name appears at several versions (`nextCursor` came back as `ac.inference.sh/mcp:2.0.0`), and `_meta["io.modelcontextprotocol.registry/official"]` carries `isLatest` and `status`. Without deduping by name the sweep would probe one server many times and inflate every headline count.

12. **`tool.result` also takes `is_error: boolean`**, and the `error` text is read verbatim by the model — docs recommend naming the failing field, saying what did work, and what to ask next. The result shaper should follow that shape on failure.

13. **A tool definition requires all four of `type`, `name`, `description`, `parameters`.** MCP tools may carry an empty description, so the converter must synthesise one rather than emit `""`.

Also recorded: US English voices are `alba`, `eve`, `george`, `jane`, `jean`, `mary`, `michael` (`anna`/`charles`/`paul`/`vera` are British). Inline config takes `output.voice` as a plain **string**; the stored-agent REST API takes `voice: {voice_id}`. Picking `alba`. `timeout_seconds` is 1–300, default 120. MCP tools also carry an optional `title`, which the converter prefers for display. The official starter requests `/token?product=voice_agent&...`; that param is undocumented and our call without it returned 200 with a valid token, so we omit it.

### Live dependency checks — all run, all output observed

```
$ curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ASSEMBLYAI_API_KEY" \
    'https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=300'
200        # body keys: token (<string 2463 chars>), expires_in_seconds=60

$ curl -s -o /dev/null -w '%{http_code}' -H "Authorization: $ASSEMBLYAI_API_KEY" \
    'https://agents.assemblyai.com/v1/sessions?limit=1'
200        # note: the Bearer prefix is optional here, as the docs say

$ POST https://www.assemblyai.com/docs/mcp  (initialize, no auth)
200 text/event-stream — serverInfo {"name":"AssemblyAI","version":"1.0.0"}, protocolVersion 2025-06-18
   capabilities {tools:{listChanged:true}, resources:{listChanged:true}}, no Mcp-Session-Id header (stateless)
   tools/list → 3 tools: search_assembly_ai, query_docs_filesystem_assembly_ai (3405-char description),
   submit_feedback (a WRITE tool — the sweep must never call tools, and presets should flag it)

$ POST <legacy docs MCP endpoint named in the brief>
200 — 4 tools, ALL deprecated per difference 4 above

$ curl -s 'https://registry.modelcontextprotocol.io/v0/servers?limit=3'
200 — {servers:[{server,_meta}], metadata:{nextCursor:"ac.inference.sh/mcp:2.0.0", count:3}}

$ gh search repos voice-agent --owner AssemblyAI
voice-agent-starter-js (2026-09-04), voice-agent-starter-python (2026-09-01),
voice-agent-api-twilio-example (2026-07-30), bluejay-aai-bridge (2026-09-04)
```

**UNTESTED so far:** the WebSocket session itself. No `session.ready` has been observed — only the token mint. `scripts/e2e.ts` (step 4) is the test that proves it, and CHECKPOINT A is where that evidence lands.

---

## 2026-09-26 - step 2: the converter (`packages/core`)

No build step anywhere: Node 24.16.0 runs `.ts` directly and `node --test` runs
`.ts` test files, so the tests exercise the same source the server imports.

```
$ node t.ts                       -> ts-direct-ok 42
$ node --test t.test.ts           -> pass 1
```

### Fixtures: real `tools/list` output from three live servers

`scripts/capture-fixture.ts` writes them, deliberately **not** using
`packages/core`'s own MCP client - a fixture produced by the code under test
proves nothing.

```
$ node scripts/capture-fixture.ts assemblyai-docs-mcp https://www.assemblyai.com/docs/mcp
3 tools, server "AssemblyAI" v1.0.0, session=stateless
$ node scripts/capture-fixture.ts advisorsai-service-navigator https://advisorsai.ai/mcp
5 tools, server "advisors-ai-service-navigator" v2026-08-21.5, session=stateless
$ node scripts/capture-fixture.ts afg-marketplace https://afg.ai/mcp
15 tools, server "afg" v0.1.0, session=stateful, $ref=7 $defs=7 allOf=0 anyOf=30
```

### Four findings from the real data that changed the design

1. **`anyOf` is the real-world case; `allOf` barely exists.** Across the first
   100 registry entries, `allOf` appeared **0** times and `anyOf` **hundreds** of
   times - it is what Pydantic and Zod emit for every optional field, as
   `anyOf: [{type: T}, {type: "null"}]` with `default: null`. The brief plans for
   `$ref`/`$defs`/`allOf` only. All four are handled, with the nullable unwrap
   carrying the weight: 30 of them in the afg fixture alone.

2. **My first complexity measurement was wrong, and a control caught it.** I
   counted `$ref`/`anyOf` over each tool's whole JSON blob and picked fixtures on
   that basis. Re-measuring `inputSchema` only:
   `advisorsai INPUT: anyOf=0 $ref=0 / OUTPUT: anyOf=57 $ref=16`. Every one of
   those 57 was in `outputSchema`, which the converter never touches. The hard
   input schemas are in the afg fixture, which is why it is there.

3. **Unwrapping a nullable must drop `default: null`.** Left in place the output
   said `{"type": "string", "default": null}` - a default the property's own type
   forbids, shown to the model as a legal value. Now dropped; legitimate
   defaults like `default: ""` survive. Test: *unwrapping a nullable drops the
   null default it came with*.

4. **Stateful MCP servers need the session id AND `notifications/initialized`.**
   Two servers answered `initialize` and then failed `tools/list` with
   `Bad Request: Missing session ID`. My first probe captured the
   `Mcp-Session-Id` header and never sent it back. With the header forwarded and
   the `initialized` notification sent, both now list tools (`afg.ai` 15,
   `agentberg.ai` 11). The sweep would have written these off as broken servers
   and under-reported the reachable count.

### The pattern judge, and the bug a control found in it

`judgePattern` decides whether a `pattern` is safe to forward. The control set
is the docs' own "good values" table, every row of which must survive, plus the
one pattern the docs call broken, which must not.

First attempt gated on **total digits in the example** at a threshold of 7. A
deliberately-escaped inline test looked like it disagreed with the docs on four
rows; the escaping was mangled, but re-running it properly in a file showed the
rule really was wrong:

```
MISS docs "good value" survives: E.164 phone
  -> accepts "+14155552671" but rejects all 3 spoken forms of it
```

`+14155552671` holds 11 digits, so a total-digit rule condemns a pattern the
docs explicitly endorse. The fix: gate on the longest **contiguous** run the
pattern *insists* on, read off the **lower** bound of its quantifiers. That one
choice separates the two classes cleanly:

| pattern | insists on | verdict |
|---|---|---|
| `\d{5}(-\d{4})?` (ZIP) | 5 | keep |
| `\+[1-9]\d{1,14}` (E.164) | **1** | keep |
| `[A-Z]{2}-\d{5}` (order ID) | 5 | keep |
| `\d{4}-\d{2}-\d{2}` (ISO date) | 4 | keep |
| ` *([0-9] *){13,19}` (docs' spoken card) | 0, and allows spaces | keep |
| `\d{16}` (the docs' broken example) | 16 | **drop** + `strip_non_digits` |
| `\d{13,19}` | 13 | **drop** + `strip_non_digits` |
| `\d{4}\d{4}\d{4}\d{4}` | 16 (summed) | **drop** + `strip_non_digits` |

Threshold 10, with tests pinning both sides (`\d{9}` keeps, `\d{10}` drops) so
moving it cannot pass unnoticed. When a pattern is dropped the shape is written
into the property description instead and a `strip_non_digits` normaliser is
recorded against that argument path.

### Ranking: measured, not asserted

BM25-lite, no embeddings. Two real bugs came out of evaluating it against the
three fixtures instead of eyeballing it:

- *"dispute the outcome"* ranked `afg_get_reputation` above `afg_dispute`,
  because raw term frequency let a description that says "disputed" and
  "outcome" outweigh the tool actually named `dispute`. Fixed by scoring
  **presence per field** rather than frequency: name, description and property
  names each contribute their weight once.
- The stemmer sent `dispute` -> `dispute` but `disputed` -> `disput`, so the word
  family did not match itself. Fixed by stripping a trailing `e` last, which
  sends dispute / disputes / disputed all to `disput`.

Measured over 19 spoken queries across all three catalogs:

```
top-1 accuracy: 17/19 (89%)
recall@9:       19/19 (100%)
```

recall@9 is the number that matters, because `find_tools` reveals nine tools at
once. Both top-1 misses are synonym gaps a keyword ranker cannot close - "throw
away that wallet" for `afg_discard_wallet`, "tell me about that one service" for
`advisors_catalog_get_service` - and in both the right tool is still second.
Both numbers are asserted in `rank.test.ts`.

### One deliberate deviation from the brief

The brief says "Always expose a meta-tool, `find_tools(query)`, plus up to 9
catalog tools." When the whole catalog already fits in 10, `find_tools` spends
one of ten slots to answer "you already have all of them", and gives the model a
wrong turn to take. So: catalog <= 10 exposes every tool and no `find_tools`;
catalog > 10 exposes `find_tools` plus the 9 best. Above 10 it is also forced -
10 catalog tools plus `find_tools` would be 11.

### Converter output on the three real catalogs

```
assemblyai-docs-mcp   3/3 converted, 1 description truncated (3405 chars -> 1024)
advisorsai            5/5 converted, 5 with hints, 1 pattern kept
afg-marketplace      15/15 converted, 7 $refs resolved, 30 nullables unwrapped
                                      23/23 tools total, 0 failures
```

### Tests

```
$ npm test
ℹ tests 142
ℹ pass 142
ℹ fail 0

$ npx tsc --noEmit -p tsconfig.json
(clean)
```

The suite asserts the API's own contract on every tool of every fixture: `type`,
`name`, `description` and `parameters` all present; `name` inside
`[A-Za-z0-9_-]{1,64}`; `parameters.type === "object"`; every property carrying a
description; `required` naming only properties that exist; and **no** `$ref`,
`$defs`, `allOf`, `anyOf`, `oneOf`, `$schema` or `title` surviving into the
output. Two fixture-drift guards fail loudly if a re-capture turns a hard
fixture into an easy one (`>= 7` refs and `>= 25` nullables in afg).

**UNTESTED at this point:** everything over the wire. No `session.ready` has been
observed and no `tool.call` has ever arrived. `scripts/e2e.ts` in step 4 is the
test that proves it; CHECKPOINT A is where that evidence goes.

---

## 2026-09-26 - step 3: `apps/server`

Hono on `@hono/node-server`, bound to `127.0.0.1`. Routes: `/api/health`,
`/api/presets`, `/api/token`, `/api/mcp/connect`, `/api/mcp/find-tools`,
`/api/mcp/call`, `/api/status`, plus the web app from the same origin.

### The SSRF guard closes DNS rebinding, not just the first lookup

Resolving a hostname, approving it, and then calling `fetch()` leaves the name
free to resolve again - to `169.254.169.254`, say - on the request itself.
Undici's `connect.lookup` hook takes the verified addresses and nothing else,
while TLS still sees the real hostname, so certificate validation is untouched.
Proved before relying on it:

```
$ # pin to a deliberately wrong public IP
PINNED-FETCH status 403 | lookup hook saw hostname: example.com
$ # pin to the addresses we actually resolved and verified
resolved example.com -> 2606:4700:10::6814:179a, ..., 104.20.23.154
pinned to verified IPs -> status 200 bytes 559
```

The 403 is Cloudflare answering at the wrong IP for that Host, which is the
point: the socket went where we sent it and TLS still matched the name.

Rules enforced: https only, no credentials in the URL, every resolved address
publicly routable (one bad answer among many disqualifies the host - that mix is
the rebinding setup), redirects refused, 10 s timeout, 512 KB cap applied as a
streaming counter so a chunked response with no `content-length` cannot slip by.
The guard is passed to the MCP SDK as its `fetch`, so it covers every request
either transport makes rather than only the first.

21 tests, including known-positive controls (`8.8.8.8`, real resolved
addresses), boundary addresses either side of each blocked range
(`172.15.255.255` allowed / `172.16.0.1` blocked), and metadata by every
spelling: `169.254.169.254`, `::ffff:169.254.169.254`, `::ffff:a9fe:a9fe`.

### Node's type-stripping has a real constraint, and tsc now enforces it

`node --test` failed with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript
parameter property is not supported in strip-only mode` on
`constructor(readonly code: SsrfCode, ...)`. Field written out longhand, and
`erasableSyntaxOnly: true` added to tsconfig so `tsc` rejects this whole class
(parameter properties, enums, namespaces) instead of the test runner finding it.

### Rate limiting is keyed on something a client cannot forge

Per-IP-per-hour and a global daily cap, checked global-first so a caller with
allowance left is told the real reason. Keyed on `cf-connecting-ip` (set by
Cloudflare, and this service is only reachable through the tunnel) or the
socket's own peer address. `X-Forwarded-For`, `X-Real-IP` and `True-Client-IP`
are all ignored; a test rotates a forged `X-Forwarded-For` three times and
confirms all three charge the same socket.

### The LLM Gateway cannot be the primary path, and the numbers say why

Two measured constraints, both found by running it rather than assuming:

1. **This account can reach one model out of about forty.** `gemini-2.5-flash-lite`,
   which the brief's plan implied, answers
   `400 {"errors":["Your account does not have access to this LLM Gateway model"]}`.
   So does every other id tried - Gemini, Claude, GPT, DeepSeek, Nemotron,
   gpt-oss, gemma. The one that works is `qwen3.5-4b-32k-fast`, the model
   AssemblyAI serves itself. Text in, one sentence out, no tools needed.

2. **It is rate-limited hard.** Six shaping calls in sequence:
   `llm, llm, 429, 429, 429, 429` -
   `429 {"message":"too many requests for this action"}`. A demo whose answers
   degrade into read-aloud markdown two times in three is not a demo.

So the design inverted: **the local path is the product and the LLM refines it.**
`packages/core/src/extract.ts` is a deterministic extractive summariser - it
strips what has no spoken form (URLs, markdown, table rules, the
`Title:`/`Link:`/`Page:`/`Content:` labels search-style MCP servers wrap each
record in), splits into sentences, scores them by overlap with the caller's
question plus rarity and position, and speaks back at most four **in document
order**. Extractive, not abstractive: every sentence it says appears in the tool
output, which is the same guarantee the anti-fabrication clause asks of the
agent. Plus one 700 ms retry on 429, which converts some of them.

Before, on a 43,689-character docs result:

> Title: Encodings Link: https://assemblyai.com/docs/voice-agents/... Page:
> voice-agents/audio-format Content: ## Encodings Encoding Sample rate Bit depth
> `audio/pcm` 24,000 Hz 16-bit signed integer (little-endian) ...

After, no network involved:

> Both default to audio/pcm at 24 kHz. Change it for telephony, where 8 kHz
> G.711 matches the phone network and avoids resampling.

And on "what happens if I change the greeting mid-session", again locally:

> When you configure an agent inline via session.update, the greeting is
> immutable after session.ready. Set it on your first session.update; trying to
> change it mid-session returns immutable_field. The greeting is spoken once at
> session start.

Two bugs the tests found in that module:

- A greedy `\s*` in the metadata-label regex consumed the newline the *next*
  label needed, so `Link:` was stripped and `Page:` right after it was not.
  Replaced the captured prefix with a lookbehind.
- One failure was counted twice, because `stats.failures++` sat at each throw
  site *and* in the catch. `/api/status` read 2 failures from 1. Counted in one
  place now, and `lastError` is surfaced so a silent fallback stays diagnosable -
  which is the only reason the 429 was found at all rather than guessed at.

### Live verification

```
$ node apps/server/src/index.ts --env-file=.env
interpres listening on http://127.0.0.1:3030
  token: 120s window, 300s max session
  limits: 6/IP/hour, 400/day global

$ POST /api/mcp/connect {"url":"https://www.assemblyai.com/docs/mcp"}
transport: streamable-http | server: AssemblyAI | tools: 3 | cached: false
greeting: Connected to AssemblyAI, with 3 tools available. What would you like to do?
phase: search_assembly_ai, query_docs_filesystem_assembly_ai, submit_feedback | findTools: false
keyterms: 7 | transcription_prompt: 1036 chars
write tools flagged: submit_feedback

$ POST /api/mcp/call  (five calls in sequence)
[llm]              raw=24265 spoken=114 3616ms
[llm]              raw=19988 spoken=136 1725ms
[llm_failed_local] raw=16437 spoken=243 2395ms
[llm_failed_local] raw=21372 spoken=312 2397ms
[llm_failed_local] raw=30939 spoken=265 2367ms
shaper: {calls:5, failures:3, retries:3, avgMs:911, lastError:"llm gateway 429..."}
```

Every one of the five produced a speakable answer. The MCP client was also
verified against four live servers, and a real `tools/call` came back in 1.28 s:

```
ok   https://www.assemblyai.com/docs/mcp      streamable-http  AssemblyAI v1.0.0   3 tools
ok   https://afg.ai/mcp                       streamable-http  afg v0.1.0         15 tools
ok   https://advisorsai.ai/mcp                streamable-http  advisors-ai...      5 tools
ok   https://agentberg.ai/mcp                 streamable-http  agentberg v1.30.0  11 tools
FAIL https://127.0.0.1/mcp                    blocked_address
FAIL http://example.com/mcp                   bad_scheme
tools/call search_assembly_ai -> 23142 bytes in 1276ms
```

A failed tool call returns HTTP 200 with an error-shaped `tool.result`, not an
HTTP error: the agent needs something it can speak, or the turn simply stalls.
An unknown tool name gets told to call `find_tools`, which is the recovery the
docs recommend.

```
$ npm test
ℹ tests 204
ℹ pass 204
ℹ fail 0
```

**Still UNTESTED:** the WebSocket. No `session.ready`, no `tool.call` from a real
agent. Step 4 is the test.

---

## 2026-09-26 - step 4: `scripts/e2e.ts`, the loop proved over the wire

Opens a real Voice Agent session, registers a real MCP server's converted tools,
injects a user turn as text, and waits for a spoken answer that uses the tool
output. It takes the browser's path exactly - mint a token, connect with
`?token=` - rather than the `Authorization` header a Node client could use, so
what passes here is what the demo does.

### Three findings, each from a failed run

**1. My turn-completion logic ended the turn before the result was sent.**
First run: `tool.call` fired, then `reply.done` arrived while the tool was still
running, and the turn resolved with `AGENT: (nothing)`. The docs describe exactly
this ("Your tool may return *after* `reply.done` already fired. Call
`flushIfIdle()` from the `tool.call` handler"). Rewritten around two pieces of
state - `inFlight` for running handlers, `awaitingAnswer` for whether a
`tool.result` has gone out - with the flag read **before** the flush, since the
flush is what sets it. Both orderings now work: tool finishes before
`reply.done`, and tool finishes after.

**2. `conversation.message` alone does not steer tool arguments.** Asked "How
many tools can an agent have per phase?", the agent called
`search_assembly_ai({"query":"What is AssemblyAI?"})` - a query it invented. Two
runs confirmed it. The Aug 26 changelog says tool calls "infer argument values
only from user turns and tool results", and an injected `conversation.message`
does not appear to count. Passing the question as `reply.create.instructions` as
well fixed it immediately:

```
TOOL.CALL search_assembly_ai({"query":"How many tools can an agent have per phase?"})
```

This is a property of the **headless harness**, not of the product: in the
browser the person speaks and `transcript.user` is the user turn. Recorded
because anyone testing a Voice Agent from a script will hit it.

**3. Server `instructions` in the system prompt suppress tool calls.** The first
full run made **zero** tool calls against afg: asked "What is this service?", the
agent answered from the server's own `instructions`, which the prompt builder
puts in the system prompt. Good grounding, but it gives the agent an easy way to
skip the tool. The preset questions were rewritten to need a tool, and to need a
**hidden** one, which is what proves `find_tools`.

### find_tools, over the wire

`afg.ai` has 15 tools, so the opening phase is `find_tools` plus 9 and
`afg_about` is hidden. Asked for the official flow:

```
TOOL.CALL find_tools({"query":"official job flow and limits"})
-> session.update
PHASE -> find_tools, afg_about, afg_get_job, afg_post_job, afg_fund, afg_appeal,
         afg_dispute, afg_sign_contract, afg_submit, afg_prepare_signed_request
TOOL.CALL afg_about({})
RESULT  afg_about: 2524 chars raw -> 188 spoken [llm_failed_local] in 1196ms
AGENT: AFG is a sandbox marketplace where AI agents hire other AI agents to
       achieve verified outcomes, without humans in the loop.
```

The agent called a tool it could not reach one turn earlier. That is the whole
idea of the project, happening on a live session.

### Full run - CHECKPOINT A evidence

`node --env-file=.env scripts/e2e.ts --out data/e2e-checkpoint-a.json`

```
ok   https://www.assemblyai.com/docs/mcp
     session_id=sess_2d0a2ac965374eabace6c4cdda42d1d7 turns=2 tool_calls=2 replies=2
ok   https://afg.ai/mcp
     session_id=sess_06c5d355662c4b2ba5946a95935d19e5 turns=2 tool_calls=3 replies=2
ok   https://advisorsai.ai/mcp
     session_id=sess_6f5d5ea0c2e6488b8b1946fe4bf9b305 turns=2 tool_calls=2 replies=2

tool calls: 7/7 succeeded
```

Three MCP servers, three live sessions, 7 tool calls, 6 of 6 turns answered.
Shaping split 5 `llm` / 2 `llm_failed_local`, and both local results still
produced a clean spoken answer. MCP call latency 0.6-1.4 s; turn latency
10-22 s, most of it the agent's own reasoning and speech.

### One thing that did NOT work, stated plainly

Asked "What is the reputation of wallet 0x0000...0001?", the agent called
`find_tools`, had `afg_get_reputation` revealed, and then **asked the person for
the address** instead of calling it - although the address was in the question:

```
TOOL.CALL find_tools({"query":"get reputation for a wallet address"})
PHASE -> find_tools, afg_get_reputation, ...
AGENT: I can check the reputation for any wallet address ... Just let me know
       which address you're interested in.
```

It is the same root cause as finding 2: the address reached the session through
`conversation.message` and `reply.create.instructions`, and after the `find_tools`
round trip the agent no longer had it as a user turn to infer from. Conversational
recovery, not a crash - and asking again is the right behaviour when it does not
have the value. **UNTESTED** whether a spoken turn carries the argument through a
phase change; that needs CHECKPOINT B with a microphone, where the value arrives
as `transcript.user`. The e2e script cannot settle it.

---

## 2026-09-26 - CHECKPOINT A decisions, applied

Sergiu's review of CHECKPOINT A set four decisions. Each is applied below with
the output that proves it.

### 1. The legacy docs endpoint is gone from the tree

Preset #1 was already `https://www.assemblyai.com/docs/mcp`; the only remaining
mentions of the legacy endpoint were two lines of this log. They now describe it
without naming it, so the reasoning survives and nobody can copy the URL.

```
$ grep -c 'www.assemblyai.com/docs/mcp' BUILDLOG.md      # control: the grep works
8
$ grep -rIn '<legacy host>' . | grep -v node_modules
(no output) -> 0 references in the working tree
```

Git history still contains the two old lines. Rewriting public history was not
asked for, and would cost more than it saves.

### 4. Production logs cannot reach the repo, and no IP is ever logged

- `LOG_PATH` defaults to `data/raw/events.jsonl` when `NODE_ENV=production`, and
  to `data/events.jsonl` (the dev log) otherwise. `data/raw/` is gitignored:
  ```
  $ git check-ignore -v data/raw/events.jsonl
  .gitignore:13:data/raw/	data/raw/events.jsonl
  $ git check-ignore -v data/events.jsonl        # control: must NOT be ignored
  (exit 1) -> control ok
  ```
- No call site ever logged the client address, but "never" deserved enforcement
  rather than convention: an SSRF refusal says *"resolves to 10.0.0.5"*, and that
  message was going straight into `mcp.connect.failed`. `scrub()` now redacts
  every IPv4 and IPv6 literal at any depth, and drops keys that can only hold a
  client address (`ip`, `clientKey`, `remoteAddress`, ...) outright.
- The IPv6 matcher needs a `::` or the full eight groups. Without that rule,
  clock times like `09:32:34` read as addresses; a test pins that they survive,
  along with UUIDs and version strings.
- One ordering bug found by the tests: `clientKey` matched the secret-key rule
  first (it contains "Key") and was redacted to a length instead of dropped.
  The address never reached the file either way, but dropping is the stronger
  guarantee, so the drop rule now runs first.
- An API test sends `/api/token` with `cf-connecting-ip: 198.51.100.77` and then
  asserts the address is in neither `/api/status` nor the log file, **after**
  asserting the file is non-empty, so a log that was never written cannot pass.

```
$ node --test apps/server/test/logs.test.ts apps/server/test/api.test.ts
ℹ tests 19
ℹ pass 19
```

### 2. The Gateway is behind a circuit breaker and a hard 1.5 s deadline

`packages/core/src/shape.ts` now computes the local extractive answer **first**,
then races the Gateway against `REFINE_DEADLINE_MS = 1500`. Lose the race, fail,
or find the breaker open, and the local answer is sent. The server's shaper
aborts its fetch at the same 1.5 s, so a lost race releases its socket instead
of finishing in the background. After any 429, `CircuitBreaker` opens for 60 s
and `shaperAvailable()` returns false, so the Gateway is not called at all. The
old 700 ms retry-on-429 is gone: it contradicted the breaker and spent the budget.

Each shaped result now reports `refine`: `used`, `timeout`, `error`,
`circuit_open`, `no_shaper`, or `not_needed`, plus `refineMs`.

Tests pin the guarantees rather than the happy path:
- a Gateway that answers after 5 s is abandoned at a 60 ms deadline, and the call
  returns inside 210 ms with the local answer
- an open breaker means **zero** Gateway calls and no wait
- a Gateway that rejects after losing the race leaves no unhandled rejection
- one 429 trips the breaker; 400/500/503 do not
- the network call aborts near its own deadline instead of waiting 5 s

Live, six calls in a row through the real server:

```
method=llm    refine=used          refineMs= 853  total=3180ms
method=llm    refine=used          refineMs= 429  total=1789ms
method=local  refine=error         refineMs= 210  total=1577ms   <- the 429
method=local  refine=circuit_open  refineMs=   0  total=1343ms
method=local  refine=circuit_open  refineMs=   0  total=1296ms
method=local  refine=circuit_open  refineMs=   0  total=1288ms
gateway: calls=3 used=2 rateLimited=1 breakerOpen=true trips=1 secondsLeft=56
```

Six tool calls, three Gateway calls. Slowest refinement 853 ms, inside the
deadline. The README states which models this account reaches and that no reply
depends on the Gateway.

```
$ npm test
ℹ tests 225
ℹ pass 225
```

### 3. `scripts/e2e-audio.ts`: real speech is now the main proof path

**Main proof path: `scripts/e2e-audio.ts`.** Every question is spoken by macOS
`say -v Samantha`, converted with
`afconvert -f WAVE -d LEI16@24000 -c 1 --no-filler` (flags read off
`afconvert -h`), checked with `afinfo`, and streamed through `input.audio` in
40 ms / 1,920-byte chunks at real-time pace, followed by 1.5 s of silence.
**Fallback only: `scripts/e2e.ts`**, the text-injection harness, now labelled as
such in its header and output, because it gets argument inference wrong (below).

```
$ afinfo q.wav   (converted)
File type ID:   WAVE
Data format:     1 ch,  24000 Hz, Int16
bit rate: 384000 bits per second          # 24000 x 16 x 1: exact
RIFF chunk walk: "fmt " at 12 (PCM, 1 ch, 24000, 16-bit), "data" at 36
```

The WAV is parsed by walking its RIFF chunks, not by skipping 44 bytes; without
`--no-filler` afconvert inserts a page-alignment chunk before `data`. The pump
streams continuously like a live mic (silence when nothing is queued), anchored
to its start time, and re-anchors rather than bursting to catch up, since a burst
is exactly what `audio_rate_violation` rejects. Every run below: 0 re-anchors,
0 rate violations.

#### Shared state machine

The tool-call protocol moved into `packages/core/src/protocol.ts` (`AgentProtocol`).
The browser, `e2e.ts` and `e2e-audio.ts` all drive that one class through
`scripts/lib/session.ts`, so what the scripts prove is proved about the code the
browser runs. 11 offline tests replay the event orderings from the docs and from
the live runs. One found a real bug class: a tool result that finishes after its
reply was **interrupted** used to be delivered into the next turn. An epoch
counter now drops it.

#### The afg reputation case: does a spoken argument survive a phase change?

**Answer: yes, with real speech, with or without carrying.** The CHECKPOINT A
failure (agent asks for the address again) was an artifact of text injection.

| run | setup | find_tools | reputation called after swap | argument survived | exact |
|---|---|---|---|---|---|
| `afg-zeros` | CHECKPOINT A address, spoken | no | no | **no** - never recognised | no |
| `afg-address` | EIP-55 vector, char by char | no (tool visible) | direct call | yes | no |
| `afg-phase` carry OFF | start phase hides the tool (harness-set) | **yes** | **yes** | **yes** | no |
| `afg-phase` carry ON | same | yes | yes | yes | no |
| `afg-natural` | no harness help: turn 1 needs a hidden tool | **yes, twice, self-chosen** | **yes** | **yes** | no |

`afg-natural`, the strongest evidence (`data/e2e-audio-afg-natural.json`,
`sess_545bb78a858f41bebe3b5f6135b11524`):

```
SAY   I want to run a spec check on a job contract.
      TOOL.CALL find_tools({"query":"run a spec check on a job contract"})
      PHASE -> ... afg_speccheck ...            (afg_get_reputation swapped OUT)
      AGENT: Please provide the job contract you would like me to check.
SAY   Actually, first tell me the reputation of wallet 0 x 3 f 9 a 1 c ...
HEARD "... wallet 0x3f9a1c7e5b2d8f4a6ce09b3d7f1a5cad2b4d6f09."
      TOOL.CALL find_tools({"query":"get reputation of a wallet address"})
      PHASE -> find_tools, afg_get_reputation, ...
      TOOL.CALL afg_get_reputation({"address":"0x3f9a1c7e5b2d8f4a6ce09b3d7f1a5cad2b4d6f09"})
      AGENT: That wallet has no recorded history, with zero jobs as either a buyer or a provider.
```

#### What does NOT work: speech-to-text on spelled-out hex

The argument survives every phase change, but it is **wrong** in every run,
because it is already wrong when it is heard:

- `afg-zeros`: 39 zeros and a `1` became **~900 zeros** with no `1` - a
  repetition loop on identical tokens. The agent replied with nothing.
- `afg-address`: doubled letters merged (`5 a a e b` -> `5aeb`, `b e a e d` ->
  `bead`): 38 hex characters, which afg rejected as invalid.
- `afg-phase` / `afg-natural`: transposition and substitution
  (`6 c 0 e 9 b` -> `6ce09b`, `5 c 8 e 2 b` -> `5cad2b`) giving **40 characters -
  a valid-looking, different address**. afg answered confidently about a wallet
  nobody asked for. Identical audio produced the identical wrong value twice, so
  this is deterministic for that input, not noise.

Carrying cannot fix this: it carries the value as heard. What it does do is put
the heard values into the `find_tools` result (a documented argument-inference
source) and into `keyterms`/`transcription_prompt` for a repeat, and it
**refuses** anything longer than 66 characters, so the 900-zero garbage can
never be carried into keyterms. The fix for exactness is a product decision -
read-back confirmation of long identifiers, or letting the caller paste them -
and is flagged for Sergiu rather than built.

#### Full spoken suite, all presets (`data/e2e-audio-presets.json`)

```
ok   https://www.assemblyai.com/docs/mcp   sess_21d1ed7300ff482eac00c7b2e58358fa   2 turns, 2 tool calls
ok   https://afg.ai/mcp                    sess_0c192f37d80b4d5e988dfc441cc4022c   2 turns, 2 tool calls (1 find_tools)
ok   https://advisorsai.ai/mcp             sess_7afa10015afd46198788fcc811386574   2 turns, 2 tool calls
tool calls: 6 made, 6 returned a result; STT exact on all 6 natural-language questions
audio_rate_violations=0, reanchors=0 in every session
```

The afg preset's suggested questions no longer include a spoken address; the
first one ("I want to run a spec check on a job contract") is the one verified to
make the agent call `find_tools` on its own.

**Open measurement:** in every shaped call of that run the agent waited 1.1-2.4 s
after its transition phrase, and the Gateway accounted for 0.78-1.13 s of it.
The 1.5 s cap bounds that; it does not make it zero. Being measured properly next.

---

## 2026-09-26 - the Gateway, measured properly; and step 5: the web mic loop

### No transition phrase, ever: so the Gateway is off on the speech path

The README had claimed the Gateway's 1.5 s window "overlaps the agent's own
'let me check that' phrase". That was never measured, so it was measured.
`scripts/lib/session.ts` now records every agent reply (start, first audio, bytes
of audio) and, per tool call, the audio in the reply that carried the
`tool.call`. One run's full timeline:

```
speech ends            +0 ms
reply 0 starts       +629 ms   no audio, ever
tool.call           +1475 ms   (inside reply 0)
result ready        +3177 ms   <- MCP + shaping + Gateway: pure silence
answer first audio  +3874 ms
```

Across 20 tool-calling turns in four runs: **0 of 20** had any audio before our
result went out. The agent calls tools silently, so everything between
`tool.call` and `tool.result` is silence the caller hears. With refinement on,
the Gateway added 582-1,133 ms of it per refined call; median voice-to-voice
went from 4,476 ms (off) to 5,208 ms (on), same presets, same questions.

Sergiu's decision asked for two things that the measurement shows cannot both
hold: "the Gateway only refines" and "so it can never delay speech" / "the README
must state that speech never waits on the Gateway". The second is his stated
goal and the README cannot say something false, so **`SHAPER_REFINE` now
defaults to off**; the Gateway, breaker and 1.5 s deadline are one env var away.
Flagged at CHECKPOINT B. The README's unmeasured "overlaps" sentence is gone and
replaced with the numbers above.

**Tried and reverted: prompting for a transition phrase.** A system-prompt line
asking the agent to say "Let me check." before any tool call. Result over 6
spoken tool turns: 0 of 6 spoke before the call, time to first audio unchanged
(4,476 -> 4,570 ms median, noise), and one answer degenerated into just
"One moment." - said after the result instead of the answer. Reverted; the
reason is recorded in `prompt.ts` where the line would have gone.

### Docs discrepancy 14: `session.ended.audio_duration_seconds` is always null

The docs: "Total audio you streamed in. `null` if you streamed none." Measured
null on every session - including one where 7.08 s of real speech was streamed
and transcribed exactly ("Hello there, can you hear me?"). The field is not
populated; it cannot be used as proof that audio arrived. `transcript.user` can.

### `apps/web`: Vite 8, vanilla TypeScript, 20.6 KB of JS

- **Per-app prefixed entry** (`interpres-index.html`, CLAUDE.md rule 11). Vite 8
  swapped Rollup for Rolldown; the option is `build.rolldownOptions`, read off the
  installed `index.d.ts` (`rollupOptions` is a deprecated alias).
- **Same origin.** The Hono server serves `dist/`: `/` is the app, `/assets/*`
  are the hashed bundles and a missing one is a 404 (so a stale page is never
  handed HTML as JavaScript), `?url=` links load the app, and an unknown
  `/api/*` path is a JSON 404.
- **No innerHTML anywhere.** Tool names, descriptions and results come from
  arbitrary third-party MCP servers, and transcripts come from speech, so every
  string goes in through `textContent` via a small `h()` helper.
- **Audio written from scratch.** AssemblyAI's starter repo has no licence
  (`gh api repos/AssemblyAI/voice-agent-starter-js --jq .license` -> none), which
  makes its code all-rights-reserved, so none of it is copied into this MIT
  project. Only the published technique is reused: resample inside the
  worklets, play through a flushable ring buffer. Capture batches into fixed
  40 ms frames (25 socket messages a second instead of one per 128-sample render
  quantum).
- **The worklet code is unit-tested as shipped.** The worklet source strings run
  in a `node:vm` sandbox standing in for `AudioWorkletGlobalScope`. 16 tests:
  a 440 Hz tone must come out at 880 zero-crossings a second when captured at 16,
  24, 44.1 and 48 kHz and when played at 24, 44.1 and 48 kHz (a wrong resampling
  ratio reads 440 or 1,760), frames are exactly 960 samples, overdrive clips
  instead of wrapping, flush silences at once, an empty chunk cannot inject NaN,
  a full ring drops rather than overwrites, base64 round-trips exactly.

### Browser verification, in the desktop app's built-in Chromium

No microphone in the pane, so a synthetic one was injected for these checks only
(`getUserMedia` returning an oscillator stream). Everything else is the shipped
page against the live API.

```
greeting session   sess_11c9077bbc574f19a6dd7a87f8f4aa61
  session.update (the browser's own payload: greeting + input.format + voice)
  -> session.updated -> session.ready
  agent: "Connected to AssemblyAI, with 3 tools available. What would you like to do?"
         452 reply.audio chunks, 13 word deltas, 0 session.error, 0 console errors
  diag:  audio 24000 Hz in / 24000 Hz out (asked for 24000)   <- this Chromium honoured it
  stop:  session.end -> session.ended (24.09 s) -> "Session ended: ended by you."

capture check      sess_d9e78b4d58ac4569a457e533abb46977
  177 input.audio frames x 1,920 bytes = 7.08 s of audio in a ~7.5 s session

tool paths         (afg, text turns injected into the page's socket, test only)
  tool.call afg_contract_template -> page POST /api/mcp/call 200 1601 ms
     timeline: "afg_contract_template | 1586 ms · local"
  tool.call find_tools            -> page POST /api/mcp/find-tools 200 39 ms
     session.update sent; phase pane swapped; new chips marked:
     afg_post_job*, afg_speccheck*, afg_upload_artifact*
     agent: "I have the tools ready to run a spec check. Just give me the contract..."

mobile (375 x 812) scrollWidth 375 = viewport 375: no horizontal overflow
```

**Still UNTESTED, and only CHECKPOINT B can test it:** a human voice through a
real microphone in Brave; hearing the agent through speakers without it
interrupting itself (echo cancellation); a real barge-in; and whether Brave
honours the 24 kHz request (the footer's diag line will say, either way).

```
$ npm test          ℹ tests 252  ℹ pass 252  ℹ fail 0
$ npx tsc --noEmit  (clean)
$ npm run build     dist/interpres-index.html 5.0 kB, JS 20.6 kB (7.7 kB gzip), CSS 9.7 kB
```

---

## 2026-09-26 - CHECKPOINT B follow-ups (0a, 0b)

### Brave's sample rate: closed

Sergiu's live test in Brave: the footer read
`audio 24000 Hz in / 24000 Hz out (asked for 24000)`. Brave honours the 24 kHz
request in both directions; the worklets' resampling is not exercised there,
but is still unit-tested for 16/44.1/48 kHz browsers that do not.

### 0a. Did the agent hear itself through the speakers? No.

`scripts/session-history.ts` (new) reads a session back from Session History:
`GET /v1/sessions/{id}`, then the `timeline` artifact through its pre-signed URL
with no Authorization header. Sergiu's session
`sess_03f781a8d57c4ba98c3c6a16e92ef4d8` (108 s, laptop speakers, AdvisorsAI):

```
turn 0 greeting     completed  reply +0.36s..+5.10s   ttfa=332ms
turn 1 user_speech  completed  speech +6.72..+7.82    "What service do you have?"              -> advisors_catalog_list_services 812ms
turn 2 tool_result  completed  reply  ..+22.17s
turn 3 user_speech  completed  speech +23.62..+26.92  "I need an audit trail for my agents. Outfits."  -> advisors_catalog_match_service 679ms
turn 4 tool_result  completed  reply  ..+39.41s
turn 5 user_speech  completed  speech +44.62..+48.42  "I need check the basics. my site."   ttfa=3255ms (no tool)
turn 6 user_speech  completed  speech +57.62..+60.40  "okinimus.app"                          -> advisors_site_check_basics 3484ms
turn 7 tool_result  completed  reply  ..+73.69s
turn 8 user_speech  completed  speech +76.12..+81.20  "You have to swap K with CH."           -> advisors_site_check_basics 5186ms
turn 9 tool_result  completed  reply  ..+100.73s
interrupted turns: 0; interrupted_at_ms: null in all 10; user speech starting inside a known agent reply: 0
```

Every user utterance began after the preceding agent reply had ended (by
1.4-5.2 s). No reply was cut, so the agent never interrupted itself.

Reported exactly as the API returns it: for `tool_result` turns the timeline
gives `agent_reply_ended_at_ms` only - `agent_reply_started_at_ms` and
`time_to_first_audio_ms` are null. Time to first audio is therefore measurable
only on the greeting (332 ms) and the one tool-free turn (3,255 ms). Two
recognition errors are visible in the transcripts: "what fits" became "Outfits",
and "ochinimus.app" became "okinimus.app" - so mishearing is not limited to hex;
it hits any word the recogniser does not know.

### 0b. Barge-in without a human

`scripts/e2e-audio.ts --case barge-in`. The AFG template question produces a long
answer; 1.5 s after that answer's first `reply.audio` chunk, a second utterance -
"Stop, just tell me the price." - starts streaming through the same continuous
mic. `AgentProtocol` gained an `onDropped` hook, so a result dropped by the epoch
check is counted rather than discarded silently.

**First run** (`data/e2e-audio-bargein.json`, `sess_b3d6adc6f2594c948f817e73f900cb2b`):

```
answer audio played : 2770 ms before the cut; interrupted text: "The contract template for a passing test suite uses the"
interruption heard  : ["Stop, just tell me the price."]
cut latency         : 1170 ms from the interruption's first audio chunk to reply.done(interrupted)
after the cut       : "I'm sorry, but I don't have any information about a price. I haven't seen a
                       price mentioned in our conversation or in any tool results."
template price      : 40
PASS replyDoneInterrupted   PASS flushHookFired   FAIL nextAnswerCarriesPrice
```

**The defect it found: shaping threw the price away.** The local shaper turned a
33,607-character template into a 241-character summary aimed at the first
question; `price.amount` was not in it, so the agent had never seen a price - and
the anti-fabrication clause, working as designed, stopped it inventing one.

**Fix:** a shaped result now carries a bounded `facts` object beside the spoken
summary - the JSON's scalar leaves, shallowest first, at most 1,500 characters,
blobs and long strings skipped (`extractFacts` in `packages/core/src/shape.ts`).
The system prompt says to use `facts` for follow-ups and never read it out.

**After** (`data/e2e-audio-bargein-facts.json`, `sess_572712169f594470999191b96918affb`):

```
answer audio played : 2750 ms before the cut; interrupted text: "For a passing test suite, the contract uses a command"
interruption heard  : ["Stop, just tell me the price."]
cut latency         : 1145 ms
after the cut       : "The price is forty dollars in USDC."
PASS replyDoneInterrupted   PASS flushHookFired   PASS nextAnswerCarriesPrice
N/A  lateResultDroppedByEpoch (no tool call was in flight at the cut)
```

**The epoch assertion is structurally unreachable live**, and the reason is a
measured one: the agent speaks only after its tool result is sent (0 of 20 turns
had audio before a tool call), so when the caller cuts into an answer there is no
tool in flight for the epoch check to drop - `toolsInFlightAtCut=0` in both runs.
It is covered offline: `protocol.test.ts` "an interruption drops pending results
and ends the turn" and the new "a result dropped by the epoch check is reported
through onDropped".

The speaker-echo question stays with 0a above: this test proves the protocol
path, not acoustic echo cancellation.

### 0c. Keyterm quality: 21 junk-laden terms to 7

Sergiu's key-terms pane for AdvisorsAI showed 21 terms, several useless or worse:
`https://example.com`, `ar`, `en`, `store-audit.first-audit`, and plain English
(`check`, `site`, `match`, `link`, `order`, `service`, `services`). The docs agree
they should not be there: "Don't add common English words. Each entry boosts that
string, and adding common words at the same weight as your rare terms dilutes the
boost." Re-reading the streaming keyterm page added two limits the builder never
enforced: **each keyterm must be 50 characters or less - longer ones are silently
ignored** - and "Don't add whole sentences or phrases."

`speechForm()` in `packages/core/src/keyterms.ts` now decides every candidate:

- dropped: URLs, placeholder hosts (`example.com/.org/.net`), emails, dotted or
  slashed IDs, hex and base58 strings, anything of 2 characters or fewer, a
  single common English word (or its plural/inflection), phrases over 3 words,
  anything over 50 characters;
- slugs of alphabetic parts are written as speech-to-text writes them:
  `store-assistant` -> `store assistant`, `ai-visibility` -> `AI visibility`;
- brand tokens from the server's own name are kept verbatim. The old builder
  split `AssemblyAI` into `assembly` + `ai` - destroying the exact string the docs
  use as their keyterm example - and a lowercase fragment of a kept brand is no
  longer repeated.

The common-word list is bundled in `packages/core/src/common-words.ts`: 976 words,
the most frequent English plus everyday tool-name vocabulary. A test asserts it
actually loads (>= 500 words), that Sergiu's junk words are in it, and that
`navigator`, `advisors`, `AssemblyAI`, `speccheck` and `Ozempic` are not.

Before and after, same catalogs:

| server | before | after |
|---|---|---|
| AdvisorsAI | 21 | **7**: store assistant, store audit, AI visibility, custom monitor, agent team, advisors, navigator |
| AssemblyAI docs | 7 | **3**: AssemblyAI, filesystem, feedback |
| AFG | 24 | **9**: schema valid, AFG, fulfillment, guarantee, sandbox, reputation, dispute, appeal, wallet |

Every junk term Sergiu listed is gone; the server name (`advisors`, `navigator`)
and all five product names survive. Sergiu's 21 terms are frozen in
`keyterms.test.ts` as the fixture, and every fixture's keyterms are checked
against the documented limits (<= 50 chars, <= 3 words, no URL or path).

```
$ node --test packages/core/test/keyterms.test.ts    ℹ tests 20  ℹ pass 20
$ npm test                                            ℹ tests 272 ℹ pass 272
```

---

## 2026-09-26 - task 1: the registry sweep (code; results follow)

`scripts/sweep.ts` pages the official registry
(`/v0/servers?limit=100`, `nextCursor`), keeps servers with `streamable-http` or
`sse` remotes, and probes each with the **product's own `probeServer`** - so an
`ok` means "paste this URL into interpres and it works" - through the same SSRF
guard. `initialize` + `tools/list` only; no tool is ever called. Every request
carries `User-Agent: interpres-sweep/0.1 (+https://github.com/seekdaseek/interpres)`.
Concurrency 8, 8 s timeout, and at most 2 probes in flight per host, because
some hosts serve dozens of registry entries.

The registry is far larger than one page suggested. Measured census:
**119,860 entries, 36,247 unique servers, 22,214 with remotes** (21,678
streamable-http + 1,098 sse remote URLs; 231 templated URLs; 3,358 that declare a
required or secret header). Consequences built in:

- **Versions deduped by name**, keeping the `isLatest` entry - the registry lists
  every published version, and counting them would inflate every total.
- **Output split**: the full record with the raw `tools/list` of every `ok` server
  is gzipped (`data/sweep-<stamp>Z.json.gz`), beside a readable summary JSON
  without the raw catalogs. Tasks 2 and 6 read the gzip; nothing is re-probed.
- **Recheck mode** for the two-sweep rule: `--recheck <sweep>` re-probes every
  server that was `ok`, each no sooner than 60 minutes after **its own** first
  probe, so the gap holds per server rather than on average.
- Templated URLs (`{...}`) are recorded as `unreachable / url_template`, not probed.
- Every attempt records a short measured reason code: `http_401`, `dns`,
  `refused`, `timeout`, `tls`, `http_404`, `jsonrpc_method_not_found`,
  `not_mcp_response`, `ssrf_blocked_address` and so on.

Three fixes to the probe path that the sweep forced, all of which the product
now gets too:

1. **A failed connect now closes its transport.** Before, an SSE `EventSource`
   left open after a failed handshake could keep reconnecting in the background.
2. **The SSE fallback is skipped when it cannot change the outcome** - after an
   auth refusal, a timeout, DNS failure, refused connection or TLS error. Same
   host, same answer; trying doubled the wait on every dead URL. It is still tried
   after an HTTP-level rejection of the POST, which is what an SSE-only server
   returns.
3. **DNS lookups time out at 5 s**, and errors now carry undici's `cause` chain -
   a bare "fetch failed" becomes `fetch failed <- getaddrinfo ENOTFOUND host`.

Calibration on the first 300 servers: registry collected in 222 s, 300 probes in
35 s (ok 123, auth_required 111, protocol_error 42, unreachable 24). It also
found an output bug - `mkdir('data')` did not create the `--out` path's own
directory - fixed. 6 offline tests cover the cause chain, the fallback decision
and the reason codes.

---

## 2026-09-26 - task 2: the confirmation gate and the paste box

One mechanism with two triggers, as a pure class in `packages/core/src/gate.ts`
(`ToolGate`; the clock is passed in, no I/O). Every executor calls it before any
MCP request: the browser (`apps/web/src/voice.ts`), and both proof scripts through
`scripts/lib/session.ts`. A held call makes no request and returns
`{"status":"needs_confirmation", "heard": ..., "say": ...}`; the page shows a
confirm card rendered through the `textContent` helper.

**One deliberate deviation from the spec's classifier wording.** "After removing
internal spaces, ... any run of 16 or more characters ... with at least 3 digits
and 3 letters" - applied to a whole argument - flags ordinary sentences:
"the tests failed 3 times on run 42" collapses to 27 characters with 4 digits, yet
"a plain sentence" is one of the spec's own negatives. So only *spelled-out* runs
are collapsed (4+ single characters, or 4+ short hex groups), and each token is
classified separately. Every listed positive and negative still holds (test 1).

**Two holes the tests found, fixed:**
- **Echo laundering.** A tool that echoes its argument - afg's reputation lookup
  does - put a misheard, once-confirmed address into "an earlier tool result",
  and the next identical call ran unasked. Results are now recorded with their own
  identifier arguments stripped out.
- **The paste result stopped the agent.** In the browser, with the bare text
  returned, the agent read the box and then asked "what would you like to know
  about it?" The result now carries the next step. In the spoken run afterwards it
  chained `use_pasted_text` -> `afg_get_reputation` without prompting.

**Phases.** Every phase now holds `use_pasted_text`. A catalog of 9 or fewer is
shown whole beside it; above that, `find_tools` + `use_pasted_text` + 8. (Keeping
the logged CHECKPOINT A deviation: no `find_tools` when nothing is hidden.)

**Write classifier on AFG's real 15 tools: 15/15 agreement** with the hand-written
`writeTools` list - and still 15/15 with every annotation stripped, name rule only.
Disagreements: none. `isWriteTool` in the connect payload now comes from the
classifier, so arbitrary pasted servers get the warning too.

### Acceptance 1-3: core and protocol level

```
$ node --test packages/core/test/gate.test.ts
✔ known positives are identifier-shaped
✔ known negatives are not
✔ digit-only strings are out of scope, as the README says
✔ spelled-out speech is collapsed back into the value
✔ hex compares case-insensitively; base58 exactly
✔ destructiveHint and write-verb names are writes
✔ read verbs are not writes
✔ readOnlyHint wins over a write-looking name; destructiveHint wins over everything
✔ a prefix every tool shares is stripped first
✔ AFG's real 15 tools: the classifier agrees with the hand-written list, with and without annotations
✔ a spoken identifier is gated with zero requests; an identical repeat after yes makes exactly one
✔ a changed repeat is gated again, even after a yes
✔ a no, or a yes outside the window, does not release the call
✔ a pasted value passes straight through, exactly
✔ an identifier from an earlier tool result passes through
✔ a state-changing tool is gated, names what it will do, and runs once after yes
✔ a read-only tool with plain arguments is never gated
✔ the original schema pattern is enforced before any request
✔ the call key ignores hex case and speech spacing, so a re-cased repeat still matches
✔ affirmatives and negatives
✔ grouping and the paste tool result
✔ a tool that echoes its argument does not launder a misheard value
ℹ tests 22
ℹ pass 22
ℹ fail 0
```

The protocol tests run a real `AgentProtocol` with the gate in front and a fake
MCP transport that only counts requests.

### Acceptance 4: real speech (e2e-audio)

`--case gate-spoken` (`data/e2e-audio-gate-spoken.json`, `sess_c7ecda9ca1ca4a3f8eebfb18378bd139`):

```
SAY   What is the reputation of wallet 0 x 3 f 9 a 1 c ... 6 f 0 9?
HEARD "What is the reputation of wallet 0x3f9a1c7e5b2d8f4a6c0e9b3d7f1a5cad2b4d6f09?"
      TOOL.CALL afg_get_reputation({"address":"0x3f9a1c7e5b2d8f4a6c0e9b3d7f1a5cad2b4d6f09"})
      GATE confirm (identifier): I heard a value ending in 6 F 0 9. Check it on screen: ...
SAY   Yes, that's right.
      TOOL.CALL afg_get_reputation({...same...})  ->  RESULT mcp=1164ms
MCP requests: after turn 1 = 0, after turn 2 = 1
PASS turn1Gated   PASS turn1ZeroMcpCalls   PASS turn2ExactlyOne
```

The value that ran was still misheard (`5 c 8 e` -> `5cad`, the same error as every
earlier run of this address); its last four characters were right. The gate did
exactly what the spec says, and the run shows its limit: a voice "yes" to the last
four does not verify the middle. The card shows the whole value; the paste box is
the robust path. Flagged for Sergiu.

`--case gate-paste` (`data/e2e-audio-gate-paste.json`, `sess_a8124ef3931d4db29020c227d0aebe4e`):

```
SAY   Check the reputation of the wallet I pasted.
      TOOL.CALL use_pasted_text({})  ->  PASTE 42 chars
      TOOL.CALL afg_get_reputation({"address":"0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"})
pasted          sha256 = e066de5176c4f671c4d01441f2c9a6d8dcb4098b770f90b96f5bb2ce21b925cc
sent to server  sha256 = e066de5176c4f671c4d01441f2c9a6d8dcb4098b770f90b96f5bb2ce21b925cc
server response : {"ok":true,...,"result":{"address":"0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",...
PASS usedPasteTool  PASS reachedTheTool  PASS sha256Matches  PASS serverEchoedTheExactValue  PASS notGated
```

### The person's own words become keyterms: the "ochinimus" A/B

Pasted text's speakable word parts (letters only, 4+, never hex or base58, never a
common word) go into `input.keyterms` via `session.update`, marked "yours" in the
key-terms pane. `--case ochinimus-ab`, said: "Check ochinimus dot app.", AdvisorsAI:

```
WITH keyterm     sess_f5d1ecbd29bc44f8bd1000e31258cdce  heard: ["Check ochinimus.app."]
WITH keyterm     sess_9e26b21330564db5b3b68c8c65036c69  heard: ["Check ochinimus.app."]
WITH keyterm     sess_debb391ad86b4e10a3ca4893305b5c81  heard: ["Check ochinimus.app."]
WITHOUT keyterm  sess_dca021bae2074e9c9b4163b332c9ba3d  heard: ["Check aginimus.app."]
WITHOUT keyterm  sess_5096d3fc6b784aa58bf374fa5369e718  heard: ["Check aginimus.app."]
WITHOUT keyterm  sess_dcb13300d5e24a74b037cb79e17094f0  heard: ["Check aginimus.app."]
"ochinimus" spelled right: with 3/3, without 0/3
```

Same synthetic audio in all six, so this isolates the keyterm. It is no longer
UNTESTED; whether it holds for Sergiu's own voice is still his to try.

### Acceptance 5: browser (the desktop app's Chromium, against the live API)

- **The confirm card renders.** An address given in the question (test-only text
  injection) made the agent call `afg_get_reputation`; the page made **0**
  `/api/mcp/call` requests, sent `needs_confirmation`, the agent spoke "I heard a
  value ending in 6 F 0 9 ...", and the card showed
  `0x3f 9a1c 7e5b 2d8f 4a6c e09b 3d7f 1a5c ad2b 4d6f 09`.
- **No horizontal overflow at 375 px, with the card showing:** scrollWidth 375 =
  viewport 375, no overflowing elements, card right edge at 359 px.
- **Console errors: none**, across both runs.

```
$ npm test          ℹ tests 296  ℹ pass 296  ℹ fail 0
$ npm run build     JS 36.2 kB (14.1 kB gzip), CSS 11.7 kB
```

---

## 2026-09-26 - task 3: `npm test` is hermetic

Sergiu's fresh clone of `a9a86be` under Node 22.22 with no egress passed 247 of
252. Six tests touch the network, not five: the four `api.test.ts` MCP calls he
named, the public-host fetch in `ssrf.test.ts`, and a DNS-only lookup of a public
host in the same file (which passes where DNS works and TCP does not - likely why
it did not fail for him). All six now live in `api.live.ts` and `ssrf.live.ts`,
which the `*.test.ts` glob does not match, behind `npm run test:live`.

Two more reached AssemblyAI's token endpoint through the server. They passed
offline because a 502 was an accepted answer, but against a firewall that drops
rather than refuses they would have waited on connect timeouts. Their upstream is
now a closed local port (`AGENTS_API=http://127.0.0.1:9`), so they fail fast
everywhere. Moving the live tests also exposed a race: "a client address is never
written to the event log" had only passed because earlier live tests had already
written lines; it now waits up to 2 s for the async append instead of reading once.

Proved with macOS `sandbox-exec -p '(version 1)(allow default)(deny network-outbound)'`,
controls first:

```
control 1: curl inside the sandbox        -> curl: (6) Could not resolve host: example.com
control 2: npm run test:live, sandboxed   -> ℹ tests 6    ℹ pass 0    ℹ fail 6
           npm test, sandboxed            -> ℹ tests 290  ℹ pass 290  ℹ fail 0   (7 s)
           npm test, three runs unsandboxed: 290/290 each
           npm run test:live, unsandboxed -> ℹ tests 6    ℹ pass 6
```

UNTESTED here: Node 22.22 specifically - only Node 24.16 is installed on this Mac.
The test is Sergiu's fresh-clone run again.

---

## 2026-09-26 - deploy prep: three problems found while writing the CHECKPOINT C plan

Nothing on the VPS was changed. The only box commands were read-only (`ss`,
`pgrep`, `/proc/<pid>/status`, file names under `/root/.cloudflared`).

**1. Under PM2 the server would never have listened.** index.ts starts only when
`import.meta.url === file://argv[1]`. PM2's fork mode runs
`node <pm2>/lib/ProcessContainerFork.js` and `import()`s the script from there
(read in the pm2 7.0.1 tarball, the version on the box), so argv[1] is PM2's
file. Replayed through that exact container file (`pmx=false` skips only its
metrics module, whose `debug` dependency is not in the tarball; the argv and
import path are untouched):

```
index.ts via ProcessContainerFork.js  -> exit=0 after 1s, nothing printed   (PM2 restarts that forever)
serve.ts via ProcessContainerFork.js  -> interpres listening on http://127.0.0.1:3099
  200 application/json /api/health    200 text/html /    200 application/json /api/presets
  404 text/plain /assets/does-not-exist.js    404 application/json /api/nope
  listener: node 127.0.0.1:3099       still serving at 15 s (gtimeout exit 124)
```

Fix: index.ts exports `start()`; `apps/server/src/serve.ts` calls it; `node
apps/server/src/index.ts` still works for dev. PM2 also maps `.ts` to **bun** by
default (`lib/API/interpreter.json`), so `ops/ecosystem.config.cjs` sets
`interpreter: 'node'` - the same shape visum-demo runs on the box today.
`test/entry.test.ts` imports both entries the way PM2 does: serve.ts must bind,
index.ts must stay silent and exit 0 (the negative control).

**2. `/api/status` would have published visitors' MCP URLs and what they said.**
Its `recent` tail carried the full `url` of every connect and the `query` of
every find_tools. Some MCP URLs hold a key in the path (Zapier's
`/api/mcp/s/<key>/mcp`). `publicEvent()` is now a whitelist: the host instead of
the URL, no query, no free-text error, and any field added later stays private
until listed. The on-disk log is unchanged (gitignored, on the box only).

**3. The brief's tunnel steps would have taken down every tunnel on the box.**
- cloudflared 2026.9.3 (commit 96d39ad, the box's version):
  `cmd/cloudflared/tunnel/signal.go` registers SIGTERM and SIGINT only; no
  non-vendored file mentions SIGHUP.
- Go 1.26 runtime: `sigtab_linux_generic.go` gives SIGHUP `_SigNotify +
  _SigKill`, so an un-notified SIGHUP calls `dieFromSignal`. It survives only if
  SIGHUP was ignored at start.
- On the box, all four cloudflared processes (solquest-api, cassum, overhang,
  visum) show `hup_ignored=0 hup_caught=1` in `/proc/<pid>/status`.
- So `pkill -HUP -x cloudflared` ends all four, and PM2 then cycles
  solquest-api-tunnel. The brief forbids that, and cassum-tunnel is protected.
- And it would not even load the new ingress: config.yml is read only at
  startup. The config watcher runs only for a bare `cloudflared` invocation
  (`handleServiceMode` in main.go), and `tunnel run` never takes that path.

Instead: a dedicated tunnel, as cassum, overhang and visum already use
(`ops/interpres-tunnel.yml`, PM2 `interpres-tunnel`). DNS is routed by UUID with
`--overwrite-dns`, because `route dns <name>` has twice bound the record to
solquest-api's UUID on this box.

```
$ npm test                         ℹ tests 295  ℹ pass 295  ℹ fail 0
$ sandbox-exec (deny outbound)     ℹ tests 295  ℹ pass 295  ℹ fail 0   (control curl: Could not resolve host)
$ npm run typecheck                exit 0
```

UNTESTED:
- Node 22.23.1, the box's runtime. Only Node 24.16 is on this Mac, so the first
  deploy step is a scratch boot on the box.
- `ingress validate` for interpres.yml. There is no cloudflared on this Mac; it
  runs on the box before anything goes live.

---

## 2026-09-26 - the error classifier read numbers out of response bodies

Sweep A's failure reasons included `http_100`, `http_120`, `http_222` and
`http_348`, which are not real statuses. The cause: the MCP SDK's
`StreamableHTTPError` keeps the HTTP status on `.code`, a number, and puts only
the response body in the message (`Streamable HTTP error: Error POSTing to
endpoint: <body>`). `describeError` appended string codes only, so the status
was lost. `classifyError` and the sweep's `reasonFor` then matched bare numbers
anywhere in the text.

- A challenge page styled with `font-weight:500` counted as a 5xx.
- An empty-bodied 401 had no words to match, so it became a protocol error.

The old tests passed because they used a message format the SDK never produces
(`"Error POSTing to endpoint (HTTP 401): ..."`). On the new test's 400 whose CSS
holds 500, the old code returns `unreachable` / `http_500`.

**Fix:**
- `describeError` keeps a numeric code as `[HTTP nnn]`.
- `httpStatus()` reads it back.
- The status decides first: 401/402/403 is `auth_required`, with 402 counted as
  a payment wall because interpres never pays. 404/405/408/410/429 and 5xx are
  `unreachable`.
- After that only words decide, never a bare number.
- `reasonFor` uses the same recorded status.
- SSE fallback is unchanged: a real 405 still falls back (new test).

New tests use the SDK's own error class. The SDK layer is otherwise untouched.

```
$ node --test apps/server/test/probe.test.ts   ℹ tests 10  ℹ pass 10
$ npm test                                      ℹ tests 299 ℹ pass 299 ℹ fail 0
$ npm run typecheck                             exit 0
```

This does not affect sweep A's `ok` count: `ok` means `initialize` and
`tools/list` completed, and that path never runs the classifier. A's 10,205
failures are being probed again with the fix (`--recheck-classes
auth_required,unreachable,protocol_error --min-gap-minutes 0`, sweep.ts's new
option). The corrected split goes in the task 1 results.

---

## 2026-09-26 - the public demo's daily cap, set where it can be seen

The brief gives the token route a per-IP limit (6 an hour) and "a global daily
cap" with no number. The code default was 400. At the 300 s session cap and
$4.50/hr, one session costs at most $0.375, so 400 a day could spend $150 - the
whole credit - in one UTC day.

`ops/ecosystem.config.cjs` now sets `RATE_GLOBAL_DAY=100`, a worst case of
$37.50 a day. Typical use is far lower: 49 sessions so far averaged 38 s, about
$0.05 each. `MAX_SESSION_SECONDS` and `RATE_PER_IP_HOUR` are set there too, so
all three are visible in one place. The windows are fixed (UTC hour, UTC day)
and in memory, so a `pm2 delete` + `start` resets them. The number is Sergiu's
call at CHECKPOINT C.

---

## 2026-09-26 - task 1 results: the registry sweep, measured three ways

Three runs of `scripts/sweep.ts`, one User-Agent
(`interpres-sweep/0.1 (+https://github.com/seekdaseek/interpres)`), 8 at once,
at most 2 per host, 8 s timeout, `initialize` + `tools/list` only. No tool was
called and no credential was sent.

| run | what | when (UTC) | servers |
|---|---|---|---|
| A | the whole registry | 11:48:21 - 12:32:10 (2,629 s) | 22,217 |
| C | A's failures again, with the fixed classifier, no gap | 12:38:07 - 12:50:52 (765 s) | 10,205 |
| B | A's `ok` servers again, each >= 60 min after its A probe | 12:52:04 - 13:32:12 (2,408 s) | 12,012 |

B was started once at 12:32 on the old classifier, stopped at 12:52 after about
four minutes of probing, and restarted on the fixed code. Its gaps are measured
from A, so the restart cost no time. The aborted log is kept as
`data/raw/sweep-B-oldcode-aborted.log`.

**Headline (A):**
- 119,873 registry entries, 36,251 unique servers, 22,217 with a streamable-http
  or sse remote, on 14,675 hosts.
- **12,012 `ok`** (54.1%): they listed their tools without auth, from 7,347
  distinct hosts.
- 202,191 tools. **Every one converted** (0 failures); 36,059 (17.8%) carry
  spoken-format hints.
- 5,474 `ok` servers (45.6%) have more than 10 tools, so find_tools engages for
  nearly half the registry. Tools per server: median 9, 90th percentile 31,
  maximum 627.
- Transport: streamable-http 11,969, sse 43.
- Annotations: 66,602 tools have `readOnlyHint`, 4,688 have `destructiveHint`,
  and 5,983 servers carry at least one of them.

**Failures, re-measured (C):**
- `auth_required` 5,299: 5,038 were real 401s, 174 were 402 payment walls.
- `unreachable` 4,416. Of these, 1,305 are 429s from one host,
  `gateway.pipeworx.io`, rate-limiting the sweep; it answered 371 of its 1,710
  entries in A. 1,027 are 404s, led by dead mass hosts (`api.m2mcent.com` 276,
  `server.smithery.ai` 190).
- `protocol_error` 344, where the first pass said 2,692. The difference is the
  classifier bug.
- 146 failed in A and answered in C.

**Stability (B):** 11,578 of 12,012 still `ok` 60-61 minutes
later (96.4%). 370 of the 434 drops are `gateway.pipeworx.io` answering 429 to
this sweep, which is rate-limiting, not failing. Without that host, 11,577 of
11,641 held (**99.5%**). The other drops are 19 timeouts, 18 refused (12 of them
on `tooloracle.io`), 15 5xx and 2 404s.

**Presets from the sweep:** three, added to `apps/server/src/presets.ts`. The
filter was: `ok` in A and B, no declared auth, 2-40 tools, 0 conversion
failures, no host with more than 3 entries, at most one write-classified tool.
That left 4,845 servers. From those, general-interest ones were chosen by hand,
and each suggested question was then spoken through `e2e-audio`:

| preset | A -> B (UTC) | asked | tool calls | voice-to-voice | session |
|---|---|---|---|---|---|
| Most Recommended Books | 12:03:14 -> 13:03:16 | "What books does Bill Gates recommend?" | get_person_recommendations | 2,766 ms | sess_4e6cc252c2cb4754adec545d0a36824f |
| | | "What is the reading order for the Dune series?" | get_series_reading_order | 4,035 ms | same |
| Recipes Daily | 12:04:38 -> 13:04:38 | "What can I cook with chicken, rice and spinach?" | find_recipes_by_ingredients, show_recipes | 4,700 ms | sess_4e52b65cfa624609ac476f193dcb0bf2 |
| US weather and earthquakes | 11:59:54 -> 12:59:55 | "Are there any weather alerts in Florida right now?" | weather_alerts | 3,418 ms | sess_881bbf9500f44fb59336c7d231aaf7a2 |
| | | "Were there any earthquakes above magnitude five in the last week?" | earthquakes | 3,938 ms | sess_e19fc82bc077400ab8562205b4f99ae2 |

Two questions were tested and left out:
- "What's the weather forecast for Chicago tomorrow?" worked, but chained
  `geocode`, which took 9,339 ms: 14.1 s of silence.
- "Find me a quick vegetarian pasta recipe." got an honest "no match" from the
  server itself.

In the browser at 375 px, all six presets render with no horizontal overflow
(scrollWidth 375) and no console errors. Clicking Most Recommended Books
connected: 7 of 10 tools, one phase.

**What is committed:**
- The three runs' summaries, gzipped (`data/sweep-*-summary.json.gz`).
- `docs/SWEEP.md`.
- `docs/sweep-servers.csv`: one row per probed server, 22,217 rows.

The raw catalogs stay out of git (`.gitignore`): 47 MB gzipped for A, holding
every `tools/list`. Rendering from the committed summaries was checked to give
the same SWEEP.md and a byte-identical CSV.

A per-server Markdown table was tried first: 7,686 rows, 728 KB, unreadable. The
CSV replaces it, and SWEEP.md says so.

---

## 2026-09-26 - CHECKPOINT C go: the ecosystem gets a tighter memory cap

Sergiu's go approved the dedicated tunnel, the 100/day cap and port 3031, and
asked for `max_memory_restart: '250M'` on `interpres`. The box has about 1 GB
free (999 MB available, 1,717 of 2,047 MB swap in use at 13:46 UTC per his
solwatch check), so a leak here must be recycled before it can starve the
protected services. Committed before shipping, so HEAD is what runs.

---

## 2026-09-26 - step 9: deployed to interpres.ochinimus.app

Shipped HEAD `bea7324`, following the CHECKPOINT C plan and Sergiu's go
(`~/Desktop/interpres-checkpoint-C.md`). The dedicated tunnel replaced the
config.yml edit and SIGHUP. No signal was sent to any existing cloudflared, and
no process other than `interpres` and `interpres-tunnel` was started, stopped or
edited.

```
step 0  3031 free, 3032 free; /opt/interpres and interpres.yml absent; no tunnel named interpres
        free -m before: available 1961 MB, swap 1700/2047 MB; PM2: 43 processes
step 1  git archive HEAD (+ dist, no macOS metadata) -> /opt/interpres: 36 files
        npm ci --omit=dev: hono 4.13.9, @hono/node-server 2.1.1, MCP SDK 1.30.1, undici 8.11.2; no vite, no typescript
step 2  .env: 52 bytes, mode 600 root (value never printed)
step 3  scratch boot, node v22.23.1, 127.0.0.1:3032:
        200 /api/health   200 6108B /   presets: 6   token minted, length 2462 (value never printed)
        no warning in its log; afterwards 3032 free, no serve.ts process left
step 4  pm2 interpres: pid 3618430, online, 0 restarts, serve.ts via node --env-file, max_memory_restart 250M
        listener 127.0.0.1:3031 only (no 0.0.0.0 or [::] bind); log: "limits: 6/IP/hour, 100/day global"
step 5  tunnel interpres e2f8f68d-3423-4e88-9132-f12d9e995a65, credentials mode 400
        ingress validate: OK; ingress rule https://interpres.ochinimus.app: Matched rule #0 -> http://127.0.0.1:3031
        route dns --overwrite-dns <UUID>: "Added CNAME interpres.ochinimus.app ... tunnelID=e2f8f68d-..." (the right tunnel)
        pm2 interpres-tunnel: pid 3618535; 4 edge connections (fra19, prg01, fra18, prg01)
        /root/.cloudflared/config.yml untouched (mtime 2026-09-08)
step 6  from the VPS and from the Mac, identical:
          200 https://interpres.ochinimus.app/        200 https://interpres.ochinimus.app/api/health
          200 https://x402.ochinimus.app/             405 https://mcp.ochinimus.app/mcp (405 before too)
          200 https://alibi.ochinimus.app             200 https://nomen.ochinimus.app/health
        PM2 diff, before -> after: exactly two new rows; every other process kept its pid and restart count
          > interpres 3618430 0 online
          > interpres-tunnel 3618535 0 online
        free -m after: available 1888 MB, swap 1694/2047 MB; RSS interpres 102.3 MB, interpres-tunnel 39.9 MB
```

**End to end through the public URL:**
- `POST /api/mcp/connect` on Most Recommended Books: 6 tools.
- `POST /api/mcp/call get_series_reading_order {"series":"Dune"}`: no error, mcp 826 ms, "Dune - 6 books in publication order: ...".
- `GET /api/token`: minted (length only).
- In a browser at the public URL: `/api/presets` 200, connect 200, "7 of 10" tools shown, no console errors. The response carries no CSP header, so nothing blocks the Voice Agent WebSocket.

UNTESTED: a spoken session through the public URL, which needs a microphone.
That is Sergiu's device test, on his phone and on the Mac.

---

## 2026-09-26 - A: identifiers heard by speech are never executed (decision D4)

The spoken gate test at task 2 showed the limit. A spoken "yes, that's right"
confirmed an address whose middle was misheard (`5c8e` became `5cad`) while its
last four characters were right, and the wrong value ran
(`sess_c7ecda9ca1ca4a3f8eebfb18378bd139`).

**Trigger A** now returns `{"status":"needs_paste", ...}` and never creates a
pending entry, so there is nothing a yes can release.
- It is checked first, so a state change whose arguments carry a spoken
  identifier needs a paste too.
- The card says "Heard from speech, may be wrong - paste it to run", shows the
  heard value grouped in fours, and focuses the paste box.
- The prompt tells the agent never to retry that value.

**Trigger B** is unchanged: a spoken yes still releases a state change, once,
within 120 s.

```
$ node --test packages/core/test/gate.test.ts                ℹ tests 23  ℹ pass 23
  ✔ D4: a spoken identifier needs a paste, "yes, that's right" releases nothing, and the paste runs exactly once
  ✔ Trigger A applies first: a state change carrying a spoken identifier needs a paste, even after yes
$ npm test                                                  ℹ tests 300  ℹ pass 300  ℹ fail 0
```

Real speech (`e2e-audio`, new output files so the old evidence stays):

```
--case gate-spoken  sess_2762c5ea28bc4b1f99dbe0a3c2b8fe4f  (data/e2e-audio-gate-spoken-d4.json)
  HEARD  "What is the reputation of wallet 0x3f91c7e5b2d8f4a6c0e9b3d7f1a5c8e2b4d6f09?"   (a new mishearing: the "a" after 3f9 lost)
  GATE paste: I may have misheard that value. Please paste it into the box under the Talk button...
  SAY "Yes, that's right."  ->  AGENT: "Please paste the address into the box under the Talk button so I can use it."
  MCP requests: after turn 1 = 0, after turn 2 = 0
  PASS turn1NeedsPaste   PASS turn1ZeroMcpCalls   PASS turn2StillZeroAfterYes
--case gate-paste   sess_5ddb040c77e24c3181d6d7cb60799b10  (data/e2e-audio-gate-paste-d4.json)
  use_pasted_text -> afg_get_reputation({"address":"0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"}); afg_get_reputation requests: 1
  pasted sha256 = sent sha256 = e066de5176c4f671c4d01441f2c9a6d8dcb4098b770f90b96f5bb2ce21b925cc
```

`scripts/spoken-identifiers.ts` recounts every spoken identifier in
`data/e2e-audio-*.json`: **0 of 7 came through exact**. Five misheard values
reached a server:
- four in step 6's runs, made before the gate existed (afg-natural, afg-nocarry,
  afg-phase-carry, afg-phase-nocarry);
- one through the spoken confirmation (gate-spoken).

It found one detection bug while being written. It first matched sent values by
their first six characters, which missed the `5aaeb` -> `5aeb` merge. It now takes
the one identifier each session sent.

The README section "Identifiers and state-changing tools" now quotes that count
and lists four failure modes. The dropped single character is new today.

Browser (local dev server, AFG preset; test-only instrumentation: silent synthetic
mic plus a text turn injected over the page's own socket), `sess_63429153cebc43f196befdb04203605d`:
- Asked about wallet `0x3f9a...5cad2b4d6f09`. The agent called `afg_get_reputation`.
  The card showed kind `paste`, "Heard from speech, may be wrong - paste it to run",
  and the value `0x3f 9a1c 7e5b 2d8f 4a6c e09b 3d7f 1a5c ad2b 4d6f 09`. Focus was
  on the paste box. 0 `/api/mcp/call` requests.
- Then "Yes, that's right.": still 0 `/api/mcp/call` requests, one `tool.call` in
  total, and the card stayed on `paste`.
- At 375 px with the card up: scrollWidth 375, card right edge 359, 0 overflowing
  elements. Console errors: none.

---

## 2026-09-26 - B: a session nobody talks in ends after 60 s

**Why:** idle open tabs, not conversations, are what reach the 300 s worst case.
The docs say a Voice Agent session "is billed on the total time the WebSocket
connection stays open" (billing-and-pricing, "Voice Agent API billing").

**No API setting:** the docs, read today through AssemblyAI's own docs MCP
server, have no inactivity setting.
- `session-configuration.mdx` has no timeout, duration or seconds field (grep
  exit 1).
- A grep of the whole `/voice-agents` tree for "inactiv" or "idle" finds only a
  code comment and a testing tip.
- The documented clean teardown is `session.end`, which `stop()` already sent.

So it is client-side. `IdleClock` (packages/core/src/idle.ts) is pure, with the
clock passed in:
- It counts only while nobody is speaking and nothing is pending.
- `input.speech.started` holds it until `input.speech.stopped`.
- `reply.started` holds it until `reply.done`.
- Each running tool holds it.

The page shows "No one is speaking: this session ends in N s. Say anything to keep
going." under the Talk button. It turns red at 10 s, and at 0 the page sends
`session.end`.

```
$ node --test packages/core/test/idle.test.ts   ℹ tests 4  ℹ pass 4
```

Measured on one session: local dev server, Books preset, a truly silent synthetic
mic, `sess_9898e7c3a9b147818592423f236050b0`:

```
session.ready @759 ms   greeting reply.done @5746 ms
countdown visible: "ends in 60 s" @6003 ms ... "ends in 1 s" @65002 ms
session.end sent @65762 ms  = 60,016 ms after the greeting ended
session.ended @65953 ms, socket closed @66629 ms; page: "Session ended: no one spoke for 60 s."
Session History: status=completed duration=65.924277s close=client_end
console errors: none
```

An idle tab now costs 65.9 s ($0.082 at $4.50/hr) instead of up to 300 s ($0.375).

---

## 2026-09-26 - C: "Watch a real session", and the cap fallback

**The recording is Session History's own.** The audio artifact of an e2e-audio
session downloads through its pre-signed URL: Ogg Opus, stereo, 48 kHz, 39.66 s,
672 KB. Its channels separate cleanly: channel 0 holds the caller (0.6-2.5 s and
18.0-20.2 s), channel 1 the agent (5.1-16.6 s and 24.1-37.9 s).

`scripts/replay-build.ts <session> <data file> "<label>"`:
- mixes the recording to mono, so the voices are not hard-panned, and encodes AAC
  (`afconvert`, 64 kbps, 315 KB), which every browser plays;
- finds speech per channel;
- places the timeline on the recording's clock. Its user-speech starts sit 0.468 s
  after the caller channel's (the median over both turns), and its tool dispatch
  and result times are shifted by that. The timeline gives no start time for a
  tool_result reply, so agent lines start where channel 1's speech does;
- takes the tool list from the session's own `session.update` (`config_changes`),
  and the shaped line each call returned from the harness's data file.

The session: `sess_4e6cc252c2cb4754adec545d0a36824f`, Most Recommended Books,
"What books does Bill Gates recommend?" and "What is the reading order for the
Dune series?". The caller is Samantha, a macOS `say` voice, and the page says so.

```
0.60 s user   What books does Bill Gates recommend?
3.04 s call   get_person_recommendations      4.01 s result 977 ms ok
5.10 s agent  Bill Gates has two hundred and thirty-five verified recommendations...
18.00 s user  What is the reading order for the Dune series?
21.74 s call  get_series_reading_order       22.62 s result 881 ms ok
24.10 s agent The Dune series consists of six books in this publication order...
```

**On the page:**
- The homepage has "No microphone? Watch a real session".
- The replay drives the live page's own panes. Each line appears at its real time
  and fills word by word across the span the voice is heard. Each tool call
  appears at its dispatch time and completes at its result time. The session_id
  and the voice label are shown. Seeking backwards redraws from the start.
- When `/api/token` answers 429 (the per-IP limit or the daily cap), the page shows
  "Live sessions are paused: <the server's message> Here is a recorded one instead."
  and plays the recording, rather than showing an error.

**One serving fix:**
- Hono's MIME table has no `.m4a`, so the file went out as
  `application/octet-stream`. Chrome sniffs it, but Safari does not.
- A wrapper on `/assets/*` now labels it `audio/mp4`. Byte ranges already worked (206).
- There is a test for both.

Browser (local dev server):
- The button started playback. At 6.4 s the page showed the question, the tool
  call done in 977 ms, and "Bill Gates has two" still filling in.
- Seeking to 30 s showed both exchanges. Seeking back to 2 s redrew only the first
  question and call.
- Fallback: `/api/token` was made to answer the real 429 body (test
  instrumentation, code `global`), then Talk was pressed on Recipes Daily. The
  replay showed and played with "Live sessions are paused: The demo has used its
  daily session budget. Try again tomorrow. Here is a recorded one instead."
  No error alert, no console errors.
- At 375 px: scrollWidth 375, replay card right edge 359, 0 overflowing elements.

```
$ npm test                        ℹ tests 305  ℹ pass 305  ℹ fail 0
$ sandbox-exec (deny outbound)    ℹ tests 305  ℹ pass 305  ℹ fail 0
$ npm run typecheck               exit 0
```

---

## 2026-09-26 - D: a real common-word list, 10,000 words, MIT

The 976-word list was hand-made, so it missed everyday words: the Books preset
boosted `series` and `recommended`. The replacement is the top 10,000 letter-only
words of `results/enwiki-2023-04-13.txt` from
[IlyaSemenov/wikipedia-word-frequency](https://github.com/IlyaSemenov/wikipedia-word-frequency),
pinned to commit `798ea9062d6e5aed1fa87deeeda1cd99d5b37903`.
`scripts/common-words-build.ts` rebuilds it byte for byte, and the MIT notice is in
`packages/core/THIRD_PARTY_LICENSES.md`, cited from the README.

Licences checked before choosing:
- `hermitdave/FrequencyWords`: MIT for code, but CC-BY-SA-4.0 for the lists
  (share-alike, not permissive).
- `first20hours/google-10000-english`: the LDC licence of the Google corpus, with
  commercial use discouraged.
- `rspeer/wordfreq`: CC-BY-SA data.
- The Wikipedia list is MIT, with no separate licence on its results.

**One rule changed with it.** A frequency list carries frequent inflections in
their own right, so a word from it counts only as written. "advisor" is #4,269,
but "advisors" is #11,490, and stripping the plural would have dropped the
AdvisorsAI brand. The curated tool-name vocabulary (244 words: get, list,
webhook, endpoint...) stays on top, in base forms, with its plural and
inflection rules.

Keyterms before and after, same fixtures (`buildKeyterms` over the full catalog):

| server | before (976 words) | after (10,066) |
|---|---|---|
| AdvisorsAI | 7: store assistant, store audit, AI visibility, custom monitor, agent team, advisors, navigator | **7, identical** |
| AFG | 15: ... provider, guarantee, fund, dispute, appeal, reputation ... | 9: schema valid, buyer, AFG, fulfillment, sandbox, speccheck, wallet, discard, artifact |
| AssemblyAI docs | 3: AssemblyAI, filesystem, feedback | 2: AssemblyAI, filesystem |
| Most Recommended Books | 4: recommended, recommendations, recommenders, series | **1: recommenders** |

AFG loses six words that are in the top 10,000 (`guarantee` #8,094, `dispute`
#3,501, `reputation` #2,875, `appeal` #2,324...). The docs' own rule is not to
boost common words, and the recogniser knows them.

**A test bug the new fixture found.** Books was captured as a fixture
(`scripts/capture-fixture.ts`, 6 tools), and "nothing structural survives"
failed on it: `"title" must not reach the Voice Agent API`. Two Books tools take
an argument named `title` (a book's title). The test searched the serialised
JSON for the string `"title"` and could not tell a property name from the
keyword. The converter was right: it now walks schema keyword positions only,
and a positive control asserts the `title` argument survives.

Cost: the web bundle grows from 42.9 KB (16.5 KB gzip) to 118.4 KB (52.0 KB gzip).
The browser needs the list for the paste box's keyterms.

```
$ npm test            ℹ tests 316  ℹ pass 316  ℹ fail 0
$ npm run typecheck   exit 0
```

---

## 2026-09-26 - protocol: a flush at reply.done means an answer is coming

Found by task 4's first warm run: two presets "failed" with no agent reply. Session
History showed both answers did arrive; the harness had ended the turn first.

- Recipes, `sess_4079c02369eb46539b8f45f4e42b9fed`: the answer came at +7.8 s, but
  the harness closed the turn at 6.3 s.
- Docs, `sess_cb24b8f4fa8b4e4e9934bc664d886d24`: after 5 chained calls, the answer
  began at +14.9 s. The next scripted question interrupted it.

**The race is in `AgentProtocol.onReplyDone`.** When the agent chains a second
call and that call's result is ready *before* the reply that asked for it ends,
the handler flushes the result and then took the "results went out earlier"
branch. That declared the turn idle, although the flush it had just made means
an answer is next. Slow tools hid it: their results arrived after `reply.done`.
`flushIfIdle` now reports whether it sent anything, and a flush at `reply.done`
always waits for the answer.

The browser does not use `onTurnIdle` (the idle clock reads reply events
directly), so only the proof harness mis-ended turns. A new protocol test, "a
chained call whose result is ready before its reply ends does not end the turn",
fails without the fix (12/13) and passes with it (13/13).

---

## 2026-09-26 - task 4: warm MCP connections, kept (gain 386 ms per call, 484 ms voice-to-voice)

**Before:** `callTool` opened a new MCP client per call (`initialize`,
`notifications/initialized`, `tools/call`, then `close()`, which it awaited
before returning). `guardedFetch` built and closed a new undici `Agent` per
request, so every request paid DNS, TCP and TLS.

**Now:**
- `McpPool`, one client per (voice session, server URL):
  - keyed on the Voice Agent `session_id`, which the browser now sends with
    `/api/mcp/call` and the harness passes as `poolKey`;
  - closed after 60 s idle, capped at 32 (LRU);
  - two calls racing on a cold key share one open;
  - on a 404 or "not connected" (the server forgot the session) it reopens
    exactly once.
- `PinnedAgents`, one keep-alive `Agent` per verified host:
  - it dials only the addresses verified for it;
  - after 30 s the host is verified again. The same addresses keep the warm
    Agent; new addresses get a new one; a host that now fails the check is
    refused, never served from the cache;
  - idle sockets are kept 60 s, because undici's default of 4 s is shorter than
    the gap between voice turns.
- `MCP_WARM=off` turns off both, which is how the A/B ran. `/api/status` reports
  the pool's warm and opened counts.

```
$ node --test apps/server/test/pool.test.ts                 ℹ tests 8  ℹ pass 8
  ✔ one initialize for N calls in one voice session           (counting fake server: initialize 1, calls 5)
  ✔ another voice session gets its own client
  ✔ two calls racing on a cold key share one open
  ✔ an idle client is closed, and the next call opens a new one
  ✔ the pool is capped, least recently used out first
  ✔ a session the server forgot is reopened once, and the call still answers
  ✔ a pinned agent is reused within the TTL, and the host is verified again after it
  ✔ a host that turns private is refused at re-verification, never served from the cache
$ npm test                                                  ℹ tests 325  ℹ pass 325  ℹ fail 0
$ sandbox-exec, outbound denied except localhost             ℹ tests 325  ℹ pass 325  (control curl: Could not resolve host)
```

The SSRF tests stay green. The sandbox now allows loopback, because the pool
test's counting server listens on 127.0.0.1. The control curl to the internet
still fails.

**A/B on the spoken suite:** six presets, `e2e-audio`, run from the Mac with
`MCP_WARM=off` and then on. The first warm run exposed the protocol race logged
above, so both arms were run again with the fix:

```
$ node scripts/warm-ab.ts data/e2e-audio-warm-off.json data/e2e-audio-warm-on.json
                                        off      on    gain  (ms, medians)
MCP call, all (n=11/11)                 867     481     386
MCP call, first in session (n=5/5)      867     491     376
MCP call, later in session (n=6/6)      806     311     495
voice-to-voice (turns 11/11)           3504    3020     484
off sessions: sess_42dfe7cdb5a34219ac99836d02468a42 sess_31ba0f4801264ed09f582f18b17fcf71 sess_1041022116ca4526a74daa78f06ff836 sess_75713d30db2342da913a9dff406f92c7 sess_6125246dca5c4ce0b78092088bbe8d0a sess_eed74a5adb9843519fdfef293c7d4d15
on sessions:  sess_b0a39ba6f1754c4b8799c6790bdfdfc1 sess_5623edf76d4f4c37b81419e8372e9b42 sess_5d91b31b639e450d9a6ee9bbe1f70258 sess_e9a40d7c718e4fe4bcf089e35c0e3e6d sess_d340e7fa9fda4f4b9aa95bc1f781a597 sess_fccb439982b848978c504e97ebdf6c33
```

The first call in a session gains too, because the catalog probe at session
start has already warmed the host's connection. The gain is over the 200 ms bar,
so this stays. Measured from the Mac; the demo server's round trips to these
hosts differ.

---

## 2026-09-26 - the page revalidates; hashed assets cache for good

Found while checking task 5 in the browser. The page came back from the local
server without the new starters row, although `curl` showed the new HTML. The
browser had cached the entry by heuristic: it had `last-modified` and no
`Cache-Control`. On the next load it asked for a bundle the rebuild had deleted:
two 404s and a dead page. In production every redeploy replaces the build, so a
judge coming back would hit exactly this.
- The entry (`/` and every app URL) now carries `Cache-Control: no-cache`, so it
  always revalidates.
- A found hashed asset carries `public, max-age=31536000, immutable`.
- A 404 gets neither.

```
✔ the page always revalidates, and a hashed asset is cached for good
```

---

## 2026-09-26 - task 5: the LLM Gateway writes starter questions, off the speech path

**What:** at connect time the page asks `POST /api/mcp/starters`, and the Gateway
(`qwen3.5-4b-32k-fast`, the one model this account reaches) writes three
questions a person could say to that server. They show as "Try asking" chips.
- Only read-only tools feed the prompt (task 2's classifier), so a starter never
  suggests a change.
- The output must parse as `{"questions": [...]}`, even inside a code fence, and
  every question must be short and contain no URL and no identifier.
- **Templates stand in** when the breaker is open, on a 429, on a timeout (4 s:
  nothing is speaking yet), or on unusable output. They are built from each
  read-only tool's own description ("Returns every book..." -> "Can you return
  every book...?"), or from its name when the description addresses the agent
  ("advisors_catalog_list_services" -> "Can you list services?").
- The breaker is the shaper's own, because a 429 belongs to the account.
- The chips say which source they came from: "written by AssemblyAI's LLM Gateway
  (model, N ms)", or "from the tools' own descriptions: the LLM Gateway was
  rate-limited".
- A preset's own tested questions stay, relabelled "Tested on this server".
- Gateway answers are cached per URL alongside the catalog. Templates are not
  cached, because the Gateway may be back in a minute.

This puts an AssemblyAI product on the default path, every connect, at zero
speech latency. Task 6 speaks the first starter of each server.

Live, against the real Gateway (local dev server, three presets in a row):

```
mostrecommendedbooks.com | gateway 982 ms | "What books does Elon Musk recommend?" "Show me the reading order for Harry Potter." "Give me a summary of The Alchemist."
recipes-daily.com        | gateway 414 ms | "What can I cook with chicken and broccoli?" "Find me a quick dinner recipe." "Show me a recipe for pasta"
weather.datakoot.com     | template 212 ms rate_limited | "Can you convert a US street address OR a city/town name into latitude/longitude coordinates?" ...
```

The third call hit the account's 429, as measured at CHECKPOINT A (4 of 6 calls),
and the templates and the breaker did their job. In the browser the Books preset
showed both rows, no horizontal overflow and no errors from that load.

```
$ node --test packages/core/test/starters.test.ts apps/server/test/starters.test.ts   ℹ tests 9  ℹ pass 9
$ npm test                                                                              ℹ tests 335  ℹ pass 335  ℹ fail 0
```
