#!/usr/bin/env node
/**
 * stdio entry point. Configure in a client as:
 *
 *   { "mcpServers": { "atest": { "command": "npx", "args": ["atest-mcp"] } } }
 *
 * Nothing is written to stdout except the protocol itself — a stray log line
 * corrupts the stream and the session dies with no useful error.
 */

import { startStdioServer } from './server.js';
import { safetyFromEnv } from './safety.js';

const cwd = process.env['ATEST_CWD'] ?? process.cwd();

await startStdioServer({
  context: {
    cwd,
    evidenceDir: process.env['ATEST_EVIDENCE_DIR'] ?? `${cwd}/.atest/evidence`,
    runsDir: process.env['ATEST_RUNS_DIR'] ?? `${cwd}/.atest/runs`,
  },
  safety: safetyFromEnv(),
});
