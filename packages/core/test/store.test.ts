import { describe, expect, it } from 'vitest';

import { SqliteHistoryStore } from '../src/history/store.js';
import { RUN_SCHEMA_VERSION, type AttemptRecord, type RunRecord } from '../src/history/types.js';

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    testId: 'test-1',
    title: 'Given a gym name, when a visitor searches, then only that gym is displayed',
    titlePath: ['Gyms', 'search'],
    file: 'tests/features/gyms/gyms.ui.acceptance.spec.ts',
    line: 47,
    project: 'chromium-desktop',
    tags: ['@acceptance', '@gyms'],
    retry: 0,
    outcome: 'passed',
    failureKind: null,
    durationMs: 1200,
    workerIndex: 2,
    shard: null,
    traceId: 'trace-abc',
    evidenceId: null,
    coScheduled: ['test-2'],
    routes: ['/gyms'],
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: 'run-1',
    startedAt: '2026-08-16T10:00:00.000Z',
    finishedAt: '2026-08-16T10:02:00.000Z',
    commit: 'abc123',
    branch: 'main',
    appEnv: 'local',
    ci: true,
    workers: 6,
    shard: null,
    atestVersion: '0.0.0',
    playwrightVersion: '1.62.1',
    attempts: [attempt()],
    ...overrides,
  };
}

async function store(): Promise<SqliteHistoryStore> {
  return new SqliteHistoryStore(':memory:');
}

describe('SqliteHistoryStore', () => {
  it('given a run carrying one attempt -> when the store ingests it and attempts are read back -> then the run metadata is joined onto the attempt', { tags: ['@integration', '@history-store'] }, async () => {
    const db = await store();
    await db.ingest(run());

    const attempts = await db.attempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      testId: 'test-1',
      project: 'chromium-desktop',
      outcome: 'passed',
      traceId: 'trace-abc',
      // Run metadata is joined on, so scoring has the clock it needs.
      startedAt: '2026-08-16T10:00:00.000Z',
      commit: 'abc123',
      ci: true,
      workers: 6,
    });
    expect(attempts[0]?.tags).toEqual(['@acceptance', '@gyms']);
    expect(attempts[0]?.coScheduled).toEqual(['test-2']);
    await db.close();
  });

  it('given the same run ingested three times -> when runCount and attempts are read -> then one run and one attempt are held', { tags: ['@integration', '@history-store'] }, async () => {
    // CI re-runs, shard merges and repeated artifact ingestion all replay the
    // same run id. Double-counting would silently corrupt every derived score.
    const db = await store();
    await db.ingest(run());
    await db.ingest(run());
    await db.ingest(run());

    expect(await db.runCount()).toBe(1);
    expect(await db.attempts()).toHaveLength(1);
    await db.close();
  });

  it('given a run re-ingested with fewer attempts than before -> when attempts are read -> then the previous attempts are replaced rather than appended', { tags: ['@integration', '@history-store'] }, async () => {
    const db = await store();
    await db.ingest(run({ attempts: [attempt(), attempt({ testId: 'test-2', retry: 0 })] }));
    await db.ingest(run({ attempts: [attempt()] }));

    expect(await db.attempts()).toHaveLength(1);
    await db.close();
  });

  it('given one run holding retry 0 and retry 1 of a test -> when attempts are read -> then both retries are kept as distinct attempts', { tags: ['@integration', '@history-store'] }, async () => {
    const db = await store();
    await db.ingest(
      run({
        attempts: [
          attempt({ retry: 0, outcome: 'failed', failureKind: 'locator_not_found' }),
          attempt({ retry: 1, outcome: 'passed' }),
        ],
      }),
    );

    const attempts = await db.attempts();
    expect(attempts).toHaveLength(2);
    expect(attempts.map(a => a.retry).sort()).toEqual([0, 1]);
    await db.close();
  });

  it('given an old run and a recent run spanning two projects -> when attempts are filtered by testId, project and since -> then only the matching attempts are returned', { tags: ['@integration', '@history-store'] }, async () => {
    const db = await store();
    await db.ingest(
      run({
        runId: 'old',
        startedAt: '2026-01-01T00:00:00.000Z',
        attempts: [attempt({ testId: 'test-1' })],
      }),
    );
    await db.ingest(
      run({
        runId: 'recent',
        startedAt: '2026-08-15T00:00:00.000Z',
        attempts: [attempt({ testId: 'test-1' }), attempt({ testId: 'test-2', project: 'webkit-desktop' })],
      }),
    );

    expect(await db.attempts({ testId: 'test-1' })).toHaveLength(2);
    expect(await db.attempts({ project: 'webkit-desktop' })).toHaveLength(1);
    expect(await db.attempts({ since: '2026-06-01T00:00:00.000Z' })).toHaveLength(2);
    await db.close();
  });

  it('given two runs with different start times -> when attempts are read -> then the attempt from the newest run comes first', { tags: ['@integration', '@history-store'] }, async () => {
    const db = await store();
    await db.ingest(run({ runId: 'a', startedAt: '2026-08-01T00:00:00.000Z' }));
    await db.ingest(run({ runId: 'b', startedAt: '2026-08-10T00:00:00.000Z' }));

    const attempts = await db.attempts();
    expect(attempts[0]?.runId).toBe('b');
    await db.close();
  });

  it('given one run holding the same test on two projects -> when testKeys is read -> then both distinct test and project keys are listed', { tags: ['@integration', '@history-store'] }, async () => {
    const db = await store();
    await db.ingest(
      run({
        attempts: [
          attempt({ testId: 'test-1', project: 'chromium-desktop' }),
          attempt({ testId: 'test-1', project: 'firefox-desktop' }),
        ],
      }),
    );

    const keys = await db.testKeys();
    expect(keys).toHaveLength(2);
    expect(keys.map(k => k.project).sort()).toEqual(['chromium-desktop', 'firefox-desktop']);
    await db.close();
  });

  it('given an old run and a recent run -> when prune runs with a cutoff between them -> then the old run is removed and the delete cascades to its attempts', { tags: ['@integration', '@history-store'] }, async () => {
    const db = await store();
    await db.ingest(run({ runId: 'old', startedAt: '2026-01-01T00:00:00.000Z' }));
    await db.ingest(run({ runId: 'new', startedAt: '2026-08-15T00:00:00.000Z' }));

    expect(await db.prune('2026-06-01T00:00:00.000Z')).toBe(1);
    expect(await db.runCount()).toBe(1);
    expect(await db.attempts()).toHaveLength(1);
    await db.close();
  });
});

