/**
 * Numeric defaults shared by `atest.config.ts`, the flaky engine, CLI flags,
 * environment variables, and the GitHub analyze workflow.
 *
 * Keep these as the only literals. A second `minRuns: 10` in the engine or
 * a hardcoded `runs < 10` in CI is how the knobs drift apart — the workflow
 * then waits for ten runs while scoring already decided three were enough.
 *
 * Ref: @spec docs/specs/stc/flaky/scoring.md#AC-01
 */

export const FLAKY_DEFAULTS = {
  /** Conclusive attempts required before a (test, project) pair is scored. */
  minRuns: 10,
  /** Recency half-life. A failure this old counts half as much as one today. */
  halfLifeDays: 7,
  /** Score above this is flaky, once `minRuns` is met. */
  threshold: 0.15,
  /** Cap on attempts pulled per (test, project) when analysing. */
  windowRuns: 50,
  /** Calendar window advertised in config (days). */
  windowDays: 14,
} as const;

export const QUARANTINE_DEFAULTS = {
  expiryDays: 14,
  maxTests: 5,
  maxRatio: 0.02,
  tag: '@quarantine',
  policy: 'propose',
} as const;

export const ANALYZE_ENV = {
  minRuns: 'ATEST_FLAKY_MIN_RUNS',
  halfLifeDays: 'ATEST_FLAKY_HALF_LIFE_DAYS',
  threshold: 'ATEST_FLAKY_THRESHOLD',
  windowRuns: 'ATEST_FLAKY_WINDOW_RUNS',
} as const;
