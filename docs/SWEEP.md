# Sweep of the official MCP registry

Measured by `scripts/sweep.ts` from 2026-09-26T11:48:21.641Z to 2026-09-26T12:32:10.173Z (2,629 s).
Every server that answered was probed again by `--recheck`, each at least 60 minutes after its first probe (2026-09-26T12:52:04.405Z to 2026-09-26T13:32:12.262Z).
Every server that failed was probed again with the corrected error classifier (2026-09-26T12:38:07.263Z to 2026-09-26T12:50:52.392Z); see [Outcome by class](#outcome-by-class).

Method: initialize + tools/list only, through the product probeServer and SSRF guard; no tool is ever called. User-Agent `interpres-sweep/0.1 (+https://github.com/seekdaseek/interpres)`; concurrency 8, at most 2 at once per host, 8 s timeout.
No credential was sent to any server, so `ok` means the server completed `initialize` and listed its tools **without auth**. Calling a tool can still need a key: listing proves the catalog, not every call.

## Headline

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

## Outcome by class

The first pass classified failures with a bug: the MCP SDK puts the HTTP status on the error object and only the response body in the message, and the classifier then read bare numbers out of that body - `font-weight: 500` in a challenge page counted as a 5xx. The status is now kept and decides first; after it only explicit words do. Every failed server was probed again with the fix, and the failure split below is that re-measure. The `ok` count is unaffected: it never went through the classifier.

| class | first pass | re-measured |
| --- | ---: | ---: |
| `ok` | 12,012 | 12,012 |
| `auth_required` | 3,844 | 5,299 |
| `unreachable` | 3,669 | 4,416 |
| `protocol_error` | 2,692 | 344 |
| `ok` when re-measured (failed the first time) | - | 146 |
| total | 22,217 | 22,217 |

Reasons within each class at the re-measure, as recorded by the probe:

**auth_required**: http_401 5,038, http_402 174, http_403 77, auth_words 10

**unreachable**: http_429 1,526, http_404 1,027, ssrf_dns_failed 603, http_5xx 316, url_template 216, ssrf_redirect_refused 206, tls 196, timeout 160, http_405 58, http_410 40, refused 35, reset 29, other 2, fetch_failed 2

**protocol_error**: protocol_version 127, http_400 84, protocol_other 60, jsonrpc_error 24, not_mcp_response 20, ssrf_too_large 16, http_451 5, http_421 4, jsonrpc_method_not_found 2, http_422 1, http_409 1

The largest reasons, and whether one host is behind them. A 429 is a host rate-limiting this sweep, not a broken server.

| reason | servers | hosts | top host |
| --- | ---: | ---: | --- |
| http_401 | 5,038 | 4,498 | mcp.apify.com (265) |
| http_429 | 1,526 | 210 | gateway.pipeworx.io (1,305) |
| http_404 | 1,027 | 486 | api.m2mcent.com (276) |
| ssrf_dns_failed | 603 | 421 | openings-vote-drilling-initially.trycloudflare.com (90) |
| http_5xx | 316 | 292 | mcp.boykaf.com (17) |
| url_template | 216 | 172 | {host} (19) |

## Conversion

Counted over the tools of every `ok` server.

| converter counter | tools |
| --- | ---: |
| listed | 202,191 |
| converted | 202,191 |
| converted with hints | 36,059 |
| names sanitised | 3,188 |
| descriptions synthesised | 71 |
| descriptions truncated | 12,637 |
| patterns kept | 12,557 |
| patterns dropped | 191 |
| $refs resolved | 3,023 |
| allOf flattened | 301 |
| unions collapsed | 4,494 |
| nullable unwrapped | 23,550 |
| failed | 0 |

No tool failed to convert.

## Tool annotations

|  | count |
| --- | ---: |
| Tools with `readOnlyHint: true` | 66,602 |
| Tools with `destructiveHint: true` | 4,688 |
| `ok` servers with at least one of the two | 5,983 of 12,012 |

## Declared auth against measured

A registry entry "declares auth" when one of its remotes lists a required or secret header. Failures use the re-measured class.

| declares auth | servers | `ok` | `auth_required` | `unreachable` | `protocol_error` | `ok` only when re-measured |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| yes | 3,358 | 1,106 | 1,524 | 698 | 28 | 2 |
| no | 18,859 | 10,906 | 3,775 | 3,718 | 316 | 144 |

3,775 servers answered with an auth wall that their registry entry does not declare, and 1,106 that declare one listed their tools without it.

## Host concentration

A few hosts publish many registry entries. These counts keep the headline honest.

| host | probed | `ok` |
| --- | ---: | ---: |
| agent-observatory-sensor.nolimit-observatory.workers.dev | 2,365 | 2,360 |
| gateway.pipeworx.io | 1,710 | 371 |
| api.mcp.ai | 1,115 | 1,113 |
| api.m2mcent.com | 276 | 0 |
| mcp.apify.com | 265 | 0 |
| server.smithery.ai | 216 | 0 |
| mcp.zovo.one | 124 | 113 |
| a2awire.com | 112 | 112 |
| openings-vote-drilling-initially.trycloudflare.com | 90 | 0 |
| tooloracle.io | 57 | 38 |

The three hosts with the most `ok` servers hold 3,844 of the 12,012 (32.0%). `ok` servers sit on 7,347 distinct hosts.

## Stability

Each `ok` server was probed again 60-61 minutes after its first probe (median 60).

| at the recheck | servers | share |
| --- | ---: | ---: |
| `ok` | 11,578 | 96.4% |
| `unreachable` | 434 | 3.6% |

Without `gateway.pipeworx.io`, which answered the recheck with 429 - rate-limiting this sweep, not failing - 11,577 of 11,641 held (99.5%).

Why the ones that dropped did, and whether one host is behind it:

| reason | servers | hosts | top host |
| --- | ---: | ---: | --- |
| http_429 | 374 | 2 | gateway.pipeworx.io (370) |
| timeout | 19 | 12 | agent-observatory-sensor.nolimit-observatory.workers.dev (7) |
| refused | 18 | 2 | tooloracle.io (12) |
| http_5xx | 15 | 14 | api.mcp.ai (2) |
| ssrf_timeout | 5 | 3 | agent-observatory-sensor.nolimit-observatory.workers.dev (3) |
| http_404 | 2 | 1 | api.brainiall.com (2) |

## Presets

The demo presets, looked up in these sweeps by URL. Presets added from the sweep had to be `ok` in both passes, declare no auth, and answer their suggested questions spoken through `scripts/e2e-audio.ts`.

| preset | url | first pass | recheck | tools |
| --- | --- | --- | --- | ---: |
| AssemblyAI's own docs | https://www.assemblyai.com/docs/mcp | not in the registry | - | - |
| AFG marketplace (sandbox) | https://afg.ai/mcp | ok | ok | 15 |
| AdvisorsAI service navigator | https://advisorsai.ai/mcp | ok | ok | 5 |
| Most Recommended Books | https://mostrecommendedbooks.com/api/mcp | ok | ok | 6 |
| Recipes Daily | https://recipes-daily.com/mcp | ok | ok | 3 |
| US weather and earthquakes | https://weather.datakoot.com/mcp | ok | ok | 6 |

## Per-server table

[`docs/sweep-servers.csv`](sweep-servers.csv) holds one row per probed server, all 22,217 of them: class and reason from the first pass, the recheck class for `ok` servers, the re-measured class for failures, tool counts, conversion and annotation counts. At 12,006 `ok` servers alone, a Markdown table here would be too large to read.

## Reproduce

```
node scripts/sweep.ts                                  # first pass
node scripts/sweep.ts --recheck <first pass>           # each ok server again, >= 60 min later
node scripts/sweep.ts --recheck <first pass> --recheck-classes auth_required,unreachable,protocol_error --min-gap-minutes 0
node scripts/sweep-report.ts <first pass> --recheck <recheck> --reclassify <re-measure>
```

This page was rendered from `sweep-2026-09-26T1148Z-summary.json.gz`, `sweep-2026-09-26T1252Z-recheck-summary.json.gz`, `sweep-2026-09-26T1238Z-reclassify-summary.json.gz`. The gzipped summaries in `data/` are enough to render it again. The raw catalogs (every `tools/list`, tens of MB) stay out of git.

