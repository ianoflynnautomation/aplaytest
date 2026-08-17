"use strict";
/**
 * @atest/core — types, failure taxonomy, locator ranking, and configuration.
 *
 * This package has no Playwright dependency, makes no network calls, and never
 * touches a model. Everything here must be unit-testable in isolation; that
 * constraint is what keeps the engines above it testable too.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGGRESSIVENESS_PRESETS = exports.AggressivenessSchema = exports.ExecutionModeSchema = exports.AtestConfigSchema = exports.defineAtestConfig = exports.ingestDirectory = exports.SqliteHistoryStore = exports.isConclusive = exports.isFailure = exports.RUN_SCHEMA_VERSION = exports.SchemaVersionError = exports.EvidenceStore = exports.REDACTED = exports.redactUrl = exports.redactString = exports.redact = exports.isEvidenceId = exports.evidenceId = exports.EVIDENCE_SCHEMA_VERSION = exports.testIdDistance = exports.stabilityDelta = exports.stabilityRankOf = exports.parseLocator = exports.MAX_STABILITY_RANK = exports.STABILITY_RANK = exports.LOCATOR_STRATEGIES = exports.listRules = exports.classify = exports.countsTowardFlakeStats = exports.isHealable = exports.healEligibility = exports.ROUTING = exports.NEVER_HEAL = exports.FAILURE_KINDS = void 0;
// Taxonomy
var kinds_js_1 = require("./taxonomy/kinds.js");
Object.defineProperty(exports, "FAILURE_KINDS", { enumerable: true, get: function () { return kinds_js_1.FAILURE_KINDS; } });
Object.defineProperty(exports, "NEVER_HEAL", { enumerable: true, get: function () { return kinds_js_1.NEVER_HEAL; } });
Object.defineProperty(exports, "ROUTING", { enumerable: true, get: function () { return kinds_js_1.ROUTING; } });
Object.defineProperty(exports, "healEligibility", { enumerable: true, get: function () { return kinds_js_1.healEligibility; } });
Object.defineProperty(exports, "isHealable", { enumerable: true, get: function () { return kinds_js_1.isHealable; } });
Object.defineProperty(exports, "countsTowardFlakeStats", { enumerable: true, get: function () { return kinds_js_1.countsTowardFlakeStats; } });
var classify_js_1 = require("./taxonomy/classify.js");
Object.defineProperty(exports, "classify", { enumerable: true, get: function () { return classify_js_1.classify; } });
Object.defineProperty(exports, "listRules", { enumerable: true, get: function () { return classify_js_1.listRules; } });
// Locators
var stability_js_1 = require("./locator/stability.js");
Object.defineProperty(exports, "LOCATOR_STRATEGIES", { enumerable: true, get: function () { return stability_js_1.LOCATOR_STRATEGIES; } });
Object.defineProperty(exports, "STABILITY_RANK", { enumerable: true, get: function () { return stability_js_1.STABILITY_RANK; } });
Object.defineProperty(exports, "MAX_STABILITY_RANK", { enumerable: true, get: function () { return stability_js_1.MAX_STABILITY_RANK; } });
Object.defineProperty(exports, "parseLocator", { enumerable: true, get: function () { return stability_js_1.parseLocator; } });
Object.defineProperty(exports, "stabilityRankOf", { enumerable: true, get: function () { return stability_js_1.stabilityRankOf; } });
Object.defineProperty(exports, "stabilityDelta", { enumerable: true, get: function () { return stability_js_1.stabilityDelta; } });
Object.defineProperty(exports, "testIdDistance", { enumerable: true, get: function () { return stability_js_1.testIdDistance; } });
// Evidence
var types_js_1 = require("./evidence/types.js");
Object.defineProperty(exports, "EVIDENCE_SCHEMA_VERSION", { enumerable: true, get: function () { return types_js_1.EVIDENCE_SCHEMA_VERSION; } });
var id_js_1 = require("./evidence/id.js");
Object.defineProperty(exports, "evidenceId", { enumerable: true, get: function () { return id_js_1.evidenceId; } });
Object.defineProperty(exports, "isEvidenceId", { enumerable: true, get: function () { return id_js_1.isEvidenceId; } });
var redact_js_1 = require("./evidence/redact.js");
Object.defineProperty(exports, "redact", { enumerable: true, get: function () { return redact_js_1.redact; } });
Object.defineProperty(exports, "redactString", { enumerable: true, get: function () { return redact_js_1.redactString; } });
Object.defineProperty(exports, "redactUrl", { enumerable: true, get: function () { return redact_js_1.redactUrl; } });
Object.defineProperty(exports, "REDACTED", { enumerable: true, get: function () { return redact_js_1.REDACTED; } });
var store_js_1 = require("./evidence/store.js");
Object.defineProperty(exports, "EvidenceStore", { enumerable: true, get: function () { return store_js_1.EvidenceStore; } });
Object.defineProperty(exports, "SchemaVersionError", { enumerable: true, get: function () { return store_js_1.SchemaVersionError; } });
// History
var types_js_2 = require("./history/types.js");
Object.defineProperty(exports, "RUN_SCHEMA_VERSION", { enumerable: true, get: function () { return types_js_2.RUN_SCHEMA_VERSION; } });
Object.defineProperty(exports, "isFailure", { enumerable: true, get: function () { return types_js_2.isFailure; } });
Object.defineProperty(exports, "isConclusive", { enumerable: true, get: function () { return types_js_2.isConclusive; } });
var store_js_2 = require("./history/store.js");
Object.defineProperty(exports, "SqliteHistoryStore", { enumerable: true, get: function () { return store_js_2.SqliteHistoryStore; } });
var ingest_js_1 = require("./history/ingest.js");
Object.defineProperty(exports, "ingestDirectory", { enumerable: true, get: function () { return ingest_js_1.ingestDirectory; } });
// Config
var schema_js_1 = require("./config/schema.js");
Object.defineProperty(exports, "defineAtestConfig", { enumerable: true, get: function () { return schema_js_1.defineAtestConfig; } });
Object.defineProperty(exports, "AtestConfigSchema", { enumerable: true, get: function () { return schema_js_1.AtestConfigSchema; } });
Object.defineProperty(exports, "ExecutionModeSchema", { enumerable: true, get: function () { return schema_js_1.ExecutionModeSchema; } });
Object.defineProperty(exports, "AggressivenessSchema", { enumerable: true, get: function () { return schema_js_1.AggressivenessSchema; } });
Object.defineProperty(exports, "AGGRESSIVENESS_PRESETS", { enumerable: true, get: function () { return schema_js_1.AGGRESSIVENESS_PRESETS; } });
//# sourceMappingURL=index.js.map