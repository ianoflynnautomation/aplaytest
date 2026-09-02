/**
 * Programmatic entry point for the commands the CLI and tests invoke.
 *
 * MCP talks to the same engines (`@atest/heal`, `@atest/flaky`, …) rather than
 * importing this package — a façade over engines, not a second copy of the
 * CLI parser.
 */
export { doctor } from './commands/doctor.js';
export { flakyBisect } from './commands/bisect.js';
export { heal, healList, healRevert } from './commands/heal.js';
export { impact } from './commands/impact.js';
export { ciGenerate } from './commands/ci.js';
export type { CiFlags } from './commands/ci.js';
export type { ImpactFlags } from './commands/impact.js';
export type { HealFlags } from './commands/heal.js';
export type { BisectFlags } from './commands/bisect.js';
export { flakyReport, flakyQuarantine, flakyRelease, flakyExpire } from './commands/flaky.js';
export type { FlakyFlags } from './commands/flaky.js';
export { EXIT, UsageError, PolicyError } from './exit.js';
export type { ExitCode } from './exit.js';
export { readLedger, writeLedger, upsertEntry, removeEntry, DEFAULT_LEDGER_PATH } from './ledger.js';
