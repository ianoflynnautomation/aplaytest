/**
 * @atest/mcp — a façade over the same engine calls the CLI makes.
 *
 * Read-only by default. Mutating tools need both ATEST_MCP_WRITE=1 and an
 * explicit `confirm: true`, because "the agent changed my files while I was
 * asking it questions" is the failure people rightly fear.
 */

export { createServer, startStdioServer } from './server.js';
export type { ServerOptions } from './server.js';

export { ALL_TOOLS, listFailures, getFailure, flakyQuery, impact, proposeHealTool } from './tools.js';
export type { ToolContext, ToolDefinition } from './tools.js';

export { gate, sanitise, safetyFromEnv, WRITE_TOOLS, DEFAULT_SAFETY } from './safety.js';
export type { SafetyConfig, GateResult } from './safety.js';
