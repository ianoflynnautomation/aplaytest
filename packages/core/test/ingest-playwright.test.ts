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
          title: 'Given the gyms API, when listed, then the page is valid',
          file: 'tests/features/gyms/gyms.api.acceptance.spec.ts',
          line: 12,
          tags: ['@gyms', '@api'],
          tests: [
            {
              projectName: 'api',
              results: [{ status: 'passed', duration: 80, retry: 0, workerIndex: 0 }],
            },
          ],
        },
        {
          title: 'Given a missing gym, when fetched, then the API returns 404',
          file: 'tests/features/gyms/gyms.api.acceptance.spec.ts',
          line: 28,
          tags: ['@gyms', '@api'],
          tests: [
            {
              projectName: 'api',
              results: [{ status: 'failed', duration: 40, retry: 0, workerIndex: 0 }],
            },
          ],
        },
      ],
    },
  ],
};

describe('ingestPlaywrightJson', () => {
  it('turns a Playwright JSON report into history attempts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atest-pwjson-'));
    const path = join(dir, 'report.json');
    await writeFile(path, JSON.stringify(REPORT), 'utf8');

    const store = new SqliteHistoryStore(':memory:');
    const result = await ingestPlaywrightJson(store, path);
    const attempts = await store.attempts();
    await store.close();

    expect(result.runsIngested).toBe(1);
    expect(result.attemptsIngested).toBe(2);
    expect(attempts.map(a => a.outcome).sort()).toEqual(['failed', 'passed']);
    expect(attempts.find(a => a.outcome === 'failed')?.project).toBe('api');
    expect(attempts.find(a => a.outcome === 'failed')?.failureKind).toBe('unknown');
  });
});
