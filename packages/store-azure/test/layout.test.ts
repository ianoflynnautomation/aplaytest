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
  it('given a run start, run id and shard key -> when runBlobName builds a name -> then the date, run id and shard appear in the path', { tags: ['@unit', '@store-azure'] }, () => {
    expect(runBlobName('', '2026-08-30T12:00:00.000Z', 'run-7', '2-of-4')).toBe(
      'v1/runs/2026/08/30/run-7/2-of-4.json.gz',
    );
  });

  it('given a container prefix -> when runBlobName builds a name -> then the name is nested under that prefix', { tags: ['@unit', '@store-azure'] }, () => {
    expect(runBlobName('tenant/', '2026-08-30T12:00:00.000Z', 'r', 'all')).toBe(
      'tenant/v1/runs/2026/08/30/r/all.json.gz',
    );
  });

  /**
   * The idempotence guarantee, stated as an assertion: the same shard of the
   * same run always computes the same name, so a re-ingest overwrites itself
   * rather than appending a duplicate. This is what replaces the scoped-delete
   * and UPSERT dance the SQL driver needs.
   */
  it('given the same run and shard at two different clock times -> when runBlobName builds each name -> then both names are identical, so a re-ingest overwrites itself', { tags: ['@unit', '@store-azure'] }, () => {
    const first = runBlobName('', '2026-08-30T12:00:00.000Z', 'run-7', '2-of-4');
    const again = runBlobName('', '2026-08-30T12:30:00.000Z', 'run-7', '2-of-4');
    expect(again).toBe(first);
  });

  it('given two shards of one run -> when runBlobName builds each name -> then the names differ, so the shards cannot collide', { tags: ['@unit', '@store-azure'] }, () => {
    const one = runBlobName('', '2026-08-30T12:00:00.000Z', 'r', '1-of-3');
    const two = runBlobName('', '2026-08-30T12:00:00.000Z', 'r', '2-of-3');
    expect(one).not.toBe(two);
  });

  it('given a name built under a prefix -> when parseRunBlobName reads it back -> then the run id, shard key and date are recovered without a download', { tags: ['@unit', '@store-azure'] }, () => {
    const name = runBlobName('p/', '2026-08-30T12:00:00.000Z', 'run-7', '2-of-4');
    expect(parseRunBlobName('p/', name)).toEqual({
      runId: 'run-7',
      shardKey: '2-of-4',
      date: '2026-08-30',
    });
  });

  it('given names with the wrong extension, version, depth or prefix -> when parseRunBlobName reads each -> then every one is rejected', { tags: ['@unit', '@store-azure'] }, () => {
    expect(parseRunBlobName('', 'v1/runs/2026/08/30/r/all.json')).toBeNull();
    expect(parseRunBlobName('', 'v2/runs/2026/08/30/r/all.json.gz')).toBeNull();
    expect(parseRunBlobName('', 'v1/runs/2026/08/r/all.json.gz')).toBeNull();
    expect(parseRunBlobName('p/', 'v1/runs/2026/08/30/r/all.json.gz')).toBeNull();
  });

  it('given a container prefix -> when runsPrefix and runBlobName are compared -> then every run name sits under one listing prefix', { tags: ['@unit', '@store-azure'] }, () => {
    expect(runsPrefix('tenant/')).toBe('tenant/v1/runs/');
    expect(runBlobName('tenant/', '2026-08-30T00:00:00Z', 'r', 'all')).toContain(
      runsPrefix('tenant/'),
    );
  });
});

describe('segment encoding', () => {
  /**
   * Run ids come from `ATEST_RUN_ID`, which in CI is whatever the pipeline put
   * there. A `/` would silently add a directory level and break parsing.
   */
  it('given run ids holding slashes, spaces, hashes and non-ASCII characters -> when each is encoded and decoded -> then the original value is recovered', { tags: ['@unit', '@store-azure'] }, () => {
    for (const value of ['run-7', 'refs/heads/main', 'a b#c', '2026-08-30T12:00:00Z', 'ünïcode']) {
      expect(decodeSegment(encodeSegment(value))).toBe(value);
    }
  });

  it('given a run id containing slashes -> when encodeSegment encodes it -> then no path separator is emitted', { tags: ['@unit', '@store-azure'] }, () => {
    expect(encodeSegment('refs/heads/main')).not.toContain('/');
  });

  it('given a value containing the escape character itself -> when it is encoded and decoded -> then the original value is recovered', { tags: ['@unit', '@store-azure'] }, () => {
    expect(decodeSegment(encodeSegment('a~2fb'))).toBe('a~2fb');
  });

  it('given a run id that needed encoding -> when parseRunBlobName reads the name -> then the original run id is recovered', { tags: ['@unit', '@store-azure'] }, () => {
    const name = runBlobName('', '2026-08-30T00:00:00Z', 'refs/heads/main', 'all');
    expect(parseRunBlobName('', name)?.runId).toBe('refs/heads/main');
  });
});

describe('partitionOf', () => {
  it('given a run start timestamp -> when partitionOf derives the partition -> then it is the year, month and day of that start', { tags: ['@unit', '@store-azure'] }, () => {
    expect(partitionOf('2026-08-30T12:00:00.000Z')).toBe('2026/08/30');
  });

  /**
   * Thrown, not defaulted. Filed under today a bad record looks current
   * forever and never prunes; filed under the epoch it vanishes from every
   * window. `ingestDirectory` turns this into a reported skip, which is the
   * visible failure both silent ones are worth trading for.
   */
  it('given a start time that is not a readable date -> when partitionOf derives the partition -> then it throws LayoutError rather than defaulting', { tags: ['@unit', '@store-azure'] }, () => {
    expect(() => partitionOf('not-a-date')).toThrow(LayoutError);
    expect(() => partitionOf('')).toThrow(LayoutError);
  });
});
