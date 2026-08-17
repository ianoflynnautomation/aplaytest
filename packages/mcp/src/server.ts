/**
 * The MCP server.
 *
 * A façade. It adds no capability the CLI does not have; its value is a
 * different interaction mode — an IDE agent exploring a failure
 * conversationally rather than a human typing commands and reading tables.
 *
 * Two consequences follow from "façade, not a second product": no engine logic
 * lives here, and CI never uses it. CI uses the CLI.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ALL_TOOLS, type ToolContext } from './tools.js';
import { gate, sanitise, safetyFromEnv, type SafetyConfig } from './safety.js';

export interface ServerOptions {
  readonly context: ToolContext;
  readonly safety?: SafetyConfig | undefined;
}

export function createServer(options: ServerOptions): McpServer {
  const safety = options.safety ?? safetyFromEnv();

  const server = new McpServer({
    name: 'atest',
    version: '0.0.0',
  });

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // The SDK takes the raw shape rather than the ZodObject wrapper.
        inputSchema: tool.schema.shape,
      },
      async (rawInput: unknown) => {
        const decision = gate(tool.name, rawInput, safety);
        if (!decision.ok) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${decision.error}: ${decision.message}` }],
          };
        }

        const parsed = tool.schema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `invalid_input: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
              },
            ],
          };
        }

        try {
          const result = await tool.handler(parsed.data, options.context);
          const { text } = sanitise(result, safety);
          return { content: [{ type: 'text' as const, text }] };
        } catch (error) {
          // A tool failure is reported to the client, never thrown into the
          // transport — a crashed server loses the whole session.
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `tool_failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );
  }

  return server;
}

export async function startStdioServer(options: ServerOptions): Promise<void> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
}
