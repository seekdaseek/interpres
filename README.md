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

## Status

Under construction for the lablab.ai AssemblyAI Voice Agent Hackathon
(submissions close Wed Sep 30 2026). See `BUILDLOG.md` for what is built and
what is proven.

## License

MIT — see `LICENSE`.
