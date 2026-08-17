/**
 * Flakiness scoring.
 *
 * A test is flaky when, holding commit, environment and project fixed, its
 * outcome is non-deterministic. Anything else is a bug, an environment
 * problem, or a real regression — and calling those "flaky" is how suites rot.
 *
 * Raw failure rate is a bad metric on both axes. It is unstable at low `n`,
 * and it treats a six-month-old failure the same as this morning's. Two terms
 * fix that:
 *
 *   Wilson lower bound   — stays conservative while observations are few, so a
 *                          single failure in twelve runs does not brand a test.
 *   Transition density   — distinguishes "was broken, then fixed" (a run of
 *                          failures, low density) from genuine non-determinism
 *                          (alternating outcomes, high density).
 *
 * Neither term alone is sufficient, which the tests demonstrate with worked
 * patterns. No model is involved anywhere in this file.
 */

import { countsTowardFlakeStats, isFailure, type HistoricalAttempt } from '@atest/core';

export type ScoreConfidence = 'low' | 'medium' | 'high';

export interface FlakeScore {
  /** 0..1. Flag above `threshold` once `rawN >= minRuns`. */
  readonly score: number;
  /**
   * Wilson lower bound on the rate of the MINORITY outcome — how confident we
   * are that both outcomes genuinely occur.
   *
   * Not the failure rate. A test that fails 12 times out of 12 has a very high
   * failure rate and zero instability: it is deterministically broken, not
   * flaky. Scoring on the failure rate labelled exactly that case FLAKY at
   * 0.45, which sends a real breakage to the quarantine list instead of to
   * whoever broke it.
   */
  readonly instability: number;
  readonly transitionDensity: number;
  /** Sum of recency weights — the effective sample size. */
  readonly weightedN: number;
  readonly rawN: number;
  readonly failures: number;
  readonly confidence: ScoreConfidence;
  /** True when there were too few conclusive attempts to say anything. */
  readonly insufficientData: boolean;
}

export interface ScoreConfig {
  readonly minRuns: number;
  readonly halfLifeDays: number;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  minRuns: 10,
  halfLifeDays: 7,
};

/** 95% confidence. */
const Z = 1.96;
const MS_PER_DAY = 86_400_000;

const EMPTY: FlakeScore = {
  score: 0,
  instability: 0,
  transitionDensity: 0,
  weightedN: 0,
  rawN: 0,
  failures: 0,
  confidence: 'low',
  insufficientData: true,
};

/**
 * Attempts that can testify about a test's determinism.
 *
 * `infra` failures (a crashed browser, a dropped port-forward) and skips are
 * excluded: they are facts about the environment, not about the test, and
 * counting them would manufacture flakiness during an outage.
 */
export function usableAttempts(attempts: readonly HistoricalAttempt[]): HistoricalAttempt[] {
  return attempts.filter(
    a =>
      a.outcome !== 'skipped' &&
      a.outcome !== 'interrupted' &&
      (a.failureKind === null || countsTowardFlakeStats(a.failureKind)),
  );
}

/** Wilson score interval, lower bound. Conservative at small n by design. */
export function wilsonLowerBound(successes: number, total: number, z = Z): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denominator);
}

export function scoreTest(
  attempts: readonly HistoricalAttempt[],
  config: ScoreConfig = DEFAULT_SCORE_CONFIG,
  now: number = Date.now(),
): FlakeScore {
  const usable = usableAttempts(attempts);
  const rawN = usable.length;
  const failures = usable.filter(a => isFailure(a.outcome)).length;

  if (rawN < config.minRuns) {
    return { ...EMPTY, rawN, failures };
  }

  // Exponential recency decay: a failure one half-life ago counts half as much
  // as one today, so a fixed test stops being penalised for its history.
  const halfLifeMs = config.halfLifeDays * MS_PER_DAY;
  const weightOf = (attempt: HistoricalAttempt): number => {
    const age = now - Date.parse(attempt.startedAt);
    if (!Number.isFinite(age)) return 1;
    return Math.pow(0.5, Math.max(0, age) / halfLifeMs);
  };

  let weightedN = 0;
  let weightedFailures = 0;
  for (const attempt of usable) {
    const weight = weightOf(attempt);
    weightedN += weight;
    if (isFailure(attempt.outcome)) weightedFailures += weight;
  }
  const weightedPasses = weightedN - weightedFailures;

  // The MINORITY outcome is what makes a test flaky. All-fail and all-pass are
  // both perfectly deterministic; instability peaks when the two are balanced
  // and is zero at either extreme, regardless of which one dominates.
  const minorityOutcome = Math.min(weightedFailures, weightedPasses);
  const instability = weightedN > 0 ? wilsonLowerBound(minorityOutcome, weightedN) : 0;

  // Ordered oldest-first so a "flip" means a genuine change of outcome over
  // time rather than an artefact of query ordering.
  const ordered = [...usable].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  let flips = 0;
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (previous === undefined || current === undefined) continue;
    if (isFailure(previous.outcome) !== isFailure(current.outcome)) flips += 1;
  }
  const transitionDensity = ordered.length > 1 ? flips / (ordered.length - 1) : 0;

  return {
    score: 0.6 * instability + 0.4 * transitionDensity,
    instability,
    transitionDensity,
    weightedN,
    rawN,
    failures,
    confidence: rawN >= 30 ? 'high' : rawN >= 15 ? 'medium' : 'low',
    insufficientData: false,
  };
}

export function isFlaky(score: FlakeScore, threshold: number): boolean {
  return !score.insufficientData && score.score > threshold;
}
