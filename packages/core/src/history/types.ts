/**
 * Run and attempt records — the unit of test history.
 *
 * The reporter writes these as JSON; the history store (phase 1) ingests them
 * into SQLite. Keeping the reporter's output a plain file rather than a
 * database write matters: the reporter runs INSIDE the test process, where a
 * native SQLite binding, a migration, or a lock contention bug would become a
 * test failure. The run path stays dependency-light on purpose.
 */

import type { FailureKind } from '../taxonomy/kinds.js';
import type { EvidenceId } from '../evidence/types.js';

export type Outcome = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

export interface AttemptRecord {
  /** Playwright's stable test id — survives a title rename. */
  readonly testId: string;
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly file: string;
  readonly line: number;
  readonly project: string;
  readonly tags: readonly string[];
  readonly retry: number;
  readonly outcome: Outcome;
  readonly failureKind: FailureKind | null;
  readonly durationMs: number;
  readonly workerIndex: number;
  readonly shard: { readonly current: number; readonly total: number } | null;
  /** Joins to OpenTelemetry. Null when the consumer supplies no identity hook. */
  readonly traceId: string | null;
  readonly evidenceId: EvidenceId | null;
  /**
   * Other tests that ran on the same worker. Powers the co-scheduling lift
   * signal used to distinguish test pollution from ordinary flakiness.
   */
  readonly coScheduled: readonly string[];
  /**
   * Routes this test actually visited.
   *
   * Independent of the import graph, and the only signal that can narrow
   * selection in a suite whose specs all import one composed fixture.
   */
  readonly routes: readonly string[];
}

export interface RunRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly commit: string | null;
  readonly branch: string | null;
  readonly appEnv: string | null;
  readonly ci: boolean;
  readonly workers: number;
  readonly shard: { readonly current: number; readonly total: number } | null;
  readonly atestVersion: string;
  readonly playwrightVersion: string | null;
  readonly attempts: readonly AttemptRecord[];
}

export const RUN_SCHEMA_VERSION = 1 as const;

export function isFailure(outcome: Outcome): boolean {
  return outcome === 'failed' || outcome === 'timedOut';
}

/** Skipped and interrupted attempts are not evidence about a test's behaviour. */
export function isConclusive(outcome: Outcome): boolean {
  return outcome === 'passed' || outcome === 'failed' || outcome === 'timedOut';
}
