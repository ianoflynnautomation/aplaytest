/**
 * Deterministic feature extraction.
 *
 * Every value here is measured from recorded attempts. Classification consumes
 * these features; a model is invited only to write prose *after* the class has
 * already been decided. That ordering is what makes a flake verdict
 * reproducible and arguable rather than an opinion.
 */

import { isFailure, type FailureKind, type HistoricalAttempt } from '@atest/core';

export interface FlakeFeatures {
  /** Share of this test's failures landing in its single worst project. */
  readonly projectConcentration: number;
  /**
   * Point-biserial correlation between worker count and failing. −1..1.
   *
   * Reported for context, but NOT used as the load test: with a rare outcome
   * its ceiling collapses. A test that never fails at one worker and fails a
   * third of the time at eight — an unmistakable load dependency — scores only
   * ~0.41, because a 20% base rate caps how high r can reach. Use
   * `workerLoadDelta` to decide; use this to describe.
   */
  readonly workerCorrelation: number;
  /**
   * failureRate(above median workers) − failureRate(at or below).
   *
   * Directly measures "does load make this fail?", is bounded 0..1, and is
   * interpretable without knowing what point-biserial means.
   */
  readonly workerLoadDelta: number;
  /** False when every attempt ran at the same worker count — nothing to compare. */
  readonly workerCountVaried: boolean;
  /** max P(fail | X co-scheduled) / P(fail). >1 means co-scheduling hurts. */
  readonly coScheduleLift: number;
  readonly coScheduleSuspects: readonly string[];
  /** Failing duration ÷ median passing duration. High implies waiting, then giving up. */
  readonly durationRatio: number;
  readonly failureKinds: Readonly<Record<string, number>>;
  /** Failures begin sharply at one commit and persist — a regression, not flake. */
  readonly commitBoundary: boolean;
  /** Distinct commits observed; below 2 the boundary test cannot fire. */
  readonly commitsObserved: number;
  /** Failed then passed inside a single run at one commit. The strongest signal. */
  readonly retryFlips: number;
  readonly totalFailures: number;
  readonly totalAttempts: number;
}

const EMPTY_FEATURES: FlakeFeatures = {
  projectConcentration: 0,
  workerCorrelation: 0,
  workerLoadDelta: 0,
  workerCountVaried: false,
  coScheduleLift: 1,
  coScheduleSuspects: [],
  durationRatio: 1,
  failureKinds: {},
  commitBoundary: false,
  commitsObserved: 0,
  retryFlips: 0,
  totalFailures: 0,
  totalAttempts: 0,
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Pearson correlation; with a 0/1 second variable this is point-biserial. */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  // Zero variance means the variable never moved — no relationship is
  // observable, which is honestly reported as 0 rather than NaN.
  if (varianceX === 0 || varianceY === 0) return 0;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/**
 * Did failures start at a commit and stay?
 *
 * This is the guard that stops a genuine regression being filed as flake. It
 * requires more than one commit in the window: with a single commit there is
 * no boundary to detect, and treating that as a regression would silence every
 * flake on a quiet branch.
 */
function detectCommitBoundary(ordered: readonly HistoricalAttempt[]): boolean {
  const withCommit = ordered.filter(a => a.commit !== null && a.commit !== '');
  const commits = new Set(withCommit.map(a => a.commit));
  if (withCommit.length < 4 || commits.size < 2) return false;

  const firstFailureIndex = withCommit.findIndex(a => isFailure(a.outcome));
  if (firstFailureIndex <= 0) return false;

  const before = withCommit.slice(0, firstFailureIndex);
  const after = withCommit.slice(firstFailureIndex);
  if (before.length === 0 || after.length < 2) return false;

  const beforeFailureRate = before.filter(a => isFailure(a.outcome)).length / before.length;
  const afterFailureRate = after.filter(a => isFailure(a.outcome)).length / after.length;

  return beforeFailureRate === 0 && afterFailureRate >= 0.7;
}

/** Failed then passed within the same run — non-determinism at one commit. */
function countRetryFlips(attempts: readonly HistoricalAttempt[]): number {
  const byRun = new Map<string, HistoricalAttempt[]>();
  for (const attempt of attempts) {
    const existing = byRun.get(attempt.runId) ?? [];
    existing.push(attempt);
    byRun.set(attempt.runId, existing);
  }

  let flips = 0;
  for (const group of byRun.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.retry - b.retry);
    const failedEarly = sorted.slice(0, -1).some(a => isFailure(a.outcome));
    const passedLast = sorted[sorted.length - 1]?.outcome === 'passed';
    if (failedEarly && passedLast) flips += 1;
  }
  return flips;
}

