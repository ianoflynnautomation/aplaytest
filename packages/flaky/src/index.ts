/**
 * @atest/flaky — statistical flake detection and root-cause classification.
 *
 * Entirely deterministic. Every number here is measured from recorded
 * attempts; no model is called anywhere in this package. A model may later be
 * asked to phrase a verdict, never to reach one — a flake score that cannot be
 * reproduced is a flake score nobody will act on.
 */

export {
  scoreTest,
  isFlaky,
  usableAttempts,
  wilsonLowerBound,
  DEFAULT_SCORE_CONFIG,
} from './score.js';
export type { FlakeScore, ScoreConfig, ScoreConfidence } from './score.js';

export { extractFeatures, correlation } from './features.js';
export type { FlakeFeatures } from './features.js';

export { classifyFlake, shouldRetry, FLAKE_CLASSES } from './classify.js';
export type { Classification, FlakeClass, Prescription } from './classify.js';

export { analyzeTest, analyzeAll, groupByTestAndProject, DEFAULT_ANALYZE_CONFIG } from './analyze.js';
export type { AnalyzeConfig, FlakyVerdict, FlakyReport } from './analyze.js';

export {
  evaluateQuarantinePolicy,
  effectiveBudget,
  daysUntilExpiry,
  expiryFor,
  renderQuarantineComment,
  DEFAULT_QUARANTINE_POLICY,
} from './quarantine.js';
export type { QuarantineEntry, QuarantinePolicy, PolicyResult, PolicyViolation } from './quarantine.js';

export { quarantineCodemod, releaseCodemod, QUARANTINE_TAG } from './codemod.js';
export type { CodemodResult, CodemodStatus, QuarantineCodemodInput } from './codemod.js';

export { bisect, interpret, DEFAULT_BISECT_OPTIONS } from './bisect.js';
export type { BisectOptions, BisectResult, BisectProbe, BisectVerdict, BisectDimension } from './bisect.js';
