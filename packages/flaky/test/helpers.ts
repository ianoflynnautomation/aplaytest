import type { HistoricalAttempt, Outcome } from '@atest/core';

export const DAY = 86_400_000;
export const NOW = Date.parse('2026-08-16T12:00:00.000Z');

export interface AttemptSpec {
  readonly outcome: Outcome;
  /** Days before NOW that the run started. */
  readonly daysAgo: number;
  readonly project?: string;
  readonly workers?: number;
  readonly retry?: number;
  readonly runId?: string;
  readonly commit?: string | null;
  readonly failureKind?: HistoricalAttempt['failureKind'];
  readonly durationMs?: number;
  readonly coScheduled?: readonly string[];
}

export function attempt(spec: AttemptSpec, index = 0): HistoricalAttempt {
  return {
    testId: 'test-1',
    title: 'Given the footer, when a visitor clicks Stores, then the stores page opens',
    titlePath: ['Footer', 'Stores link'],
    file: 'tests/layout/footer.ui.acceptance.spec.ts',
    line: 42,
    project: spec.project ?? 'chromium-desktop',
    tags: ['@acceptance'],
    retry: spec.retry ?? 0,
    outcome: spec.outcome,
    failureKind:
      spec.failureKind ?? (spec.outcome === 'failed' ? 'assertion_value_mismatch' : null),
    durationMs: spec.durationMs ?? 1_000,
    workerIndex: 0,
    shard: null,
    traceId: null,
    evidenceId: null,
    coScheduled: spec.coScheduled ?? [],
    routes: [],
    runId: spec.runId ?? `run-${index}-${spec.daysAgo}`,
    startedAt: new Date(NOW - spec.daysAgo * DAY).toISOString(),
    commit: spec.commit === undefined ? `commit-${spec.daysAgo}` : spec.commit,
    branch: 'main',
    ci: true,
    workers: spec.workers ?? 6,
  };
}

/** Build a series from a compact outcome string: 'P' pass, 'F' fail. Oldest first. */
export function series(
  pattern: string,
  overrides: Omit<AttemptSpec, 'outcome' | 'daysAgo'> = {},
): HistoricalAttempt[] {
  const chars = [...pattern];
  return chars.map((char, i) =>
    attempt(
      {
        ...overrides,
        outcome: char === 'F' ? 'failed' : 'passed',
        // Oldest first: index 0 is the furthest in the past.
        daysAgo: chars.length - 1 - i,
        runId: `run-${i}`,
      },
      i,
    ),
  );
}
