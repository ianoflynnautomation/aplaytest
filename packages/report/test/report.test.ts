import type { AttemptRecord, EvidenceBundle, RunRecord } from '@atest/core';
import { describe, expect, it } from 'vitest';

import { formatArgs } from '../src/args.js';
import { escapeHtml, renderHtml } from '../src/html.js';
import { orderFailures } from '../src/load.js';
import { COMMENT_MARKER, cell, fence, renderMarkdown } from '../src/markdown.js';
import { mergeRuns } from '../src/merge.js';

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    testId: 't1',
    project: 'chromium',
    title: 'a gym can be found by name',
    file: 'tests/gyms.spec.ts',
    line: 8,
    outcome: 'passed',
    retry: 0,
    durationMs: 100,
    workerIndex: 0,
    startedAt: '2026-08-16T10:00:00.000Z',
    tags: [],
    coScheduled: [],
    routes: [],
    ...over,
  } as AttemptRecord;
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    startedAt: '2026-08-16T10:00:00.000Z',
    finishedAt: '2026-08-16T10:05:00.000Z',
    commit: 'abcdef1234567890',
    branch: 'main',
    ci: true,
    attempts: [attempt()],
    ...over,
  } as RunRecord;
}

function bundle(over: Record<string, unknown> = {}): EvidenceBundle {
  return {
    schemaVersion: 1,
    id: 'ev_00000000000001',
    runId: 'run-1',
    traceId: 't',
    capturedAt: '2026-08-16T10:00:00.000Z',
    test: {
      id: 't1',
      title: 'a gym can be found by name',
      titlePath: [],
      file: '/repo/tests/gyms.spec.ts',
      line: 8,
      project: 'chromium',
      tags: [],
      retry: 0,
      workerIndex: 0,
      shard: null,
    },
    failure: {
      kind: 'locator_not_found',
      message: 'element(s) not found',
      stack: '',
      matcher: 'toBeVisible',
      expected: 'visible',
      actual: 'not found',
      timedOut: true,
    },
    intent: {
      steps: [],
      failingStep: {
        pageObject: 'gymsPage',
        method: 'expectCardData',
        args: [{ name: 'Fitzgerald BJJ' }],
        startedAt: '',
        durationMs: 1,
        failed: true,
      },
      selector: "getByTestId('gym-card-name-v1')",
      selectorSource: null,
    },
    page: {
      url: '/gyms',
      title: 'Gyms',
      ariaSnapshot: '',
      candidates: [],
      htmlDigest: null,
      testIdsPresent: [],
    },
    visual: { screenshotPath: null, diffPath: null, diffPixelRatio: null },
    network: { failed: [], slow: [], statusCounts: {} },
    console: { errors: [], warnings: [] },
    timing: { testMs: 1, failingActionMs: null, navigationMs: null, budgetUsedRatio: 0 },
    env: {
      appEnv: 'local',
      baseUrl: '',
      browser: 'chromium',
      platform: 'darwin',
      workers: 1,
      commit: '',
      changedPaths: [],
    },
    appSpans: null,
    artifacts: { tracePath: null, videoPath: null },
    ...over,
  } as unknown as EvidenceBundle;
}

describe('mergeRuns', () => {
  it('given no run records -> when mergeRuns runs -> then it returns null rather than throwing', { tags: ['@unit', '@report'] }, () => {
    // A cancelled job produces no records; that is not an error.
    expect(mergeRuns([])).toBeNull();
  });

  it('given a test that failed then passed on retry -> when mergeRuns totals it -> then it counts once as flaky rather than failed', { tags: ['@unit', '@report'] }, () => {
    // Counting the first attempt would make every retried suite look broken.
    const merged = mergeRuns([
      run({
        attempts: [
          attempt({ outcome: 'failed', retry: 0 }),
          attempt({ outcome: 'passed', retry: 1 }),
        ],
      }),
    ]);
    expect(merged?.totals.flaky).toBe(1);
    expect(merged?.totals.failed).toBe(0);
    expect(merged?.totals.tests).toBe(1);
  });

  it('given one attempt present in two shard artifacts -> when mergeRuns merges them -> then the attempt is counted once', { tags: ['@unit', '@report'] }, () => {
    const shard = run({ attempts: [attempt()] });
    const merged = mergeRuns([shard, { ...shard, runId: 'run-1' }]);
    expect(merged?.attempts).toHaveLength(1);
    expect(merged?.totals.passed).toBe(1);
  });

  it('given one test id running under two projects with different outcomes -> when mergeRuns totals them -> then they stay separate and the failure is visible', { tags: ['@unit', '@report'] }, () => {
    // Merging them would hide a failure confined to one browser.
    const merged = mergeRuns([
      run({
        attempts: [
          attempt({ project: 'chromium', outcome: 'passed' }),
          attempt({ project: 'firefox', outcome: 'failed' }),
        ],
      }),
    ]);
    expect(merged?.totals.tests).toBe(2);
    expect(merged?.totals.failed).toBe(1);
  });

  it('given two shard artifacts -> when mergeRuns merges them -> then the number of shards merged is reported', { tags: ['@unit', '@report'] }, () => {
    const merged = mergeRuns([
      run({ attempts: [attempt({ testId: 'a' })] }),
      run({ attempts: [attempt({ testId: 'b' })] }),
    ]);
    expect(merged?.shardsMerged).toBe(2);
  });
});

