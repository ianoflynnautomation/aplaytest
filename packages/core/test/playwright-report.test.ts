import { describe, expect, it } from 'vitest';

import { mapPlaywrightReport, type JsonReport } from '../src/history/playwright-report.js';

const IDENTITY = { commit: null, branch: null, appEnv: null, ci: false };
const FIXED_NOW = (): number => Date.parse('2026-01-01T00:00:00.000Z');

const map = (report: JsonReport, identity = IDENTITY) =>
  mapPlaywrightReport(report, { identity, now: FIXED_NOW });

/** One spec, one project, one result — the smallest thing worth mapping. */
function report(overrides: Partial<JsonReport> = {}): JsonReport {
  return {
    config: { version: '1.61.0', workers: 4 },
    suites: [
      {
        title: 'gyms.ui.acceptance.spec.ts',
        file: 'tests/features/gyms/gyms.ui.acceptance.spec.ts',
        specs: [
          {
            id: 'a3c878af9c85c5ed06b8-985fc0085fd7523ef44f',
            title: 'Given available gyms, then the gym list is displayed',
            file: 'tests/features/gyms/gyms.ui.acceptance.spec.ts',
            line: 24,
            tags: ['@acceptance'],
            tests: [
              {
                projectName: 'webkit-desktop',
                timeout: 45_000,
                results: [
                  {
                    status: 'passed',
                    duration: 1_200,
                    retry: 0,
                    workerIndex: 3,
                    startTime: '2026-08-29T13:10:56.550Z',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('mapPlaywrightReport — identity', () => {
  it('given a report whose spec carries a stable spec.id -> when mapPlaywrightReport runs -> then the attempt testId is that spec.id, so history joins to the reporter rows', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(report());

    expect(run.attempts[0]?.testId).toBe('a3c878af9c85c5ed06b8-985fc0085fd7523ef44f');
  });

  // Two tests with the same title in different describe blocks of one file are
  // distinct tests. A `file::title` id would merge their histories.
  it('given a report predating spec.id that repeats one title across two describe blocks -> when mapPlaywrightReport runs -> then each attempt gets a distinct title-path testId', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map({
      suites: [
        {
          title: 'listing.spec.ts',
          file: 'tests/listing.spec.ts',
          suites: [
            {
              title: 'desktop',
              specs: [{ title: 'renders', tests: [{ results: [{ status: 'passed' }] }] }],
            },
            {
              title: 'mobile',
              specs: [{ title: 'renders', tests: [{ results: [{ status: 'passed' }] }] }],
            },
          ],
        },
      ],
    });

    const ids = run.attempts.map(a => a.testId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('tests/listing.spec.ts::listing.spec.ts::desktop::renders');
  });
});

describe('mapPlaywrightReport — run id', () => {
  // store.ingest is idempotent BY RUN ID. A clock-derived id opts out of that
  // silently and double-counts every attempt on a re-ingest.
  it('given the same report mapped twice -> when mapPlaywrightReport runs -> then both mappings derive the same runId', { tags: ['@unit', '@history-report'] }, () => {
    expect(map(report()).run.runId).toBe(map(report()).run.runId);
  });

  it('given a report carrying a CI buildHref -> when mapPlaywrightReport runs -> then the runId is derived from that build URL and differs from the report without one', { tags: ['@unit', '@history-report'] }, () => {
    const withBuild = map(
      report({
        config: {
          version: '1.61.0',
          metadata: { ci: { buildHref: 'https://github.com/o/r/actions/runs/33253028409' } },
        },
      }),
    ).run.runId;

    expect(withBuild).toMatch(/^pwjson_[0-9a-f]{12}$/);
    expect(withBuild).not.toBe(map(report()).run.runId);
  });

  it('given two reports differing only in a result duration -> when mapPlaywrightReport runs -> then the two runIds differ', { tags: ['@unit', '@history-report'] }, () => {
    const slower = report();
    slower.suites![0]!.specs![0]!.tests![0]!.results![0] = {
      ...slower.suites![0]!.specs![0]!.tests![0]!.results![0]!,
      duration: 9_999,
    };

    expect(map(slower).run.runId).not.toBe(map(report()).run.runId);
  });
});

describe('mapPlaywrightReport — run metadata', () => {
  // Recency decay weights by startedAt. Ingest time would make a replayed
  // archive weigh as heavily as this morning's run.
  it('given a report whose attempts carry start times -> when mapPlaywrightReport runs -> then startedAt and finishedAt come from the attempts rather than the clock', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(report());

    expect(run.startedAt).toBe('2026-08-29T13:10:56.550Z');
    expect(run.finishedAt).toBe('2026-08-29T13:10:57.750Z');
  });

  it('given a report where no attempt carries a timestamp -> when mapPlaywrightReport runs -> then startedAt falls back to the injected clock', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map({ suites: [{ specs: [{ title: 't', tests: [{ results: [{}] }] }] }] });

    expect(run.startedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('given a report carrying CI commit and branch metadata -> when mapPlaywrightReport runs under a different ingesting identity -> then the commit and branch from the report win and ci is true', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(
      report({
        config: { version: '1.61.0', metadata: { ci: { commitHash: '7cbe7c3', branch: 'main' } } },
      }),
      { ...IDENTITY, commit: 'whatever-is-checked-out-now', branch: 'analyze-job' },
    );

    expect(run.commit).toBe('7cbe7c3');
    expect(run.branch).toBe('main');
    expect(run.ci).toBe(true);
  });

  it('given a report carrying no CI metadata -> when mapPlaywrightReport runs with an environment identity -> then commit, appEnv and ci fall back to the environment', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(report(), { ...IDENTITY, commit: 'abc123', appEnv: 'staging', ci: true });

    expect(run.commit).toBe('abc123');
    expect(run.appEnv).toBe('staging');
    expect(run.ci).toBe(true);
  });

  it('given a report declaring actualWorkers and a shard -> when mapPlaywrightReport runs -> then the workers actually used, the shard and the Playwright version are recorded', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(
      report({
        config: {
          version: '1.61.0',
          workers: 4,
          shard: { current: 2, total: 4 },
          metadata: { actualWorkers: 44 },
        },
      }),
    );

    expect(run.workers).toBe(44);
    expect(run.shard).toEqual({ current: 2, total: 4 });
    expect(run.playwrightVersion).toBe('1.61.0');
  });
});

describe('mapPlaywrightReport — classification', () => {
  const failing = (message: string, extra: Record<string, unknown> = {}): JsonReport => ({
    suites: [
      {
        title: 'spec.ts',
        file: 'tests/spec.ts',
        specs: [
          {
            id: 'id-1',
            title: 'a test',
            tests: [
              {
                projectName: 'webkit-desktop',
                timeout: 45_000,
                results: [{ status: 'failed', duration: 8_000, errors: [{ message }], ...extra }],
              },
            ],
          },
        ],
      },
    ],
  });

  // The real signature from run 33253028409: five of its six flaky attempts.
  // `locator.not-found` deliberately outranks `assertion.visibility` here —
  // "element(s) not found" means the address resolved to nothing, which is a
  // different problem from an element that was present but not yet visible.
  it('given a failed attempt reporting a toBeVisible timeout with element(s) not found -> when mapPlaywrightReport runs -> then failureKind is locator_not_found rather than unknown', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(
      failing(
        [
          'Error: expect(locator).toBeVisible() failed',
          '',
          "Locator: getByTestId('gyms-page-header')",
          'Expected: visible',
          'Timeout: 8000ms',
          'Error: element(s) not found',
        ].join('\n'),
      ),
    );

    expect(run.attempts[0]?.failureKind).not.toBe('unknown');
    expect(run.attempts[0]?.failureKind).toBe('locator_not_found');
  });

  // The sixth: the element resolved, then never became actionable.
  it('given a failed attempt whose call log resolved the locator before the click timed out -> when mapPlaywrightReport runs -> then failureKind is locator_not_actionable rather than not-found', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(
      failing(
        [
          'TimeoutError: locator.click: Timeout 10000ms exceeded.',
          'Call log:',
          "  - waiting for getByTestId('navigation-mobile-toggle')",
          '    - locator resolved to <button aria-expanded="false">…</button>',
          '  - attempting click action',
          '    - waiting for element to be visible, enabled and stable',
        ].join('\n'),
      ),
    );

    expect(run.attempts[0]?.failureKind).toBe('locator_not_actionable');
  });

  // The one that matters most: doc 06 requires infra attempts to be excluded
  // from flake statistics, which a hard-coded 'unknown' could never do.
  it('given a failed attempt reporting a missing browser executable -> when mapPlaywrightReport runs -> then failureKind is infra, so it stays out of the flake statistics', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(failing('browserType.launch: Executable doesn\'t exist at /ms-playwright'));

    expect(run.attempts[0]?.failureKind).toBe('infra');
  });

  it('given a failed attempt carrying no error text -> when mapPlaywrightReport runs -> then failureKind is unknown rather than a guess', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(failing(''));

    expect(run.attempts[0]?.failureKind).toBe('unknown');
  });

  it('given a passing attempt -> when mapPlaywrightReport runs -> then failureKind is null', { tags: ['@unit', '@history-report'] }, () => {
    expect(map(report()).run.attempts[0]?.failureKind).toBeNull();
  });
});

describe('mapPlaywrightReport — duplicate attempts', () => {
  const twice = (first: string, second: string): JsonReport => {
    const setup = (status: string): JsonSuiteLike => ({
      title: 'auth.api.setup.ts',
      file: 'tests/auth.api.setup.ts',
      specs: [
        {
          title: 'warm the token cache',
          tests: [{ projectName: 'api-setup', results: [{ status }] }],
        },
      ],
    });
    return { suites: [setup(first), setup(second)] };
  };
  type JsonSuiteLike = NonNullable<JsonReport['suites']>[number];

  it('given an id-less report repeating one test as passed then failed -> when mapPlaywrightReport runs -> then one attempt survives carrying the more severe outcome', { tags: ['@unit', '@history-report'] }, () => {
    const { run } = map(twice('passed', 'failed'));

    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]?.outcome).toBe('failed');
  });

  it('given an id-less report repeating one test as passed then failed -> when mapPlaywrightReport runs -> then the collapsed attempt is reported by title rather than discarded silently', { tags: ['@unit', '@history-report'] }, () => {
    const { collapsed } = map(twice('passed', 'failed'));

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain('warm the token cache');
  });

  it('given a report whose repeated titles carry distinct spec ids -> when mapPlaywrightReport runs -> then nothing is collapsed and both attempts survive', { tags: ['@unit', '@history-report'] }, () => {
    const { run, collapsed } = map({
      suites: [
        {
          title: 'auth.api.setup.ts',
          file: 'tests/auth.api.setup.ts',
          specs: [
            {
              id: 'dfa462e5b466c2675f4d-05e56dfd994e486a9178',
              title: 'warm the token cache',
              tests: [{ projectName: 'api-setup', results: [{ status: 'passed' }] }],
            },
            {
              id: 'dfa462e5b466c2675f4d-05e56dfd994e486a91787',
              title: 'warm the token cache',
              tests: [{ projectName: 'api-setup', results: [{ status: 'passed' }] }],
            },
          ],
        },
      ],
    });

    expect(collapsed).toEqual([]);
    expect(run.attempts).toHaveLength(2);
  });
});
