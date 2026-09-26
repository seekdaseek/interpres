# interpres

Make any MCP server talkable through AssemblyAI's Voice Agent API. It turns a
server's `tools/list` into Voice Agent function tools, shows the agent at most
ten at a time with a `find_tools` swap for the rest, and plans the
`session.update` for each phase. It also exports the shaping and gating pieces:
results made speakable, and a gate so nothing misheard is ever executed.

## Try it

This runs as it is after `npm install interpres` (save it as `example.mjs`):

```js
import { convertCatalog, initialPhase, phaseSessionUpdate } from 'interpres';

// A tools/list result, as any MCP server returns it.
const tools = [
  {
    name: 'get_forecast',
    description: 'Weather forecast for a US city.',
    inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
  },
  {
    name: 'list_alerts',
    description: 'Active weather alerts for a US state.',
    inputSchema: { type: 'object', properties: { state: { type: 'string', description: 'Two-letter state code' } }, required: ['state'] },
  },
];

const { converted } = convertCatalog(tools);                  // MCP tools -> Voice Agent function tools
const update = phaseSessionUpdate(initialPhase({ catalog: converted }));
console.log(update.type, update.session.tools.map((t) => t.name));
```

It prints the `session.update` type and the tools the agent sees first.

## In a live session

A sketch of the wiring: `mcp` is a connected MCP client, such as
`@modelcontextprotocol/sdk`'s `Client`, `ws` is the Voice Agent WebSocket, and
`call` is a `tool.call` event.

```ts
import { buildNameMap, convertCatalog, handleFindTools, initialPhase, phaseSessionUpdate } from 'interpres';

const { tools } = await mcp.listTools();                    // any MCP server
const { converted } = convertCatalog(tools);                // MCP tools -> Voice Agent function tools
const planner = { catalog: converted, server: mcp.getServerVersion() };
ws.send(JSON.stringify(phaseSessionUpdate(initialPhase(planner))));   // at most 10 tools per phase
const mcpName = buildNameMap(converted);                    // voice name -> MCP name, for tools/call
// on tool.call: find_tools swaps the visible set; anything else is an MCP call
if (call.name === 'find_tools') ws.send(JSON.stringify(phaseSessionUpdate(handleFindTools(planner, call.arguments.query).phase)));
else await mcp.callTool({ name: mcpName.get(call.name), arguments: call.arguments });
```

The full app, the proof scripts and the measurements are at
<https://github.com/seekdaseek/interpres>.

MIT licence. The common-word list comes from
[IlyaSemenov/wikipedia-word-frequency](https://github.com/IlyaSemenov/wikipedia-word-frequency),
also MIT; see `THIRD_PARTY_LICENSES.md`.
