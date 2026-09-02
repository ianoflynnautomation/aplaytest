/**
 * The query engine, with no storage under it.
 *
 * Every driver ends up answering the same four questions — attempts in a
 * window, distinct test keys, run count, prune — and the SQL that answers them
 * carries semantics that took real incidents to get right: shard-scoped
 * replacement, earliest-shard `startedAt`, ordering before the limit. Writing
 * those a second time in a blob driver would mean maintaining two definitions
 * of "the same history" and discovering the drift months later, as a flake
 * score that differs between local and CI.
 *
 * So the semantics live here, once, over plain objects. `SqliteHistoryStore`
 * keeps its own SQL (it is the local/dev driver and the schema is its own
 * documentation); the Azure driver is this index plus blob I/O, which is the
 * only shape that makes sense when the durable form is an append-only log of
 * run records rather than a queryable database.
 *
 * Pure and synchronous: no clock, no filesystem, no network. That is what
 * makes the query semantics testable without a container or an emulator.
 */

import type { AttemptRecord, Outcome, RunRecord } from './types.js';
import type { FailureKind } from '../taxonomy/kinds.js';
import type { EvidenceId } from '../evidence/types.js';
import type { HistoricalAttempt, HistoryQuery, HistoryStore, TestKey } from './store.js';

/**
 * Identifies the unit that is replaced wholesale on re-ingest.
 *
 * NOT the run id. Under sharding every shard reports the same run id, so
 * keying on it alone means ingesting shard 2 discards shard 1 — the bug that
 * once turned three shard files carrying four attempts into zero. A shard is
 * the smallest thing a re-run can replace, so it is the key.
 */
export function shardKeyOf(shard: { current: number; total: number } | null | undefined): string {
  return shard === null || shard === undefined ? 'all' : `${shard.current}-of-${shard.total}`;
}

/**
 * Composite-key separator. NUL rather than a space or a colon, because a run id
 * is whatever `ATEST_RUN_ID` contained and both of those are legal in one — and
 * `"a b" + sep + "c"` colliding with `"a" + sep + "b c"` would silently merge
 * two runs into one.
 */
const KEY_SEP = '\u0000';

/** A run record as stored: the run's metadata plus one shard's attempts. */
interface Segment {
  readonly runId: string;
  readonly shardKey: string;
  readonly run: RunRecord;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Records reaching here have been shape-checked, not type-checked: `validate()`
 * in ingest.ts asserts a schema version, a run id and an attempts array, and
 * nothing else. A record written by a different atest version can be missing
 * any optional field entirely, and `undefined` where the type says `T | null`
 * propagates into scores as a silent NaN rather than an error.
 */
function normalizeAttempt(
  attempt: AttemptRecord,
  segment: Segment,
  runMeta: RunMetadata,
): HistoricalAttempt {
  return {
    runId: segment.runId,
    testId: attempt.testId,
    project: attempt.project,
    retry: attempt.retry ?? 0,
    title: attempt.title,
    titlePath: asStringArray(attempt.titlePath),
    file: attempt.file,
    line: attempt.line ?? 0,
    tags: asStringArray(attempt.tags),
    outcome: attempt.outcome as Outcome,
    failureKind: (attempt.failureKind ?? null) as FailureKind | null,
    durationMs: attempt.durationMs ?? 0,
    workerIndex: attempt.workerIndex ?? 0,
    // An attempt executed during shard 1 of 3 belongs to shard 1 of 3.
    // Falling back to the run's shard is what keeps the replacement key and
    // the attempt's own record of itself in agreement.
    shard: attempt.shard ?? segment.run.shard ?? null,
    traceId: attempt.traceId ?? null,
    evidenceId: (attempt.evidenceId ?? null) as EvidenceId | null,
    coScheduled: asStringArray(attempt.coScheduled),
    routes: asStringArray(attempt.routes),
    startedAt: runMeta.startedAt,
    commit: runMeta.commit,
    branch: runMeta.branch,
    ci: runMeta.ci,
    workers: runMeta.workers,
  };
}

interface RunMetadata {
  startedAt: string;
  commit: string | null;
  branch: string | null;
  ci: boolean;
  workers: number;
}

/**
 * In-memory history with SQLite's query semantics and none of its storage.
 *
 * Add segments in any order; the answers do not depend on it, except where
 * SQLite's own answers would not either (last writer wins on mutable run
 * metadata).
 */
export class HistoryIndex {
  /** Keyed `runId\x00shardKey` — the replacement unit. */
  private readonly segments = new Map<string, Segment>();

  add(run: RunRecord): void {
    const shardKey = shardKeyOf(run.shard);
    this.segments.set(`${run.runId}${KEY_SEP}${shardKey}`, { runId: run.runId, shardKey, run });
  }

  /** Drop everything, so a driver can reload from its backing store. */
  clear(): void {
    this.segments.clear();
  }

  has(runId: string, shardKey: string): boolean {
    return this.segments.has(`${runId}${KEY_SEP}${shardKey}`);
  }

