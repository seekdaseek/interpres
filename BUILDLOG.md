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

4. **The brief's first demo target is deprecated and past its shutdown date.** `https://mcp.assemblyai.com/docs` answers `initialize` 200 with no auth, but all 4 of its tool descriptions begin:
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

$ POST https://mcp.assemblyai.com/docs  (the brief's target)
200 — 4 tools, ALL deprecated per difference 4 above

$ curl -s 'https://registry.modelcontextprotocol.io/v0/servers?limit=3'
200 — {servers:[{server,_meta}], metadata:{nextCursor:"ac.inference.sh/mcp:2.0.0", count:3}}

$ gh search repos voice-agent --owner AssemblyAI
voice-agent-starter-js (2026-09-04), voice-agent-starter-python (2026-09-01),
voice-agent-api-twilio-example (2026-07-30), bluejay-aai-bridge (2026-09-04)
```

**UNTESTED so far:** the WebSocket session itself. No `session.ready` has been observed — only the token mint. `scripts/e2e.ts` (step 4) is the test that proves it, and CHECKPOINT A is where that evidence lands.
