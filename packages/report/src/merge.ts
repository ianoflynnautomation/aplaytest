/**
 * Merge sharded run records into one view.
 *
 * CI writes one record per shard, all carrying the same run id — that is why
 * the reporter lets `ATEST_RUN_ID` win over config. Merging them is what turns
 * four partial pictures into the run someone actually cares about.
 *
 * Deduplication is by `(testId, project, retry)` rather than by array
 * position: shards can overlap after a re-run, and counting an attempt twice
 * would corrupt every number derived from it.
 */

import type { AttemptRecord, RunRecord } from '@aplaytest/core';
import { isFailure } from '@aplaytest/core';

export interface MergedRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly commit: string | null;
  readonly branch: string | null;
  readonly ci: boolean;
  readonly shardsMerged: number;
  readonly attempts: readonly AttemptRecord[];
  readonly totals: {
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    /** Failed then passed on retry within this run — free flake signal. */
    readonly flaky: number;
    readonly skipped: number;
    readonly durationMs: number;
  };
}

function attemptKey(attempt: AttemptRecord): string {
  return `${attempt.testId}::${attempt.project}::${attempt.retry}`;
}

export function mergeRuns(runs: readonly RunRecord[]): MergedRun | null {
  if (runs.length === 0) return null;

  const sorted = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const first = sorted[0];
  if (first === undefined) return null;

  const byKey = new Map<string, AttemptRecord>();
  for (const run of sorted) {
    for (const attempt of run.attempts) byKey.set(attemptKey(attempt), attempt);
  }
  const attempts = [...byKey.values()];

  // Outcome is judged per TEST, not per attempt: a test that failed and then
  // passed on retry is flaky, not failed, and reporting it as failed would
  // make every retried suite look broken.
  const byTest = new Map<string, AttemptRecord[]>();
  for (const attempt of attempts) {
    const key = `${attempt.testId}::${attempt.project}`;
    byTest.set(key, [...(byTest.get(key) ?? []), attempt]);
  }

  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;

  for (const group of byTest.values()) {
    const ordered = [...group].sort((a, b) => a.retry - b.retry);
    const last = ordered[ordered.length - 1];
    if (last === undefined) continue;

    if (last.outcome === 'skipped') skipped += 1;
    else if (isFailure(last.outcome)) failed += 1;
    else if (ordered.some(a => isFailure(a.outcome))) flaky += 1;
    else passed += 1;
  }

  const finished = sorted
    .map(r => r.finishedAt)
    .filter((f): f is string => f !== null)
    .sort();

  return {
    runId: first.runId,
    startedAt: first.startedAt,
    finishedAt: finished[finished.length - 1] ?? null,
    commit: first.commit,
    branch: first.branch,
    ci: first.ci,
    shardsMerged: sorted.length,
    attempts,
    totals: {
      tests: byTest.size,
      passed,
      failed,
      flaky,
      skipped,
      durationMs: attempts.reduce((sum, a) => sum + a.durationMs, 0),
    },
  };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