describe('ingest robustness', () => {
  /**
   * REGRESSION GUARD, found while wiring persistent CI history.
   *
   * `ingestDirectory` documents that a bad file is "SKIPPED and reported,
   * never thrown: one bad artifact among fifty shards must not cost you the
   * other forty-nine". Only the JSON parse and the shape check were guarded —
   * a record that passed both and then failed at the database threw straight
   * out and rolled back the transaction, taking every good file with it.
   *
   * The trigger was mundane: `undefined` is not bindable by node:sqlite, only
   * `null` is. One optional field ABSENT rather than null produced "Provided
   * value cannot be bound to SQLite parameter 6" — a message naming neither
   * the field nor the file — and history simply stopped accumulating. In CI
   * that surfaces as flake scoring reporting "insufficient data" forever,
   * which looks like the engine working rather than the engine broken.
   */
  it('given a run whose optional attempt fields are ABSENT rather than null -> when the store ingests it -> then the run and its attempt persist instead of failing to bind', { tags: ['@integration', '@history-store'] }, async () => {
    const store = new SqliteHistoryStore(':memory:');
    const bare = {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId: 'bare-run',
      startedAt: '2026-08-16T10:00:00.000Z',
      ci: true,
      attempts: [
        {
          testId: 't1',
          project: 'chromium',
          title: 'a test',
          file: 'tests/x.spec.ts',
          line: 1,
          outcome: 'passed',
          retry: 0,
          durationMs: 10,
          workerIndex: 0,
        },
      ],
    } as unknown as RunRecord;

    await store.ingest(bare);
    expect(await store.runCount()).toBe(1);
    expect(await store.attempts()).toHaveLength(1);
    await store.close();
  });

  it('given three distinct run ids ingested separately -> when runCount and attempts are read -> then all three accumulate, which is the whole point of a file database', { tags: ['@integration', '@history-store'] }, async () => {
    const store = new SqliteHistoryStore(':memory:');
    for (const runId of ['r1', 'r2', 'r3']) {
      await store.ingest(run({ runId }));
    }
    expect(await store.runCount()).toBe(3);
    expect(await store.attempts()).toHaveLength(3);
    await store.close();
  });

  it('given one run id ingested twice -> when runCount and attempts are read -> then the second ingest replaces the first rather than double-counting', { tags: ['@integration', '@history-store'] }, async () => {
    // Shard artifacts get re-downloaded on a re-run; counting twice inflates
    // every statistic derived from them.
    const store = new SqliteHistoryStore(':memory:');
    await store.ingest(run({ runId: 'same' }));
    await store.ingest(run({ runId: 'same' }));
    expect(await store.runCount()).toBe(1);
    expect(await store.attempts()).toHaveLength(1);
    await store.close();
  });
});

