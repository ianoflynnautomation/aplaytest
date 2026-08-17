"use strict";
/**
 * Run and attempt records — the unit of test history.
 *
 * The reporter writes these as JSON; the history store (phase 1) ingests them
 * into SQLite. Keeping the reporter's output a plain file rather than a
 * database write matters: the reporter runs INSIDE the test process, where a
 * native SQLite binding, a migration, or a lock contention bug would become a
 * test failure. The run path stays dependency-light on purpose.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUN_SCHEMA_VERSION = void 0;
exports.isFailure = isFailure;
exports.isConclusive = isConclusive;
exports.RUN_SCHEMA_VERSION = 1;
function isFailure(outcome) {
    return outcome === 'failed' || outcome === 'timedOut';
}
/** Skipped and interrupted attempts are not evidence about a test's behaviour. */
function isConclusive(outcome) {
    return outcome === 'passed' || outcome === 'failed' || outcome === 'timedOut';
}
//# sourceMappingURL=types.js.map