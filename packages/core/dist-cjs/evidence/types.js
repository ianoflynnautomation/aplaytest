"use strict";
/**
 * The Evidence Bundle — the central data structure of the system.
 *
 * Everything downstream (healing, flaky classification, MCP resources, report
 * insights) consumes this and only this. Engines never re-open a browser to
 * "go look"; if a field is missing, the fix is to capture it at source, not to
 * re-run the test.
 *
 * DESIGN NOTE — nullable, not optional. Fields that may be absent are typed
 * `T | null` rather than `field?: T`. Bundles are written to disk as JSON and
 * read back by other processes (and by humans with `jq`); `undefined`
 * disappears on serialisation, `null` round-trips. Every bundle therefore has
 * the same key set regardless of what was captured.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVIDENCE_SCHEMA_VERSION = void 0;
exports.EVIDENCE_SCHEMA_VERSION = 1;
//# sourceMappingURL=types.js.map