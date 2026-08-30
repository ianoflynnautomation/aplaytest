import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ingestPlaywrightJson } from '../src/history/ingest-playwright.js';
import { SqliteHistoryStore } from '../src/history/store.js';

const REPORT = {
  config: { version: '1.56.0', workers: 2 },
  suites: [
    {
      title: 'gyms.api.acceptance.spec.ts',
      file: 'tests/features/gyms/gyms.api.acceptance.spec.ts',
      specs: [
        {
          id: 'spec-listed-ok',
          title: 'Given the gyms API, when listed, then the page is valid',
          file: 'tests/features/gyms/gyms.api.acceptance.spec.ts',
          line: 12,
          tags: ['@gyms', '@api'],
          tests: [
            {
              projectName: 'api',
              results: [
                { status: 'passed', duration: 80, retry: 0, workerIndex: 0, startTime: '2026-08-29T13:00:00.000Z' },
              ],
            },
          ],
        },
        {
          id: 'spec-missing-404',
          title: 'Given a missing gym, when fetched, then the API returns 404',
          file: 'tests/features/gyms/gyms.api.acceptance.spec.ts',
          line: 28,
          tags: ['@gyms', '@api'],
          tests: [
            {
              projectName: 'api',
              timeout: 30_000,
              results: [
                {
                  status: 'failed',
                  duration: 40,
                  retry: 0,
                  workerIndex: 0,
                  startTime: '2026-08-29T13:00:01.000Z',
                  errors: [{ message: 'Error: expect(received).toBe(expected)\n\nExpected: 404\nReceived: 500' }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function writeReport(report: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atest-pwjson-'));
  const path = join(dir, 'report.json');
  await writeFile(path, JSON.stringify(report), 'utf8');
  return path;
}

describe('ingestPlaywrightJson', () => {
  it('turns a Playwright JSON report into history attempts', async () => {
    const path = await writeReport(REPORT);

    const store = new SqliteHistoryStore(':memory:');
    const result = await ingestPlaywrightJson(store, path, { identity: { commit: null, branch: null } });
    const attempts = await store.attempts();
    await store.close();

    expect(result.runsIngested).toBe(1);
    expect(result.attemptsIngested).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(attempts.map(a => a.outcome).sort()).toEqual(['failed', 'passed']);

    const failure = attempts.find(a => a.outcome === 'failed');
    expect(failure?.project).toBe('api');
    expect(failure?.testId).toBe('spec-missing-404');
    // Classified from the error text, not hard-coded.
    expect(failure?.failureKind).toBe('assertion_value_mismatch');
  });

  /**
   * `store.ingest` documents itself as "idempotent by construction... repeated
   * artifact ingestion all replay the same run id — double-counting an attempt
   * would silently corrupt every score derived from it." A clock-derived run id
   * opted out of that guarantee without saying so, and re-running a CI analyze
   * job was enough to trigger it.
   */
  it('is idempotent across repeated ingestion of the same artifact', async () => {
    const path = await writeReport(REPORT);

    const store = new SqliteHistoryStore(':memory:');
    await ingestPlaywrightJson(store, path);
    await ingestPlaywrightJson(store, path);
    const attempts = await store.attempts();
    await store.close();

    expect(attempts).toHaveLength(2);
  });

  it('reads run identity from the report rather than the ingesting job', async () => {
    const path = await writeReport({
      ...REPORT,
      config: {
        version: '1.61.0',
        metadata: {
          actualWorkers: 44,
          ci: { commitHash: '7cbe7c37dee1685ddcbc7e1f37275e6eae9e210e', buildHref: 'https://gh/runs/1' },
        },
      },
    });

    const store = new SqliteHistoryStore(':memory:');
    await ingestPlaywrightJson(store, path, { identity: { commit: 'some-other-sha' } });
    // Read it back the way scoring does — these fields ride on every attempt.
    const attempts = await store.attempts();
    await store.close();

    expect(attempts[0]?.commit).toBe('7cbe7c37dee1685ddcbc7e1f37275e6eae9e210e');
    expect(attempts[0]?.ci).toBe(true);
    // Run start comes from the earliest attempt, not from ingest time.
    expect(attempts[0]?.startedAt).toBe('2026-08-29T13:00:00.000Z');
    expect(attempts[0]?.workers).toBe(44);
  });

  /**
   * A merged report from a sharded run repeats a `setup` project's test once
   * per shard. Real reports carry distinct `spec.id`s for those, so nothing
   * collapses — but a report WITHOUT ids maps both onto one key, and
   * `store.ingest` is a single transaction. Before the collapse existed, that
   * one collision rolled back the entire run: on a real 8-shard acceptance
   * report it cost all 120 attempts, and the only symptom was one warning line.
   */
  it('keeps the rest of the run when an id-less report repeats a test', async () => {
    const setup = (status: string) => ({
      title: 'auth.api.setup.ts',
      file: 'tests/auth.api.setup.ts',
      specs: [
        {
          title: 'warm the token cache',
          tests: [{ projectName: 'api-setup', results: [{ status, duration: 10, retry: 0 }] }],
        },
      ],
    });

    const path = await writeReport({
      ...REPORT,
      suites: [...REPORT.suites, setup('passed'), setup('failed')],
    });

    const store = new SqliteHistoryStore(':memory:');
    const result = await ingestPlaywrightJson(store, path);
    const attempts = await store.attempts();
    await store.close();

    // Two real specs plus one surviving setup row — not zero.
    expect(result.runsIngested).toBe(1);
    expect(result.attemptsIngested).toBe(3);

    // The collapse is reported, never silent.
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain('duplicate attempt collapsed');

    const setupRows = attempts.filter(a => a.project === 'api-setup');
    expect(setupRows).toHaveLength(1);
    expect(setupRows[0]?.outcome).toBe('failed');
  });

  it('reports an unreadable or malformed report instead of throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atest-pwjson-bad-'));
    const bad = join(dir, 'report.json');
    await writeFile(bad, '{ not json', 'utf8');

    const store = new SqliteHistoryStore(':memory:');
    const missing = await ingestPlaywrightJson(store, join(dir, 'absent.json'));
    const malformed = await ingestPlaywrightJson(store, bad);
    await store.close();

    expect(missing.skipped[0]?.reason).toBe('unreadable');
    expect(malformed.skipped[0]?.reason).toBe('not valid JSON');
  });
});
