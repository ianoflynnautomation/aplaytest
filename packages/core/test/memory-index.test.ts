/**
 * The memory index is the query engine every non-SQL driver runs on, so these
 * are deliberately the SAME assertions as store.test.ts.
 *
 * Two implementations of "the history" that disagree is the failure this file
 * exists to catch, and it would not surface as an error — it would surface as
 * a flake score that differs between a laptop and CI, months later, with no
 * obvious reason.
 */

import { describe, expect, it } from 'vitest';

import { HistoryIndex, MemoryHistoryStore, shardKeyOf } from '../src/history/memory-index.js';
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

const shardOf = (current: number, total: number) => ({ current, total });

describe('MemoryHistoryStore', () => {
  it('round-trips a run and joins the run metadata onto every attempt', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(run());

    const attempts = await store.attempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      testId: 'test-1',
      project: 'chromium-desktop',
      outcome: 'passed',
      traceId: 'trace-abc',
      startedAt: '2026-08-16T10:00:00.000Z',
      commit: 'abc123',
      ci: true,
      workers: 6,
    });
    expect(attempts[0]?.tags).toEqual(['@acceptance', '@gyms']);
  });

  it('is idempotent — re-ingesting a run does not double-count', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(run());
    await store.ingest(run());
    await store.ingest(run());

    expect(await store.runCount()).toBe(1);
    expect(await store.attempts()).toHaveLength(1);
  });

  it('filters by test, project and time window', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(
      run({ runId: 'old', startedAt: '2026-01-01T00:00:00.000Z' }),
    );
    await store.ingest(
      run({
        runId: 'recent',
        startedAt: '2026-08-15T00:00:00.000Z',
        attempts: [attempt(), attempt({ testId: 'test-2', project: 'webkit-desktop' })],
      }),
    );

    expect(await store.attempts({ testId: 'test-1' })).toHaveLength(2);
    expect(await store.attempts({ project: 'webkit-desktop' })).toHaveLength(1);
    expect(await store.attempts({ since: '2026-06-01T00:00:00.000Z' })).toHaveLength(2);
  });

  it('returns attempts newest-first', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(run({ runId: 'a', startedAt: '2026-08-01T00:00:00.000Z' }));
    await store.ingest(run({ runId: 'b', startedAt: '2026-08-10T00:00:00.000Z' }));

    expect((await store.attempts())[0]?.runId).toBe('b');
  });

  /**
   * The limit is a window over the NEWEST attempts. Applying it before the
   * sort would score an arbitrary subset while looking entirely correct.
   */
  it('applies the limit after ordering, not before', async () => {
    const store = new MemoryHistoryStore();
    for (const [runId, startedAt] of [
      ['a', '2026-08-01T00:00:00.000Z'],
      ['b', '2026-08-02T00:00:00.000Z'],
      ['c', '2026-08-03T00:00:00.000Z'],
    ] as const) {
      await store.ingest(run({ runId, startedAt }));
    }

    const attempts = await store.attempts({ limit: 2 });
    expect(attempts.map(a => a.runId)).toEqual(['c', 'b']);
  });

  it('lists distinct test/project keys', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(
      run({
        attempts: [
          attempt({ testId: 'test-1', project: 'chromium-desktop' }),
          attempt({ testId: 'test-1', project: 'firefox-desktop' }),
        ],
      }),
    );

    const keys = await store.testKeys();
    expect(keys.map(k => k.project).sort()).toEqual(['chromium-desktop', 'firefox-desktop']);
  });

  it('prunes runs older than a cutoff', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(run({ runId: 'old', startedAt: '2026-01-01T00:00:00.000Z' }));
    await store.ingest(run({ runId: 'new', startedAt: '2026-08-15T00:00:00.000Z' }));

    expect(await store.prune('2026-06-01T00:00:00.000Z')).toBe(1);
    expect(await store.runCount()).toBe(1);
    expect(await store.attempts()).toHaveLength(1);
  });

  it('ingests a record whose optional fields are ABSENT rather than null', async () => {
    const store = new MemoryHistoryStore();
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
    const attempts = await store.attempts();
    expect(attempts).toHaveLength(1);
    // Absent must normalise to the same shape a present-and-null field gives,
    // or every consumer needs its own `?? []`.
    expect(attempts[0]?.tags).toEqual([]);
    expect(attempts[0]?.coScheduled).toEqual([]);
    expect(attempts[0]?.routes).toEqual([]);
    expect(attempts[0]?.traceId).toBeNull();
    expect(attempts[0]?.shard).toBeNull();
  });
});