  /**
   * One metadata row per run id, merged across its shards.
   *
   * `startedAt` takes the EARLIEST value: a run spanning six shards started
   * when its first shard did, and letting the last shard ingested stamp the
   * time would move the run inside the recency window depending on artifact
   * download order. Everything else is last-writer-wins, matching the UPSERT.
   */
  private runMetadata(): Map<string, RunMetadata> {
    const meta = new Map<string, RunMetadata>();
    for (const segment of this.segments.values()) {
      const run = segment.run;
      const existing = meta.get(run.runId);
      if (existing === undefined) {
        meta.set(run.runId, {
          startedAt: run.startedAt,
          commit: run.commit ?? null,
          branch: run.branch ?? null,
          ci: run.ci === true,
          workers: run.workers ?? 0,
        });
        continue;
      }
      if (run.startedAt < existing.startedAt) existing.startedAt = run.startedAt;
      existing.commit = run.commit ?? null;
      existing.branch = run.branch ?? null;
      existing.ci = run.ci === true;
      existing.workers = run.workers ?? 0;
    }
    return meta;
  }

  attempts(query: HistoryQuery = {}): HistoricalAttempt[] {
    const meta = this.runMetadata();
    const rows: HistoricalAttempt[] = [];

    for (const segment of this.segments.values()) {
      const runMeta = meta.get(segment.runId);
      if (runMeta === undefined) continue;
      if (query.since !== undefined && runMeta.startedAt < query.since) continue;

      for (const attempt of segment.run.attempts ?? []) {
        if (query.testId !== undefined && attempt.testId !== query.testId) continue;
        if (query.project !== undefined && attempt.project !== query.project) continue;
        rows.push(normalizeAttempt(attempt, segment, runMeta));
      }
    }

    // `ORDER BY r.started_at DESC, a.retry ASC`, then LIMIT — the limit is a
    // window over the newest attempts, so applying it before the sort would
    // silently score an arbitrary subset. The extra tiebreakers are not in the
    // SQL: SQLite leaves ties unordered, and an unstable order here would make
    // a `--limit`ed score depend on Map iteration order.
    rows.sort(
      (a, b) =>
        b.startedAt.localeCompare(a.startedAt) ||
        a.retry - b.retry ||
        a.runId.localeCompare(b.runId) ||
        a.testId.localeCompare(b.testId) ||
        a.project.localeCompare(b.project),
    );

    return query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit));
  }

  testKeys(): TestKey[] {
    // Newest first, so the title and file a key reports are the ones the test
    // has NOW. SQLite's bare-column GROUP BY picks an arbitrary row, which
    // after a rename reports whichever the query planner happened to visit.
    const keys = new Map<string, TestKey>();
    for (const attempt of this.attempts()) {
      const key = `${attempt.testId}${KEY_SEP}${attempt.project}`;
      if (keys.has(key)) continue;
      keys.set(key, {
        testId: attempt.testId,
        project: attempt.project,
        title: attempt.title,
        file: attempt.file,
      });
    }

    return [...keys.values()].sort(
      (a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title),
    );
  }

  runCount(): number {
    const ids = new Set<string>();
    for (const segment of this.segments.values()) ids.add(segment.runId);
    return ids.size;
  }

  /**
   * Remove runs that started before the cutoff. Returns the number of RUNS
   * dropped, not segments — a six-shard run pruned is one run, which is what
   * `runCount()` counted it as.
   */
  prune(olderThanIso: string): { removedRuns: number; removedKeys: string[] } {
    const meta = this.runMetadata();
    const doomed = new Set<string>();
    for (const [runId, runMeta] of meta) {
      if (runMeta.startedAt < olderThanIso) doomed.add(runId);
    }

    const removedKeys: string[] = [];
    for (const [key, segment] of this.segments) {
      if (!doomed.has(segment.runId)) continue;
      removedKeys.push(key);
      this.segments.delete(key);
    }

    return { removedRuns: doomed.size, removedKeys };
  }
}

/**
 * `HistoryStore` over a `HistoryIndex` and nothing else.
 *
 * This is what `--db :memory:` should always have meant. Reaching for
 * `new SqliteHistoryStore(':memory:')` to get a throwaway store — as the MCP
 * server and `aplaytest impact` both did — pulls in `node:sqlite`, a schema and a
 * transaction to hold data that is discarded when the process exits.
 */
export class MemoryHistoryStore implements HistoryStore {
  private readonly index = new HistoryIndex();

  async ingest(run: RunRecord): Promise<void> {
    this.index.add(run);
  }

  async attempts(query: HistoryQuery = {}): Promise<HistoricalAttempt[]> {
    return this.index.attempts(query);
  }

  async testKeys(): Promise<TestKey[]> {
    return this.index.testKeys();
  }

  async runCount(): Promise<number> {
    return this.index.runCount();
  }

  async prune(olderThanIso: string): Promise<number> {
    return this.index.prune(olderThanIso).removedRuns;
  }

  async close(): Promise<void> {
    this.index.clear();
  }
}
