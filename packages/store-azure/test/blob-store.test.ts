/**
 * The blob driver, against an in-memory backend.
 *
 * Nothing here talks to Azure, and that is the point: everything that can be
 * wrong with this store — the naming rule, the window, the read-only mode, the
 * merge across shards, what happens to a corrupt object — is independent of
 * the SDK. A driver whose only test is "it worked in CI once" is a driver
 * whose failure modes are discovered by the pipeline it was meant to stabilise.
 */

import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { RUN_SCHEMA_VERSION, type AttemptRecord, type RunRecord } from '@aplaytest/core';

import { BlobHistoryStore } from '../src/blob-store.js';
import { MemoryBlobBackend, type BlobBackend } from '../src/backend.js';
import { runBlobName } from '../src/layout.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    testId: 'test-1',
    title: 'Given a gym name, when a visitor searches, then only that gym is displayed',
    titlePath: ['Gyms'],
    file: 'tests/gyms.spec.ts',
    line: 47,
    project: 'chromium-desktop',
    tags: ['@acceptance'],
    retry: 0,
    outcome: 'passed',
    failureKind: null,
    durationMs: 1200,
    workerIndex: 0,
    shard: null,
    traceId: null,
    evidenceId: null,
    coScheduled: [],
    routes: ['/gyms'],
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: 'run-1',
    startedAt: '2026-08-30T10:00:00.000Z',
    finishedAt: '2026-08-30T10:02:00.000Z',
    commit: 'abc123',
    branch: 'main',
    appEnv: 'ci',
    ci: true,
    workers: 6,
    shard: null,
    atestVersion: '0.0.0',
    playwrightVersion: '1.62.1',
    attempts: [attempt()],
    ...overrides,
  };
}

function store(backend: BlobBackend, options: Record<string, unknown> = {}) {
  return new BlobHistoryStore(backend, { now: () => NOW, ...options });
}

/** Counts reads, so "answered from the listing" can be asserted rather than assumed. */
class CountingBackend implements BlobBackend {
  gets = 0;
  lists = 0;
  constructor(private readonly inner = new MemoryBlobBackend()) {}

  async *list(prefix: string): AsyncIterable<string> {
    this.lists += 1;
    yield* this.inner.list(prefix);
  }

  async get(name: string) {
    this.gets += 1;
    return this.inner.get(name);
  }

  put(name: string, body: Uint8Array, contentType: string) {
    return this.inner.put(name, body, contentType);
  }

  remove(name: string) {
    return this.inner.remove(name);
  }
}