describe('sharding', () => {
  it('accumulates attempts across shards of one run, counted as one run', async () => {
    const store = new MemoryHistoryStore();
    for (const [current, testId] of [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ] as const) {
      await store.ingest(
        run({ runId: 'r', shard: shardOf(current, 3), attempts: [attempt({ testId })] }),
      );
    }

    expect(await store.runCount()).toBe(1);
    expect(await store.attempts()).toHaveLength(3);
  });

  it('re-ingesting ONE shard replaces only that shard', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(
      run({ runId: 'r', shard: shardOf(1, 2), attempts: [attempt({ testId: 'a' })] }),
    );
    await store.ingest(
      run({ runId: 'r', shard: shardOf(2, 2), attempts: [attempt({ testId: 'b' })] }),
    );
    await store.ingest(
      run({ runId: 'r', shard: shardOf(1, 2), attempts: [attempt({ testId: 'a2' })] }),
    );

    expect((await store.attempts()).map(a => a.testId).sort()).toEqual(['a2', 'b']);
  });

  it('still replaces wholesale when the run is not sharded', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(run({ runId: 'r', shard: null, attempts: [attempt({ testId: 'a' })] }));
    await store.ingest(run({ runId: 'r', shard: null, attempts: [attempt({ testId: 'b' })] }));

    expect((await store.attempts()).map(a => a.testId)).toEqual(['b']);
  });

  /**
   * A run spanning shards has no single start time, and letting the last shard
   * ingested stamp one moves the whole run inside or outside the recency
   * window depending on artifact download order — which is not deterministic.
   */
  it('keeps the earliest shard start time as the run start time', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(
      run({ runId: 'r', shard: shardOf(2, 2), startedAt: '2026-08-16T10:05:00.000Z' }),
    );
    await store.ingest(
      run({ runId: 'r', shard: shardOf(1, 2), startedAt: '2026-08-16T10:00:00.000Z' }),
    );

    for (const a of await store.attempts()) {
      expect(a.startedAt).toBe('2026-08-16T10:00:00.000Z');
    }
  });

  it('falls back to the run shard when an attempt does not carry its own', async () => {
    const store = new MemoryHistoryStore();
    await store.ingest(run({ runId: 'r', shard: shardOf(2, 4), attempts: [attempt()] }));

    expect((await store.attempts())[0]?.shard).toEqual({ current: 2, total: 4 });
  });
});

describe('shardKeyOf', () => {
  it('gives unsharded runs one stable key and shards distinct ones', () => {
    expect(shardKeyOf(null)).toBe('all');
    expect(shardKeyOf(undefined)).toBe('all');
    expect(shardKeyOf({ current: 1, total: 3 })).toBe('1-of-3');
    expect(shardKeyOf({ current: 1, total: 3 })).not.toBe(shardKeyOf({ current: 2, total: 3 }));
  });
});

describe('HistoryIndex', () => {
  it('reports which segments it already holds, so a driver can skip downloads', () => {
    const index = new HistoryIndex();
    index.add(run({ runId: 'r', shard: { current: 1, total: 2 } }));

    expect(index.has('r', '1-of-2')).toBe(true);
    expect(index.has('r', '2-of-2')).toBe(false);
  });

  it('names the segments a prune removed, so a driver knows what to delete', () => {
    const index = new HistoryIndex();
    index.add(run({ runId: 'old', startedAt: '2026-01-01T00:00:00.000Z' }));
    index.add(run({ runId: 'new', startedAt: '2026-08-15T00:00:00.000Z' }));

    const result = index.prune('2026-06-01T00:00:00.000Z');
    expect(result.removedRuns).toBe(1);
    expect(result.removedKeys).toEqual(['old\u0000all']);
  });
});
