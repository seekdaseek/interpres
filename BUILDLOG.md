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
