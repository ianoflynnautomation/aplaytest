import { describe, expect, it } from 'vitest';

import { runFileName } from '../src/reporter.js';

/**
 * REGRESSION GUARD, measured on a real three-shard run.
 *
 * The reporter named its output `<runId>.json`. Every shard shares one run id
 * — deliberately, so the shards can be merged — so every shard wrote the same
 * filename. Shard 1 recorded four attempts; shard 3 had no tests, and its
 * empty record overwrote the lot. The surviving file reported `attempts: 0`
 * for a run in which four tests passed.
 *
 * It survives the artifact upload too: CI downloads with `merge-multiple`,
 * which flattens shard artifacts into one directory where identical names
 * collide again.
 */
describe('runFileName', () => {
  const shard = (current: number, total: number) => ({ current, total });

  it('gives each shard of one run a distinct name', () => {
    const names = new Set([
      runFileName('run-42', shard(1, 3), ['chromium']),
      runFileName('run-42', shard(2, 3), ['chromium']),
      runFileName('run-42', shard(3, 3), ['chromium']),
    ]);
    expect(names.size).toBe(3);
  });

  it('separates two projects running the SAME shard number', () => {
    // Their matrix varies project and shard together, so shard alone is not
    // a unique key.
    const a = runFileName('run-42', shard(1, 3), ['api']);
    const b = runFileName('run-42', shard(1, 3), ['chromium-desktop']);
    expect(a).not.toBe(b);
  });

  it('is deterministic — re-running a shard produces the same name', () => {
    // Ingest is idempotent per file; a random suffix would make every re-run
    // look like new history.
    expect(runFileName('run-42', shard(2, 5), ['api'])).toBe(
      runFileName('run-42', shard(2, 5), ['api']),
    );
  });

  it('keeps the plain name when the run is not sharded', () => {
    expect(runFileName('run-42', null, ['chromium'])).toBe('run-42-chromium.json');
  });

  it('collapses many projects to a stable hash rather than a long name', () => {
    const many = ['a11y', 'api', 'chromium-desktop', 'firefox-desktop', 'mobile-iphone'];
    const name = runFileName('run-42', shard(1, 6), many);
    expect(name.length).toBeLessThan(60);
    expect(name).toBe(runFileName('run-42', shard(1, 6), [...many].reverse()));
  });

  it('sanitises characters that are not safe in a filename', () => {
    expect(runFileName('run/42', null, ['a b'])).not.toMatch(/[/\\ ]/);
  });
});