describe('BlobHistoryStore', () => {
  it('given a run written to the container -> when a second store reads it back -> then the attempt carries its joined run metadata', { tags: ['@unit', '@store-azure'] }, async () => {
    const backend = new MemoryBlobBackend();
    const writer = store(backend);
    await writer.ingest(run());
    await writer.close();

    const reader = store(backend);
    const attempts = await reader.attempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      runId: 'run-1',
      testId: 'test-1',
      startedAt: '2026-08-30T10:00:00.000Z',
      commit: 'abc123',
      ci: true,
      workers: 6,
    });
  });

  it('given two shards of one run -> when both are ingested -> then exactly one object is written per run and shard', { tags: ['@unit', '@store-azure'] }, async () => {
    const backend = new MemoryBlobBackend();
    const writer = store(backend);
    await writer.ingest(run({ runId: 'r', shard: { current: 1, total: 2 } }));
    await writer.ingest(run({ runId: 'r', shard: { current: 2, total: 2 } }));

    expect(backend.names()).toEqual([
      'v1/runs/2026/08/30/r/1-of-2.json.gz',
      'v1/runs/2026/08/30/r/2-of-2.json.gz',
    ]);
  });

  /**
   * The property the SQLite driver needed a scoped DELETE and an UPSERT to get,
   * and got wrong twice. Here it is a consequence of the name.
   */
  it('given a two-shard run where one shard is re-ingested -> when the container is read back -> then the shard is overwritten rather than duplicated', { tags: ['@unit', '@store-azure'] }, async () => {
    const backend = new MemoryBlobBackend();
    const writer = store(backend);
    await writer.ingest(run({ runId: 'r', shard: { current: 1, total: 2 }, attempts: [attempt({ testId: 'a' })] }));
    await writer.ingest(run({ runId: 'r', shard: { current: 2, total: 2 }, attempts: [attempt({ testId: 'b' })] }));
    await writer.ingest(run({ runId: 'r', shard: { current: 1, total: 2 }, attempts: [attempt({ testId: 'a2' })] }));
    await writer.close();

    expect(backend.size).toBe(2);

    const reader = store(backend);
    expect(await reader.runCount()).toBe(1);
    expect((await reader.attempts()).map(a => a.testId).sort()).toEqual(['a2', 'b']);
  });

  /**
   * Two overlapping main-branch runs were the failure the conditional-PUT
   * design could not survive: one lost the ETag race and either failed the
   * step or discarded the other's attempts. Different names, no race.
   */
  it('given two runs writing concurrently -> when the container is read back -> then both runs and their attempts survive', { tags: ['@unit', '@store-azure'] }, async () => {
    const backend = new MemoryBlobBackend();
    const a = store(backend);
    const b = store(backend);
    await Promise.all([
      a.ingest(run({ runId: 'run-a', attempts: [attempt({ testId: 'a' })] })),
      b.ingest(run({ runId: 'run-b', attempts: [attempt({ testId: 'b' })] })),
    ]);

    const reader = store(backend);
    expect(await reader.runCount()).toBe(2);
    expect((await reader.attempts()).map(a2 => a2.testId).sort()).toEqual(['a', 'b']);
  });

  it('given three runs in the container -> when runCount is read -> then the count comes from the listing with no downloads', { tags: ['@unit', '@store-azure'] }, async () => {
    const backend = new CountingBackend();
    const writer = store(backend);
    for (const runId of ['r1', 'r2', 'r3']) await writer.ingest(run({ runId }));
    await writer.close();

    const reader = store(backend);
    expect(await reader.runCount()).toBe(3);
    expect(backend.gets).toBe(0);
  });

  /**
   * `analyzeAll` calls attempts() twice per (test, project). A store that went
   * to the network per call would take minutes; the window is fetched once.
   */
  it('given three runs and three successive queries -> when the store answers them -> then the window is listed once and each object downloaded once', { tags: ['@unit', '@store-azure'] }, async () => {
    const backend = new CountingBackend();
    const writer = store(backend);
    for (const runId of ['r1', 'r2', 'r3']) await writer.ingest(run({ runId }));
    await writer.close();

    const reader = store(backend);
    await reader.attempts();
    await reader.attempts({ testId: 'test-1' });
    await reader.testKeys();

    expect(backend.gets).toBe(3);
    expect(backend.lists).toBe(1);
  });

  it('given an ancient run and a recent one -> when a 30-day window is read -> then only the recent run is returned and the old record is skipped rather than deleted', { tags: ['@unit', '@store-azure'] }, async () => {
    const backend = new MemoryBlobBackend();
    const writer = store(backend, { windowDays: null });
    await writer.ingest(run({ runId: 'ancient', startedAt: '2025-01-01T00:00:00.000Z' }));
    await writer.ingest(run({ runId: 'recent', startedAt: '2026-08-29T00:00:00.000Z' }));
    await writer.close();

    const windowed = store(backend, { windowDays: 30 });
    expect(await windowed.runCount()).toBe(1);
    expect((await windowed.attempts()).map(a => a.runId)).toEqual(['recent']);

    // The old record was skipped, not deleted — a shorter read window is not a
    // retention decision.
    const everything = store(backend, { windowDays: null });
    expect(await everything.runCount()).toBe(2);
  });

  describe('read-only', () => {
    /**
     * The pull-request configuration. Azure would refuse the write anyway —
     * the PR identity holds Reader — but as a 403 per shard file after four
     * retries each, which turns a correct policy into a slow job.
     */
    it('given a read-only store and an existing baseline -> when a branch run is ingested -> then it is scored against the baseline and nothing is written', { tags: ['@unit', '@store-azure'] }, async () => {
      const backend = new MemoryBlobBackend();
      const trunk = store(backend);
      await trunk.ingest(run({ runId: 'main-1', attempts: [attempt({ testId: 'baseline' })] }));
      await trunk.close();

      const pr = store(backend, { readOnly: true });
      await pr.ingest(run({ runId: 'pr-1', attempts: [attempt({ testId: 'from-the-branch' })] }));

      expect((await pr.attempts()).map(a => a.testId).sort()).toEqual([
        'baseline',
        'from-the-branch',
      ]);
      // Nothing left behind: the container still holds only the trunk record.
      expect(backend.names()).toEqual(['v1/runs/2026/08/30/main-1/all.json.gz']);
    });

    it('given a read-only store -> when prune is called -> then it rejects rather than reporting a success that deleted nothing', { tags: ['@unit', '@store-azure'] }, async () => {
      const pr = store(new MemoryBlobBackend(), { readOnly: true });
      await expect(pr.prune('2026-01-01T00:00:00.000Z')).rejects.toThrow(/read-only/);
    });
  });

  describe('prune', () => {
    it('given an old run and a recent one -> when prune runs with a cutoff between them -> then the old day is deleted and the recent run survives', { tags: ['@unit', '@store-azure'] }, async () => {
      const backend = new MemoryBlobBackend();
      const writer = store(backend, { windowDays: null });
      await writer.ingest(run({ runId: 'old', startedAt: '2026-01-01T00:00:00.000Z' }));
      await writer.ingest(run({ runId: 'new', startedAt: '2026-08-29T00:00:00.000Z' }));
      await writer.close();

      const pruner = store(backend, { windowDays: null });
      expect(await pruner.prune('2026-06-01T00:00:00.000Z')).toBe(1);
      expect(await pruner.runCount()).toBe(1);
      expect((await pruner.attempts()).map(a => a.runId)).toEqual(['new']);
      expect(backend.size).toBe(1);
    });

    it('given three shards of one old run -> when prune removes them -> then one run is reported removed and every object is gone', { tags: ['@unit', '@store-azure'] }, async () => {
      const backend = new MemoryBlobBackend();
      const writer = store(backend, { windowDays: null });
      for (const current of [1, 2, 3]) {
        await writer.ingest(
          run({ runId: 'r', startedAt: '2026-01-01T00:00:00.000Z', shard: { current, total: 3 } }),
        );
      }
      await writer.close();

      expect(await store(backend, { windowDays: null }).prune('2026-06-01T00:00:00.000Z')).toBe(1);
      expect(backend.size).toBe(0);
    });
  });

  describe('robustness', () => {
    /**
     * One unreadable object among two thousand must not cost the other 1,999 —
     * the same contract `ingestDirectory` holds for files. Reported, though:
     * a store quietly reading less than it holds is indistinguishable from one
     * that is simply young, and both say "insufficient data".
     */
    it('given a corrupt object beside a good one -> when the store reads the window -> then the good run is returned and the corrupt object is reported as skipped', { tags: ['@unit', '@store-azure'] }, async () => {
      const backend = new MemoryBlobBackend();
      const writer = store(backend);
      await writer.ingest(run({ runId: 'good' }));
      await writer.close();

      await backend.put(
        runBlobName('', '2026-08-30T00:00:00.000Z', 'corrupt', 'all'),
        gzipSync(Buffer.from('{ not json', 'utf8')),
      );

      const reader = store(backend);
      expect(await reader.attempts()).toHaveLength(1);
      expect(reader.skipped).toHaveLength(1);
      expect(reader.skipped[0]?.name).toContain('corrupt');
    });

    it('given an object written under a future schema version -> when the store reads the window -> then it is skipped and the reason names schemaVersion', { tags: ['@unit', '@store-azure'] }, async () => {
      const backend = new MemoryBlobBackend();
      await backend.put(
        runBlobName('', '2026-08-30T00:00:00.000Z', 'future', 'all'),
        gzipSync(Buffer.from(JSON.stringify({ ...run(), schemaVersion: 99 }), 'utf8')),
      );

      const reader = store(backend);
      expect(await reader.attempts()).toHaveLength(0);
      expect(reader.skipped[0]?.reason).toContain('schemaVersion');
    });

    /** Hand-uploaded records, and anything written before compression existed. */
    it('given an object stored without compression -> when the store reads the window -> then it is read alongside the gzipped ones', { tags: ['@unit', '@store-azure'] }, async () => {
      const backend = new MemoryBlobBackend();
      await backend.put(
        runBlobName('', '2026-08-30T00:00:00.000Z', 'plain', 'all'),
        new TextEncoder().encode(JSON.stringify(run({ runId: 'plain' }))),
      );

      expect(await store(backend).attempts()).toHaveLength(1);
    });

    it('given an object that vanishes between the listing and the download -> when the store reads the window -> then no attempts and no skips are reported', { tags: ['@unit', '@store-azure'] }, async () => {
      const backend = new MemoryBlobBackend();
      const writer = store(backend);
      await writer.ingest(run({ runId: 'vanishing' }));
      await writer.close();

      const racing: BlobBackend = {
        list: prefix => backend.list(prefix),
        get: async () => null,
        put: (n, b, c) => backend.put(n, b, c),
        remove: n => backend.remove(n),
      };

      const reader = store(racing);
      expect(await reader.attempts()).toEqual([]);
      expect(reader.skipped).toEqual([]);
    });

    it('given unrelated objects sharing the container -> when the store counts runs -> then only run records are counted', { tags: ['@unit', '@store-azure'] }, async () => {
      const backend = new MemoryBlobBackend();
      await backend.put('README.txt', new TextEncoder().encode('not a run record'));
      await backend.put('v1/runs/notes.md', new TextEncoder().encode('nor this'));

      const writer = store(backend);
      await writer.ingest(run());
      await writer.close();

      expect(await store(backend).runCount()).toBe(1);
    });

    it('given a run whose start time is not a readable date -> when it is ingested -> then the write is refused naming the ISO 8601 requirement', { tags: ['@unit', '@store-azure'] }, async () => {
      const writer = store(new MemoryBlobBackend());
      await expect(
        writer.ingest(run({ startedAt: 'whenever' })),
      ).rejects.toThrow(/ISO 8601/);
    });
  });

  it('given two stores writing under different prefixes -> when each is read back -> then neither sees the records of the other', { tags: ['@unit', '@store-azure'] }, async () => {
    const backend = new MemoryBlobBackend();
    const java = store(backend, { prefix: 'app/' });
    const tests = store(backend, { prefix: 'suite/' });

    await java.ingest(run({ runId: 'j', attempts: [attempt({ testId: 'java' })] }));
    await tests.ingest(run({ runId: 't', attempts: [attempt({ testId: 'tests' })] }));
    await java.close();
    await tests.close();

    expect((await store(backend, { prefix: 'app/' }).attempts()).map(a => a.testId)).toEqual(
      ['java'],
    );
    expect((await store(backend, { prefix: 'suite/' }).attempts()).map(a => a.testId)).toEqual(
      ['tests'],
    );
  });
});
