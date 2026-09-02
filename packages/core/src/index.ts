/**
 * @aplaytest/core — types, failure taxonomy, locator ranking, and configuration.
 *
 * This package has no Playwright dependency, makes no network calls, and never
 * touches a model. Everything here must be unit-testable in isolation; that
 * constraint is what keeps the engines above it testable too.
 */

// Taxonomy
export {
  FAILURE_KINDS,
  NEVER_HEAL,
  ROUTING,
  healEligibility,
  isHealable,
  countsTowardFlakeStats,
} from './taxonomy/kinds.js';
export type {
  FailureKind,
  HealEligibility,
  FlakeRelevance,
  KindRouting,
} from './taxonomy/kinds.js';

export { classify, listRules } from './taxonomy/classify.js';
export type { Classification, Confidence } from './taxonomy/classify.js';

export {
  parsePlaywrightError,
  splitCallLog,
  stripAnsi,
  stripCodeFrame,
  joinErrors,
} from './taxonomy/parse-error.js';
export type { ParsedError, ErrorLike } from './taxonomy/parse-error.js';

// Locators
export {
  LOCATOR_STRATEGIES,
  STABILITY_RANK,
  MAX_STABILITY_RANK,
  parseLocator,
  stabilityRankOf,
  stabilityDelta,
  testIdDistance,
} from './locator/stability.js';
export type { LocatorStrategy, ParsedLocator } from './locator/stability.js';

// Identity
export { ATEST_VERSION } from './version.js';

// Evidence
export { EVIDENCE_SCHEMA_VERSION, formatFailingStep } from './evidence/types.js';
export { evidenceId, isEvidenceId } from './evidence/id.js';
export type { EvidenceIdParts } from './evidence/id.js';
export { redact, redactString, redactUrl, REDACTED } from './evidence/redact.js';
export {
  EvidenceStore,
  SchemaVersionError,
  loadRunBundles,
  parseEvidenceBundle,
  isEvidenceBundle,
} from './evidence/store.js';
export type { EvidenceStoreOptions, LoadRunBundlesResult, SkippedBundle } from './evidence/store.js';
export type {
  EvidenceBundle,
  EvidenceId,
  ClassifiableFailure,
  LocatorCandidate,
  StepRecord,
  SelectorSource,
  RequestRecord,
  AppSpanRecord,
  Rect,
} from './evidence/types.js';

// History
export { RUN_SCHEMA_VERSION, isFailure, isConclusive } from './history/types.js';
export type { RunRecord, AttemptRecord, Outcome } from './history/types.js';
export { SqliteHistoryStore } from './history/store.js';
export type { HistoryStore, HistoricalAttempt, HistoryQuery, TestKey } from './history/store.js';
export { HistoryIndex, MemoryHistoryStore, shardKeyOf } from './history/memory-index.js';
export {
  parseHistoryUrl,
  describeHistoryTarget,
  HistoryUrlError,
  DEFAULT_BLOB_ENDPOINT_SUFFIX,
} from './history/url.js';
export type {
  HistoryTarget,
  AzureBlobTarget,
  ParseHistoryUrlOptions,
} from './history/url.js';
export { ingestDirectory } from './history/ingest.js';
export { ingestPlaywrightJson } from './history/ingest-playwright.js';
export type { IngestPlaywrightJsonOptions } from './history/ingest-playwright.js';
export { mapPlaywrightReport } from './history/playwright-report.js';
export type {
  JsonReport,
  JsonSuite,
  JsonSpec,
  JsonTest,
  JsonResult,
  MappedReport,
  MapReportOptions,
  RunIdentity,
} from './history/playwright-report.js';
export type { IngestResult } from './history/ingest.js';

// Config
export {
  defineAtestConfig,
  AtestConfigSchema,
  ExecutionModeSchema,
  AggressivenessSchema,
  AGGRESSIVENESS_PRESETS,
} from './config/schema.js';
export type {
  AtestConfig,
  AtestConfigInput,
  AtestUserConfig,
  ResolvedAtestConfig,
  AtestIdentity,
  ExecutionMode,
  Aggressiveness,
} from './config/schema.js';