describe('markdown', () => {
  it('given a merged run -> when renderMarkdown renders it -> then the comment marker is embedded so CI updates in place', { tags: ['@unit', '@report'] }, () => {
    const merged = mergeRuns([run()]);
    expect(merged).not.toBeNull();
    const out = renderMarkdown({ run: merged!, failures: [] });
    expect(out).toContain(COMMENT_MARKER);
  });

  it('given two failures sharing one kind -> when renderMarkdown renders them -> then they are grouped under that kind with a count', { tags: ['@unit', '@report'] }, () => {
    const merged = mergeRuns([run()]);
    const out = renderMarkdown({
      run: merged!,
      failures: [bundle(), bundle({ id: 'ev_2' })],
    });
    expect(out).toContain('locator not found');
    expect(out).toContain('· 2');
  });

  it('given a failing step carrying an object argument -> when renderMarkdown renders it -> then the object is printed readably', { tags: ['@unit', '@report'] }, () => {
    const merged = mergeRuns([run()]);
    const out = renderMarkdown({ run: merged!, failures: [bundle()] });
    expect(out).toContain("{ name: 'Fitzgerald BJJ' }");
    expect(out).not.toContain('[object Object]');
  });

  it('given a heal proposal that was never validated -> when renderMarkdown renders the report -> then the suggested repairs section is withheld', { tags: ['@unit', '@report'] }, () => {
    // A proposal never re-run against the app is a guess, and a guess in a PR
    // comment gets applied by someone who trusts the tool.
    const merged = mergeRuns([run()]);
    const out = renderMarkdown({
      run: merged!,
      failures: [],
      heals: [
        {
          title: 't',
          file: 'f',
          from: 'a',
          to: 'b',
          confidence: 0.9,
          validated: false,
        },
      ],
    });
    expect(out).not.toContain('Suggested selector repairs');
  });

  it('given a run holding four thousand failures -> when renderMarkdown renders it -> then the failures section survives and is truncated within the size limit', { tags: ['@unit', '@report'] }, () => {
    // REGRESSION GUARD: dropping whole sections turned a 4000-failure run into
    // a 153-character comment reading "1 section(s) omitted" — discarding the
    // most important section exactly when there was most to say.
    const merged = mergeRuns([run()]);
    const many = Array.from({ length: 4000 }, (_, i) =>
      bundle({ id: `ev_${i}`, failure: { ...bundle().failure, kind: `kind_${i}` } }),
    );
    const out = renderMarkdown({ run: merged!, failures: many });

    expect(out.length).toBeLessThanOrEqual(60_000);
    // Real content survived, not just an apology.
    expect(out.length).toBeGreaterThan(10_000);
    expect(out).toContain('### Failures');
    expect(out).toContain('not shown');
  });

  it('given a run holding four thousand failures -> when renderMarkdown truncates the table -> then the shown and hidden counts add up to the total', { tags: ['@unit', '@report'] }, () => {
    const merged = mergeRuns([run()]);
    const many = Array.from({ length: 4000 }, (_, i) =>
      bundle({ id: `ev_${i}`, failure: { ...bundle().failure, kind: `kind_${i}` } }),
    );
    const out = renderMarkdown({ run: merged!, failures: many });

    const shown = [...out.matchAll(/^\| a gym can be found by name/gm)].length;
    const hidden = Number(/(\d+) further failure/.exec(out)?.[1] ?? '0');
    expect(shown + hidden).toBe(4000);
  });

  it('given a run holding two failures -> when renderMarkdown renders it -> then nothing is truncated and no notice appears', { tags: ['@unit', '@report'] }, () => {
    const merged = mergeRuns([run()]);
    const out = renderMarkdown({ run: merged!, failures: [bundle(), bundle({ id: 'ev_2' })] });
    expect(out).not.toContain('not shown');
    expect(out).not.toContain('omitted');
  });
});

