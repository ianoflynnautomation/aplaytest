import { describe, expect, it } from 'vitest';

import {
  LayoutError,
  decodeSegment,
  encodeSegment,
  parseRunBlobName,
  partitionOf,
  runBlobName,
  runsPrefix,
} from '../src/layout.js';

describe('run blob names', () => {
  it('puts the date, run id and shard in the path', () => {
    expect(runBlobName('', '2026-08-30T12:00:00.000Z', 'run-7', '2-of-4')).toBe(
      'v1/runs/2026/08/30/run-7/2-of-4.json.gz',
    );
  });

  it('honours a container prefix', () => {
    expect(runBlobName('bjjeire/', '2026-08-30T12:00:00.000Z', 'r', 'all')).toBe(
      'bjjeire/v1/runs/2026/08/30/r/all.json.gz',
    );
  });

  /**
   * The idempotence guarantee, stated as an assertion: the same shard of the
   * same run always computes the same name, so a re-ingest overwrites itself
   * rather than appending a duplicate. This is what replaces the scoped-delete
   * and UPSERT dance the SQL driver needs.
   */
  it('is a pure function of (run, shard), so a re-ingest overwrites itself', () => {
    const first = runBlobName('', '2026-08-30T12:00:00.000Z', 'run-7', '2-of-4');
    const again = runBlobName('', '2026-08-30T12:30:00.000Z', 'run-7', '2-of-4');
    expect(again).toBe(first);
  });

  it('gives different shards of one run different names, so they cannot collide', () => {
    const one = runBlobName('', '2026-08-30T12:00:00.000Z', 'r', '1-of-3');
    const two = runBlobName('', '2026-08-30T12:00:00.000Z', 'r', '2-of-3');
    expect(one).not.toBe(two);
  });

  it('round-trips through the listing, so run ids need no downloads to recover', () => {
    const name = runBlobName('p/', '2026-08-30T12:00:00.000Z', 'run-7', '2-of-4');
    expect(parseRunBlobName('p/', name)).toEqual({
      runId: 'run-7',
      shardKey: '2-of-4',
      date: '2026-08-30',
    });
  });

  it('ignores anything that is not a run record blob', () => {
    expect(parseRunBlobName('', 'v1/runs/2026/08/30/r/all.json')).toBeNull();
    expect(parseRunBlobName('', 'v2/runs/2026/08/30/r/all.json.gz')).toBeNull();
    expect(parseRunBlobName('', 'v1/runs/2026/08/r/all.json.gz')).toBeNull();
    expect(parseRunBlobName('p/', 'v1/runs/2026/08/30/r/all.json.gz')).toBeNull();
  });

  it('shares one listing prefix, so a read never scans the whole container', () => {
    expect(runsPrefix('bjjeire/')).toBe('bjjeire/v1/runs/');
    expect(runBlobName('bjjeire/', '2026-08-30T00:00:00Z', 'r', 'all')).toContain(
      runsPrefix('bjjeire/'),
    );
  });
});

describe('segment encoding', () => {
  /**
   * Run ids come from `ATEST_RUN_ID`, which in CI is whatever the pipeline put
   * there. A `/` would silently add a directory level and break parsing.
   */
  it('survives characters a run id can legally contain', () => {
    for (const value of ['run-7', 'refs/heads/main', 'a b#c', '2026-08-30T12:00:00Z', 'ünïcode']) {
      expect(decodeSegment(encodeSegment(value))).toBe(value);
    }
  });

  it('never emits a path separator', () => {
    expect(encodeSegment('refs/heads/main')).not.toContain('/');
  });

  it('encodes its own escape character, so encoding stays reversible', () => {
    expect(decodeSegment(encodeSegment('a~2fb'))).toBe('a~2fb');
  });

  it('parses a run id back out of a name that needed encoding', () => {
    const name = runBlobName('', '2026-08-30T00:00:00Z', 'refs/heads/main', 'all');
    expect(parseRunBlobName('', name)?.runId).toBe('refs/heads/main');
  });
});

describe('partitionOf', () => {
  it('derives the date partition from the run start', () => {
    expect(partitionOf('2026-08-30T12:00:00.000Z')).toBe('2026/08/30');
  });

  /**
   * Thrown, not defaulted. Filed under today a bad record looks current
   * forever and never prunes; filed under the epoch it vanishes from every
   * window. `ingestDirectory` turns this into a reported skip, which is the
   * visible failure both silent ones are worth trading for.
   */
  it('refuses a record whose start time cannot be read', () => {
    expect(() => partitionOf('not-a-date')).toThrow(LayoutError);
    expect(() => partitionOf('')).toThrow(LayoutError);
  });
});