describe('sharded ingest', () => {
  /**
   * REGRESSION GUARD, measured end to end.
   *
   * Two independent bugs collapsed a sharded run to a fraction of its data,
   * and both were silent:
   *
   *   1. `DELETE FROM attempts WHERE run_id = ?` — every shard shares the run
   *      id, so ingesting shard 2 wiped shard 1.
   *   2. `INSERT OR REPLACE INTO runs` — SQLite implements that as
   *      DELETE-then-INSERT, which fires the attempts table's ON DELETE
   *      CASCADE. Even with (1) fixed, replacing the run row deleted the
   *      previous shard's attempts before the scoped delete could run.
   *
   * Three shard files carrying four attempts ingested as zero.
   */
  const shardOf = (current: number, total: number) => ({ current, total });

  it('given three shards of one run ingested separately -> when runCount and attempts are read -> then one run accumulates all three attempts', { tags: ['@integration', '@history-store'] }, async () => {
    const store = new SqliteHistoryStore(':memory:');
    await store.ingest(
      run({ runId: 'r', shard: shardOf(1, 3), attempts: [attempt({ testId: 'a' })] }),
    );
    await store.ingest(
      run({ runId: 'r', shard: shardOf(2, 3), attempts: [attempt({ testId: 'b' })] }),
    );
    await store.ingest(
      run({ runId: 'r', shard: shardOf(3, 3), attempts: [attempt({ testId: 'c' })] }),
    );

    expect(await store.runCount()).toBe(1);
    expect(await store.attempts()).toHaveLength(3);
    await store.close();
  });

  it('given a two-shard run where ONE shard is re-ingested -> when attempts are read -> then only the attempts of that shard are replaced', { tags: ['@integration', '@history-store'] }, async () => {
    const store = new SqliteHistoryStore(':memory:');
    await store.ingest(
      run({ runId: 'r', shard: shardOf(1, 2), attempts: [attempt({ testId: 'a' })] }),
    );
    await store.ingest(
      run({ runId: 'r', shard: shardOf(2, 2), attempts: [attempt({ testId: 'b' })] }),
    );
    // Shard 1 re-runs and now reports a different test.
    await store.ingest(
      run({ runId: 'r', shard: shardOf(1, 2), attempts: [attempt({ testId: 'a2' })] }),
    );

    const ids = (await store.attempts()).map(a => a.testId).sort();
    expect(ids).toEqual(['a2', 'b']);
    await store.close();
  });

  it('given an unsharded run ingested twice -> when attempts are read -> then the second ingest replaces the first wholesale', { tags: ['@integration', '@history-store'] }, async () => {
    const store = new SqliteHistoryStore(':memory:');
    await store.ingest(run({ runId: 'r', shard: null, attempts: [attempt({ testId: 'a' })] }));
    await store.ingest(run({ runId: 'r', shard: null, attempts: [attempt({ testId: 'b' })] }));

    const ids = (await store.attempts()).map(a => a.testId);
    expect(ids).toEqual(['b']);
    await store.close();
  });
});