describe('markdown — intent column', () => {
  it('given a failure carrying a selector but no failing step -> when renderMarkdown renders the intent column -> then it shows the selector and the title appears once', { tags: ['@unit', '@report'] }, () => {
    // Printing the title in two adjacent columns reads as a rendering bug and
    // wastes the column that was meant to add information.
    const merged = mergeRuns([run()]);
    const out = renderMarkdown({
      run: merged!,
      failures: [
        bundle({
          intent: { steps: [], failingStep: null, selector: "getByRole('link')", selectorSource: null },
        }),
      ],
    });
    expect(out).toContain("getByRole('link')");
    expect([...out.matchAll(/a gym can be found by name/g)]).toHaveLength(1);
  });

  it('given a failure carrying neither a step nor a selector -> when renderMarkdown renders the intent column -> then it prints a dash', { tags: ['@unit', '@report'] }, () => {
    const merged = mergeRuns([run()]);
    const out = renderMarkdown({
      run: merged!,
      failures: [bundle({ intent: { steps: [], failingStep: null, selector: null, selectorSource: null } })],
    });
    expect(out).toContain('| `—` |');
  });
});

describe('markdown — untrusted text', () => {
  it('given text containing a triple backtick -> when fence wraps it -> then the fence is long enough to contain it', { tags: ['@unit', '@report'] }, () => {
    // An error message containing ``` would otherwise close the fence early
    // and let the remainder render as markup.
    const out = fence('a ``` b');
    expect(out.startsWith('````')).toBe(true);
  });

  it('given a title containing a pipe -> when cell escapes it -> then the pipe cannot forge a table column', { tags: ['@unit', '@report'] }, () => {
    expect(cell('gyms | admin')).toBe('gyms \\| admin');
  });

  it('given a title containing a newline -> when cell escapes it -> then the newline is flattened to a space', { tags: ['@unit', '@report'] }, () => {
    expect(cell('line one\nline two')).toBe('line one line two');
  });
});

describe('html', () => {
  it('given a title containing an img tag -> when escapeHtml escapes it -> then the markup renders as text', { tags: ['@unit', '@report'] }, () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });

  it('given a merged run and a failure -> when renderHtml renders the report -> then it references no external script, stylesheet or asset', { tags: ['@unit', '@report'] }, () => {
    const merged = mergeRuns([run()]);
    const html = renderHtml({ run: merged!, failures: [bundle()] });
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/i);
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it('given a candidate whose match count is the not-checked sentinel -> when renderHtml renders it -> then it prints unverified rather than a negative match count', { tags: ['@unit', '@report'] }, () => {
    // REGRESSION GUARD, found against the live app: matchCount is -1 for
    // "no browser has resolved this yet". Rendering it as a number printed
    // "-1 matches — ambiguous" beside the CORRECT candidate, claiming it was
    // disqualified from healing when nothing had disqualified it.
    const merged = mergeRuns([run()]);
    const html = renderHtml({
      run: merged!,
      failures: [
        bundle({
          page: {
            ...bundle().page,
            candidates: [
              {
                strategy: 'testid',
                expression: "getByTestId('gym-card-name')",
                matchCount: -1,
                visible: false,
                enabled: false,
                accessibleName: null,
                boundingBox: null,
                semanticDistance: 0.1,
                stabilityRank: 0,
              },
            ],
          },
        }),
      ],
    });
    expect(html).not.toContain('-1 matches');
    expect(html).not.toMatch(/-1 matches|-1&nbsp;matches/);
    expect(html).toContain('unverified');
  });

  it('given a merged run and a failure -> when renderHtml renders it -> then intent appears before the raw message', { tags: ['@unit', '@report'] }, () => {
    // The stack is what everyone already has; it does not get to be the headline.
    const merged = mergeRuns([run()]);
    const html = renderHtml({ run: merged!, failures: [bundle()] });
    expect(html.indexOf('>intent<')).toBeLessThan(html.indexOf('>message<'));
  });
});

describe('orderFailures', () => {
  it('given an app_error and a locator_not_found failure -> when orderFailures sorts them -> then the app error leads', { tags: ['@unit', '@report'] }, () => {
    const ordered = orderFailures([
      bundle({ id: 'a', failure: { ...bundle().failure, kind: 'locator_not_found' } }),
      bundle({ id: 'b', failure: { ...bundle().failure, kind: 'app_error' } }),
    ]);
    expect(ordered[0]?.failure.kind).toBe('app_error');
  });
});

describe('formatArgs', () => {
  it('given an object argument -> when formatArgs renders it -> then it reads the way a developer would have written it', { tags: ['@unit', '@report'] }, () => {
    expect(formatArgs([{ name: 'Cork BJJ' }])).toBe("{ name: 'Cork BJJ' }");
  });

  it('given two separate string arguments -> when formatArgs renders them -> then each is quoted independently', { tags: ['@unit', '@report'] }, () => {
    expect(formatArgs(['a', 'Cork'])).toBe("'a', 'Cork'");
  });

  it('given an argument nested four levels deep -> when formatArgs renders it -> then the deep nesting is clipped', { tags: ['@unit', '@report'] }, () => {
    expect(formatArgs([{ a: { b: { c: { d: 1 } } } }])).toContain('{…}');
  });

  it('given no arguments -> when formatArgs renders them -> then the result is an empty string', { tags: ['@unit', '@report'] }, () => {
    expect(formatArgs([])).toBe('');
  });
});
