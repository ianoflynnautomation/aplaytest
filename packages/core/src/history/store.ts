/**
 * Test history — the substrate the flaky engine reasons over.
 *
 * Backed by `node:sqlite`, which ships with Node. That is a deliberate choice
 * over `better-sqlite3`: a native module would need a compiler on every
 * developer machine and every CI image, and the first time it failed to build
 * people would disable the tool rather than debug it. Zero native
 * dependencies is what makes this adoptable.
 *
 * The interface is async so a Postgres driver can slot in unchanged at scale;
 * the SQLite driver simply resolves immediately.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AttemptRecord, Outcome, RunRecord } from './types.js';
import type { FailureKind } from '../taxonomy/kinds.js';
import type { EvidenceId } from '../evidence/types.js';

/** An attempt joined to the metadata of the run that produced it. */
export interface HistoricalAttempt extends AttemptRecord {
  readonly runId: string;
  /** Run start, ISO 8601 — the clock recency weighting uses. */
  readonly startedAt: string;
  readonly commit: string | null;
  readonly branch: string | null;
  readonly ci: boolean;
  readonly workers: number;
}

export interface HistoryQuery {
  readonly testId?: string;
  readonly project?: string;
  /** Inclusive lower bound on the run's start time, ISO 8601. */
  readonly since?: string;
  /** Most recent N attempts. Applied after ordering by run time, descending. */
  readonly limit?: number;
}

export interface TestKey {
  readonly testId: string;
  readonly project: string;
  readonly title: string;
  readonly file: string;
}

export interface HistoryStore {
  ingest(run: RunRecord): Promise<void>;
  attempts(query?: HistoryQuery): Promise<HistoricalAttempt[]>;
  testKeys(): Promise<TestKey[]>;
  runCount(): Promise<number>;
  prune(olderThanIso: string): Promise<number>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id             TEXT PRIMARY KEY,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  commit_sha         TEXT,
  branch             TEXT,
  app_env            TEXT,
  ci                 INTEGER NOT NULL,
  workers            INTEGER NOT NULL,
  shard_current      INTEGER,
  shard_total        INTEGER,
  atest_version      TEXT NOT NULL,
  playwright_version TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  test_id       TEXT NOT NULL,
  project       TEXT NOT NULL,
  retry         INTEGER NOT NULL,
  title         TEXT NOT NULL,
  title_path    TEXT NOT NULL,
  file          TEXT NOT NULL,
  line          INTEGER NOT NULL,
  tags          TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  failure_kind  TEXT,
  duration_ms   INTEGER NOT NULL,
  worker_index  INTEGER NOT NULL,
  shard_current INTEGER,
  shard_total   INTEGER,
  trace_id      TEXT,
  evidence_id   TEXT,
  co_scheduled  TEXT NOT NULL,
  routes        TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, test_id, project, retry)
);

