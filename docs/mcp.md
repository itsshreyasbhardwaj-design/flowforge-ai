# Model Context Protocol

FlowForge speaks MCP as a **client**: the MCP Server node calls tools on external
MCP servers, so anything exposed over MCP becomes available inside a workflow.

## The node

```jsonc
{
  "type": "flowforge.mcp",
  "config": {
    "serverUrl": "https://mcp.example.com/mcp",
    "operation": "callTool",
    "toolName": "search_documents",
    "arguments": { "query": "{{ $.input.question }}" },
    "authHeader": { "$secret": "MCP_AUTH_HEADER" },
  },
}
```

| Operation   | Result                                                            |
| ----------- | ----------------------------------------------------------------- |
| `listTools` | The server's tool catalogue — useful for discovery while building |
| `callTool`  | Invokes `toolName` with `arguments`                               |

Outputs are `result` (the raw JSON-RPC result) and `text` (text content blocks
concatenated, which is what you usually want to feed a model).

## Transport

The node speaks JSON-RPC 2.0 over **Streamable HTTP**, the transport a hosted MCP
server exposes. It handles both a plain JSON response and SSE framing for a
single response.

**Stdio servers are not spawned.** A node that spawns processes on the web server
would be a remote-code-execution hole. Front a stdio server with a small HTTP
proxy instead:

```ts
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// Minimal stdio → HTTP bridge. Run it next to the stdio server, not exposed publicly.
createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const child = spawn('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/data']);
    child.stdin.write(body + '\n');
    child.stdout.once('data', (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data.toString());
      child.kill();
    });
  });
}).listen(8420);
```

Point `serverUrl` at `http://localhost:8420`.

## Authentication

Put the header value in the vault, never inline:

1. Settings → Credentials → add `MCP_AUTH_HEADER` with value `Bearer sk-…`
2. Reference it as `{ "$secret": "MCP_AUTH_HEADER" }` in the node's `authHeader`

The value is encrypted at rest and redacted from every trace.

## Giving an agent MCP tools

The Agent node's tools are _workflows_. To let an agent use an MCP tool, wrap the
MCP call in its own small workflow and register that as the tool:

```
[Trigger] → [MCP Server: search_documents] → [Output]
```

Then on the agent:

```jsonc
"tools": [
  { "name": "search", "description": "Search the document corpus", "workflowId": "wf_mcp_search" }
]
```

The indirection buys real things: the MCP call gets its own trace, its own retry
policy, and its own version history, and it can be tested on its own before an
agent ever touches it.

## Security

The MCP node will POST to any URL a workflow specifies, including internal
addresses. If untrusted users can author workflows, restrict egress — see
[security.md](security.md).

## Roadmap

Exposing FlowForge itself **as** an MCP server — so a workflow becomes a tool an
external agent can call — is planned but not implemented.
