/**
 * Programmatic entry point.
 *
 * The commands are exported so the MCP server can call the identical function
 * the CLI calls. If a capability exists in one surface and not the other, that
 * is a bug in the adapter rather than a missing feature.
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
