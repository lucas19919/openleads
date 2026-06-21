import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config'
import { OpenLeadsClient } from './client'
import { tools } from './tools'

// Entry point: build the McpServer, register the 9 OpenLeads tools, and serve
// over stdio. CRITICAL: stdout is the JSON-RPC channel — a single console.log
// would corrupt the protocol stream. ALL diagnostics go to console.error
// (stderr), which the host surfaces as server logs.

async function main(): Promise<void> {
  // Fail-closed config: throws (German) before we connect if env is bad.
  const config = loadConfig()
  const client = new OpenLeadsClient(config)

  const server = new McpServer({
    name: 'openleads',
    version: '0.1.0',
  })

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      // The SDK validates args against inputSchema before invoking us, so the
      // handler receives a typed object. We bind the shared client. The cast
      // bridges our ToolResult to the SDK's CallToolResult (which carries an
      // index signature for optional structured fields we don't emit).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) => tool.handler(args, client) as Promise<any>,
    )
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`OpenLeads MCP-Server läuft (stdio), ${tools.length} Tools registriert.`)
}

main().catch((err: unknown) => {
  console.error('OpenLeads MCP-Server konnte nicht starten:', (err as Error)?.message ?? err)
  process.exit(1)
})
