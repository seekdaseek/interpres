# Judge guide: five minutes

interpres makes any remote MCP server talkable through AssemblyAI's Voice Agent
API. This is the fastest way to see that it works, and where the proof lives.

## 1. Talk to it (2 minutes)

1. Open **<https://interpres.ochinimus.app>** in Chrome, Brave, Edge or Safari, with a
   microphone.
2. Click **Most Recommended Books**. Tools, key terms and "Try asking" chips appear.
   The LLM Gateway writes those chips for any server at connect time.
3. Press **Talk**, allow the microphone, and ask, one at a time:
   - "What books does Bill Gates recommend?"
   - "What is the reading order for the Dune series?"
   - "Who recommends Sapiens?"
4. Watch **Tool calls**: each question calls one tool on the MCP server, and the
   agent answers with what it returned. The timings are real.

No microphone at hand? Press **"No microphone? Watch a real session"**. It replays
a recorded session: the caller is a synthetic macOS `say` voice, and the transcript
and tool calls appear at their real times, with the `session_id` shown.

## 2. Type a website, or search (1 minute)

1. **Type a website.** Clear the box, type `goji.agency`, and press **Connect**.
   interpres finds `https://mcp.goji.agency/mcp` in the official MCP registry,
   connects, and says where it found it under the box. Press **Talk** and ask:
   - "What is SEO in plain English?"

   That question was asked out loud in the spoken sweep, and goji answered it
   through `goji_explain_term` (`sess_cc23fd40e3e04ca0be74999e9e68ed5b`, in
   [docs/VOICE-SWEEP.md](docs/VOICE-SWEEP.md)).
2. **Search.** Under the presets, type `books` into "Or search ... public MCP
   servers". Most Recommended Books comes first, and one click connects it.
   A website with nothing on it, like `example.com`, lists every address that was
   tried.

## 3. Try the safety gate (1 minute)

1. Click **AFG marketplace (sandbox)**, press **Copy sample address**, and paste it
   into "Paste an address or ID".
2. Press Talk and say: "Check the reputation of the wallet I pasted." The exact
   pasted value reaches the tool.
3. Now clear the box and read the sample address aloud instead. The card shows
   what was heard and asks for a paste. Nothing heard by speech-to-text is ever executed, even after
   "yes, that's right". Of every recorded attempt to speak a wallet address,
   <!-- value:identifiers-exact -->13 of 23<!-- /value:identifiers-exact --> came through exact, <!-- value:identifiers-clips -->and all 13 were one recording, replayed<!-- /value:identifiers-clips --> ([docs/IDENTIFIERS.md](docs/IDENTIFIERS.md)).

## 4. Check the numbers (1 minute)

All of these are generated from measured data, not typed by hand.

The registry sweep ([docs/SWEEP.md](docs/SWEEP.md)):

<!-- quote:sweep-headline -->
|  | count |
| --- | ---: |
| Registry entries (every version) | 119,873 |
| Unique servers (latest version each) | 36,251 |
| With a streamable-http or sse remote: probed | 22,217 |
| Distinct hosts probed | 14,675 |
| `ok`: listed its tools without auth | 12,012 (54.1%) |
| ... on distinct hosts | 7,347 |
| `ok` with at least one tool | 12,006 |
| `ok` with more than 10 tools (find_tools engages) | 5,474 (45.6%) |
| Tools per `ok` server: median / 90th percentile / max | 9 / 31 / 627 |
| `ok` by transport | streamable-http 11,969, sse 43 |
| Tools listed by `ok` servers | 202,191 |
| Tools converted to Voice Agent function tools | 202,191 (100.0%) |
| Converted tools carrying spoken-format hints | 36,059 (17.8%) |
| `ok` again at the recheck | 11,578 of 12,012 (96.4%); 99.5% without the host that rate-limited the sweep |
<!-- /quote:sweep-headline -->

The spoken sweep ([docs/VOICE-SWEEP.md](docs/VOICE-SWEEP.md)): every `session_id` is listed there.

<!-- quote:voice-sweep-counts -->
| | count |
| --- | ---: |
| servers attempted | 30 |
| connected | 30 |
| starter from the LLM Gateway / from templates | 29 / 1 |
| voice sessions run | 29 |
| session failed to open (the API's own session.error) | 1 |
| a tool was called | 17 |
| MCP call succeeded / tool answered with an error / held by the gate | 14 / 3 / 0 |
| the agent answered out loud | 29 |
| median voice-to-voice, answered turns | 2597 ms |
| median voice-to-voice, turns that called a tool | 3540 ms (17 turns) |
| session time, and its cost at $4.50/hr | 482 s, $0.60 |
<!-- /quote:voice-sweep-counts -->

Session History ([docs/PROOF.md](docs/PROOF.md)): every session our data files name,
read back from AssemblyAI's API.

<!-- quote:proof-summary -->
| | |
| --- | ---: |
| sessions | 93 |
| tool calls | 136 |
| tool calls answered with no error flag (Session History `is_error`) | 136 of 136 (100.0%) |
| median tool latency | 936 ms (n=135) |
| median time to first audio | 881 ms (n=14 turns that report it) |
| session time | 2307 s |
| cost, computed from the published $4.50/hr (not read from a bill) | $2.88 |
<!-- /quote:proof-summary -->

[BUILDLOG.md](BUILDLOG.md) records every change with its measured output. The
README covers the architecture, the AssemblyAI features used, and two places
where the API measured differently from its docs.

## Run it locally

```bash
git clone https://github.com/seekdaseek/interpres && cd interpres
```

```bash
npm ci && npm test
```

`npm test` needs no network. For the app and the live proofs, put
`ASSEMBLYAI_API_KEY=...` in a `.env` file first:

```bash
npm run build && npm run dev:local
```

That serves <http://localhost:3030>. The next command needs macOS, for `say`:

```bash
node --env-file=.env scripts/e2e-audio.ts --preset https://mostrecommendedbooks.com/api/mcp --say "Who recommends Sapiens?"
```

It speaks the question into a real Voice Agent session and prints the tool call,
the answer, the voice-to-voice time and the `session_id`.