CREATE INDEX IF NOT EXISTS idx_attempts_test ON attempts(test_id, project);
CREATE INDEX IF NOT EXISTS idx_attempts_outcome ON attempts(outcome, failure_kind);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
`;

interface AttemptRow {
  run_id: string;
  test_id: string;
  project: string;
  retry: number;
  title: string;
  title_path: string;
  file: string;
  line: number;
  tags: string;
  outcome: string;
  failure_kind: string | null;
  duration_ms: number;
  worker_index: number;
  shard_current: number | null;
  shard_total: number | null;
  trace_id: string | null;
  evidence_id: string | null;
  co_scheduled: string;
  routes: string;
  started_at: string;
  commit_sha: string | null;
  branch: string | null;
  ci: number;
  workers: number;
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function toHistoricalAttempt(row: AttemptRow): HistoricalAttempt {
  return {
    runId: row.run_id,
    testId: row.test_id,
    project: row.project,
    retry: row.retry,
    title: row.title,
    titlePath: parseJsonArray(row.title_path),
    file: row.file,
    line: row.line,
    tags: parseJsonArray(row.tags),
    outcome: row.outcome as Outcome,
    failureKind: row.failure_kind as FailureKind | null,
    durationMs: row.duration_ms,
    workerIndex: row.worker_index,
    shard:
      row.shard_current === null || row.shard_total === null
        ? null
        : { current: row.shard_current, total: row.shard_total },
    traceId: row.trace_id,
    evidenceId: row.evidence_id as EvidenceId | null,
    coScheduled: parseJsonArray(row.co_scheduled),
    routes: parseJsonArray(row.routes ?? '[]'),
    startedAt: row.started_at,
    commit: row.commit_sha,
    branch: row.branch,
    ci: row.ci === 1,
    workers: row.workers,
  };
}

/**
 * `undefined` is not bindable by node:sqlite — only `null` is.
 *
 * The distinction never shows up in a hand-written fixture where every field is
 * present, and it is invisible in the type system because `string | null` and a
 * MISSING key both satisfy a `Partial<RunRecord>` shape check. What it produces
 * at runtime is `Provided value cannot be bound to SQLite parameter 6`, which
 * names neither the field nor the file — and because the insert is inside a
 * transaction, the whole batch rolls back. One run record written by a
 * different atest version therefore silently costs you every other record in
 * the directory.
 */
function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export class SqliteHistoryStore implements HistoryStore {
  private readonly db: DatabaseSync;

  constructor(url: string) {
    if (url !== ':memory:') mkdirSync(dirname(url), { recursive: true });
    this.db = new DatabaseSync(url);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /**
   * Idempotent by construction. CI re-runs, shard merges, and repeated
   * artifact ingestion all replay the same run id — double-counting an
   * attempt would silently corrupt every score derived from it.
   */
  async ingest(run: RunRecord): Promise<void> {
    const insertRun = this.db.prepare(`
      -- UPSERT, never INSERT OR REPLACE.
      --
      -- SQLite implements OR REPLACE as DELETE-then-INSERT, so replacing a run
      -- row fires the attempts table's ON DELETE CASCADE. Under sharding every
      -- shard shares one run id, so ingesting shard 2 deleted shard 1's
      -- attempts before writing its own — the shard-scoped delete below cannot
      -- help, because the rows are already gone by the time it runs. Measured:
      -- three shard files carrying four attempts ingested as zero.
      --
      -- DO UPDATE mutates the row in place. No delete, no cascade.
      INSERT INTO runs
        (run_id, started_at, finished_at, commit_sha, branch, app_env, ci, workers,
         shard_current, shard_total, atest_version, playwright_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        finished_at        = excluded.finished_at,
        commit_sha         = excluded.commit_sha,
        branch             = excluded.branch,
        app_env            = excluded.app_env,
        ci                 = excluded.ci,
        workers            = excluded.workers,
        atest_version      = excluded.atest_version,
        playwright_version = excluded.playwright_version
      -- started_at keeps the EARLIEST shard's value, and shard_* are left
      -- alone: a run spanning shards has no single shard number, and letting
      -- the last writer stamp one would misreport the run.
    `);
    // Scoped to THIS shard, not the whole run.
    //
    // `DELETE FROM attempts WHERE run_id = ?` is correct for an unsharded run
    // and catastrophic for a sharded one: every shard shares the run id, so
    // ingesting six shard files left only the sixth shard's attempts — one
    // sixth of the data, with no error anywhere. `IS` rather than `=` because
    // an unsharded record carries NULL, and NULL = NULL is never true.
    const deleteAttempts = this.db.prepare(
      'DELETE FROM attempts WHERE run_id = ? AND shard_current IS ? AND shard_total IS ?',
    );
    const insertAttempt = this.db.prepare(`
      INSERT INTO attempts
        (run_id, test_id, project, retry, title, title_path, file, line, tags, outcome,
         failure_kind, duration_ms, worker_index, shard_current, shard_total,
         trace_id, evidence_id, co_scheduled, routes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('BEGIN');
    try {
      insertRun.run(
        run.runId,
        run.startedAt,
        nullable(run.finishedAt),
        nullable(run.commit),
        nullable(run.branch),
        nullable(run.appEnv),
        run.ci ? 1 : 0,
        run.workers ?? 0,
        run.shard?.current ?? null,
        run.shard?.total ?? null,
        run.atestVersion ?? '',
        nullable(run.playwrightVersion),
      );
      deleteAttempts.run(run.runId, run.shard?.current ?? null, run.shard?.total ?? null);

      for (const attempt of run.attempts) {
        insertAttempt.run(
          run.runId,
          attempt.testId,
          attempt.project,
          attempt.retry,
          attempt.title,
          JSON.stringify(attempt.titlePath ?? []),
          attempt.file,
          attempt.line,
          JSON.stringify(attempt.tags ?? []),
          attempt.outcome,
          nullable(attempt.failureKind),
          attempt.durationMs ?? 0,
          attempt.workerIndex ?? 0,
          // Fall back to the RUN's shard. The scoped delete above matches on
          // these columns, so an attempt that omits its shard while the run
          // declares one would never be cleaned up — a re-run of that shard
          // would leave the previous attempt rows behind and inflate every
          // statistic derived from them. An attempt executed during shard 1
          // of 3 belongs to shard 1 of 3; recording anything else is wrong.
          attempt.shard?.current ?? run.shard?.current ?? null,
          attempt.shard?.total ?? run.shard?.total ?? null,
          nullable(attempt.traceId),
          nullable(attempt.evidenceId),
          JSON.stringify(attempt.coScheduled ?? []),
          JSON.stringify(attempt.routes ?? []),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async attempts(query: HistoryQuery = {}): Promise<HistoricalAttempt[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.testId !== undefined) {
      where.push('a.test_id = ?');
      params.push(query.testId);
    }
    if (query.project !== undefined) {
      where.push('a.project = ?');
      params.push(query.project);
    }
    if (query.since !== undefined) {
      where.push('r.started_at >= ?');
      params.push(query.since);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = query.limit === undefined ? '' : `LIMIT ${Number(query.limit)}`;

    const rows = this.db
      .prepare(
        `SELECT a.*, r.started_at, r.commit_sha, r.branch, r.ci, r.workers
         FROM attempts a JOIN runs r ON r.run_id = a.run_id
         ${clause}
         ORDER BY r.started_at DESC, a.retry ASC
         ${limit}`,
      )
      .all(...params) as unknown as AttemptRow[];

    return rows.map(toHistoricalAttempt);
  }

  async testKeys(): Promise<TestKey[]> {
    const rows = this.db
      .prepare(
        `SELECT test_id, project, title, file FROM attempts
         GROUP BY test_id, project
         ORDER BY file, title`,
      )
      .all() as unknown as { test_id: string; project: string; title: string; file: string }[];

    return rows.map(r => ({
      testId: r.test_id,
      project: r.project,
      title: r.title,
      file: r.file,
    }));
  }

  async runCount(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as unknown as { n: number };
    return row.n;
  }

  async prune(olderThanIso: string): Promise<number> {
    const before = await this.runCount();
    this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(olderThanIso);
    return before - (await this.runCount());
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