/**
 * Compare the failure rate at the LOWEST observed worker count against the
 * HIGHEST.
 *
 * Deliberately not a median split. Worker counts are heavily skewed in
 * practice — a suite that mostly runs at full parallelism and occasionally in
 * isolation puts the median at the top of the range, leaving the "high" group
 * empty and the signal silently zero. Comparing the extremes answers the
 * actual question ("does more parallelism make this fail?") and cannot be
 * defeated by the shape of the distribution.
 */
function workerLoadSignal(attempts: readonly HistoricalAttempt[]): {
  delta: number;
  varied: boolean;
} {
  const distinct = [...new Set(attempts.map(a => a.workers))].sort((a, b) => a - b);
  if (distinct.length < 2) return { delta: 0, varied: false };

  const lowest = distinct[0];
  const highest = distinct[distinct.length - 1];
  if (lowest === undefined || highest === undefined) return { delta: 0, varied: false };

  const low = attempts.filter(a => a.workers === lowest);
  const high = attempts.filter(a => a.workers === highest);
  if (low.length === 0 || high.length === 0) return { delta: 0, varied: false };

  const rate = (group: readonly HistoricalAttempt[]): number =>
    group.filter(a => isFailure(a.outcome)).length / group.length;

  return { delta: rate(high) - rate(low), varied: true };
}

function coScheduleSignal(attempts: readonly HistoricalAttempt[]): {
  lift: number;
  suspects: string[];
} {
  const total = attempts.length;
  const failures = attempts.filter(a => isFailure(a.outcome)).length;
  if (total === 0 || failures === 0) return { lift: 1, suspects: [] };

  const baseRate = failures / total;
  const withPeer = new Map<string, { runs: number; failures: number }>();

  for (const attempt of attempts) {
    for (const peer of attempt.coScheduled) {
      const stat = withPeer.get(peer) ?? { runs: 0, failures: 0 };
      stat.runs += 1;
      if (isFailure(attempt.outcome)) stat.failures += 1;
      withPeer.set(peer, stat);
    }
  }

  let bestLift = 1;
  const suspects: string[] = [];
  for (const [peer, stat] of withPeer) {
    // Require a few co-occurrences before believing a lift; two runs can make
    // anything look causal.
    if (stat.runs < 3) continue;
    const lift = stat.failures / stat.runs / baseRate;
    if (lift > 1.5) suspects.push(peer);
    if (lift > bestLift) bestLift = lift;
  }

  return { lift: bestLift, suspects: suspects.slice(0, 5) };
}

/**
 * @param scoped   attempts for the (test, project) under analysis
 * @param allProjects attempts for the same test across every project, used
 *                 only for the concentration signal
 */
export function extractFeatures(
  scoped: readonly HistoricalAttempt[],
  allProjects: readonly HistoricalAttempt[] = scoped,
): FlakeFeatures {
  if (scoped.length === 0) return EMPTY_FEATURES;

  const ordered = [...scoped].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const failures = ordered.filter(a => isFailure(a.outcome));
  const passes = ordered.filter(a => a.outcome === 'passed');

  const failuresByProject = new Map<string, number>();
  for (const attempt of allProjects.filter(a => isFailure(a.outcome))) {
    failuresByProject.set(attempt.project, (failuresByProject.get(attempt.project) ?? 0) + 1);
  }
  const totalCrossProjectFailures = [...failuresByProject.values()].reduce((a, b) => a + b, 0);
  const projectConcentration =
    totalCrossProjectFailures === 0
      ? 0
      : Math.max(...failuresByProject.values()) / totalCrossProjectFailures;

  const failureKinds: Record<string, number> = {};
  for (const attempt of failures) {
    const kind: FailureKind | 'unclassified' = attempt.failureKind ?? 'unclassified';
    failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
  }

  const medianPassDuration = median(passes.map(a => a.durationMs));
  const medianFailDuration = median(failures.map(a => a.durationMs));
  const durationRatio =
    medianPassDuration > 0 ? medianFailDuration / medianPassDuration : failures.length > 0 ? 2 : 1;

  const { lift, suspects } = coScheduleSignal(ordered);
  const load = workerLoadSignal(ordered);

  return {
    projectConcentration,
    workerCorrelation: correlation(
      ordered.map(a => a.workers),
      ordered.map(a => (isFailure(a.outcome) ? 1 : 0)),
    ),
    workerLoadDelta: load.delta,
    workerCountVaried: load.varied,
    coScheduleLift: lift,
    coScheduleSuspects: suspects,
    durationRatio,
    failureKinds,
    commitBoundary: detectCommitBoundary(ordered),
    commitsObserved: new Set(ordered.map(a => a.commit).filter(c => c !== null && c !== '')).size,
    retryFlips: countRetryFlips(ordered),
    totalFailures: failures.length,
    totalAttempts: ordered.length,
  };
}
