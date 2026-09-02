import { describe, expect, it } from 'vitest';

import { assembleBundle, type AssembleContext, type TestCaseLike, type TestResultLike } from '../src/assemble.js';
import type { Sidecars } from '../src/assemble.js';

const CONTEXT: AssembleContext = {
  runId: 'run-1',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  project: 'chromium-desktop',
  shard: null,
  workers: 6,
  appEnv: 'local',
  baseUrl: 'http://127.0.0.1:8080',
  browser: 'chromium',
  platform: 'darwin',
  commit: 'abc123',
  changedPaths: [],
  timeoutMs: 30_000,
};

const TEST: TestCaseLike = {
  id: 'test-abc',
  title: 'Given a gym name, when a visitor searches, then only that gym is displayed',
  titlePath: () => ['Gyms UI acceptance', 'Given a gym name…'],
  location: { file: 'tests/features/gyms/gyms.ui.acceptance.spec.ts', line: 47 },
  tags: ['@acceptance', '@gyms'],
};

const EMPTY_SIDECARS: Sidecars = { page: null, network: null, console: null, intent: null };

function pageSidecar(testIdsPresent: string[]): NonNullable<Sidecars['page']> {
  return {
    url: 'http://127.0.0.1:8080/gyms',
    title: 'Gyms',
    ariaSnapshot: '- heading "Gyms"',
    testIdsPresent,
    htmlDigest: null,
  };
}

function result(partial: Partial<TestResultLike> = {}): TestResultLike {
  return {
    status: 'failed',
    duration: 5200,
    retry: 0,
    workerIndex: 3,
    startTime: new Date('2026-08-16T12:00:00.000Z'),
    errors: [],
    steps: [],
    attachments: [],
    ...partial,
  };
}

describe('assembleBundle', () => {
  it('given the same test and result assembled twice -> when assembleBundle runs -> then both bundles carry the same prefixed id', { tags: ['@unit', '@runner'] }, () => {
    // Ids must survive re-analysis on another machine, or the heal ledger and
    // CI artifacts cannot be joined after the fact.
    const a = assembleBundle({ test: TEST, result: result(), sidecars: EMPTY_SIDECARS, context: CONTEXT });
    const b = assembleBundle({ test: TEST, result: result(), sidecars: EMPTY_SIDECARS, context: CONTEXT });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^ev_[0-9a-f]{12}$/);
  });

  it('given the same test on retry 0 and retry 1 -> when assembleBundle runs -> then the two bundles carry different ids', { tags: ['@unit', '@runner'] }, () => {
    const first = assembleBundle({ test: TEST, result: result({ retry: 0 }), sidecars: EMPTY_SIDECARS, context: CONTEXT });
    const second = assembleBundle({ test: TEST, result: result({ retry: 1 }), sidecars: EMPTY_SIDECARS, context: CONTEXT });
    expect(first.id).not.toBe(second.id);
  });

  it('given a toBeVisible failure reporting element(s) not found -> when assembleBundle runs -> then the kind, matcher and locator are all carried', { tags: ['@unit', '@runner'] }, () => {
    const bundle = assembleBundle({
      test: TEST,
      result: result({
        errors: [
          {
            message: [
              `Error: expect(locator).toBeVisible() failed`,
              ``,
              `Locator: getByTestId('gym-card-name')`,
              `Expected: visible`,
              `Received: <element(s) not found>`,
            ].join('\n'),
          },
        ],
      }),
      sidecars: EMPTY_SIDECARS,
      context: CONTEXT,
    });

    expect(bundle.failure.kind).toBe('locator_not_found');
    expect(bundle.failure.matcher).toBe('toBeVisible');
    expect(bundle.intent.selector).toBe("getByTestId('gym-card-name')");
  });

  it('given a failing step titled as a bound page-object call -> when assembleBundle runs -> then the method and its domain arguments are recorded as the intent', { tags: ['@unit', '@runner'] }, () => {
    const bundle = assembleBundle({
      test: TEST,
      result: result({
        steps: [
          {
            title: "gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' })",
            category: 'test.step',
            duration: 5000,
            startTime: new Date('2026-08-16T12:00:00.000Z'),
            error: new Error('boom'),
            steps: [],
          },
        ],
      }),
      sidecars: EMPTY_SIDECARS,
      context: CONTEXT,
    });

    expect(bundle.intent.failingStep?.method).toBe('expectCardData');
    expect(bundle.intent.failingStep?.args).toEqual(['Blackwater Valley BJJ']);
  });

  it('given both a fixture-recorded selector and one in the error prose -> when assembleBundle runs -> then the fixture selector wins and its source aliases are carried', { tags: ['@unit', '@runner'] }, () => {
    // The fixture knows which locator the page object actually built; the
    // error text is only a best-effort fallback.
    const bundle = assembleBundle({
      test: TEST,
      result: result({ errors: [{ message: "Locator: getByTestId('from-error-text')" }] }),
      sidecars: {
        ...EMPTY_SIDECARS,
        intent: {
          selector: "getByTestId('from-fixture')",
          selectorSource: {
            file: 'src/ui/pages/gyms/gyms.constants.ts',
            line: 20,
            constantPath: 'TEST_IDS.cardName',
            aliases: ['GYM_CARD_TEST_IDS.name'],
          },
        },
      },
      context: CONTEXT,
    });

    expect(bundle.intent.selector).toBe("getByTestId('from-fixture')");
    expect(bundle.intent.selectorSource?.aliases).toContain('GYM_CARD_TEST_IDS.name');
  });

  it('given a reporter-only run with no fixtures installed -> when assembleBundle runs -> then the failure is still classified and the page sections are empty rather than missing', { tags: ['@unit', '@runner'] }, () => {
    // The reporter alone must be enough. Adding fixtures is an upgrade, not a
    // precondition — otherwise adoption stops being a one-line change.
    const bundle = assembleBundle({
      test: TEST,
      result: result({ errors: [{ message: 'Error: strict mode violation: resolved to 3 elements' }] }),
      sidecars: EMPTY_SIDECARS,
      context: CONTEXT,
    });

    expect(bundle.failure.kind).toBe('locator_ambiguous');
    expect(bundle.page.ariaSnapshot).toBe('');
    expect(bundle.page.testIdsPresent).toEqual([]);
  });

  it('given candidates seeded by the reporter with no browser available -> when assembleBundle runs -> then every candidate is marked unverified rather than claiming uniqueness', { tags: ['@unit', '@runner'] }, () => {
    // No browser is available in the reporter, so matchCount is -1 to say
    // "not checked" instead of asserting a uniqueness nobody measured.
    const bundle = assembleBundle({
      test: TEST,
      result: result({ errors: [{ message: "Locator: getByTestId('gym-card-name')" }] }),
      sidecars: { ...EMPTY_SIDECARS, page: pageSidecar(['gym-card-title', 'gym-card-county']) },
      context: CONTEXT,
    });

    expect(bundle.page.candidates.length).toBe(2);
    expect(bundle.page.candidates.every(c => c.matchCount === -1)).toBe(true);
  });

  it('given a page carrying six test ids of varying similarity -> when assembleBundle ranks them -> then they are ordered by distance and the unrelated ones are dropped', { tags: ['@unit', '@runner'] }, () => {
    // Verified against a live page: a real route carries ~36 test ids. Handing
    // over all of them is noise that pushes the cost of choosing downstream.
    const bundle = assembleBundle({
      test: TEST,
      result: result({ errors: [{ message: "Locator: getByTestId('gym-card-name')" }] }),
      sidecars: {
        ...EMPTY_SIDECARS,
        page: pageSidecar([
          'gym-card-title',
          'gym-card-county',
          'footer-copyright',
          'navigation-desktop-links',
          'search-input',
          'support-modal-close',
        ]),
      },
      context: CONTEXT,
    });

    const ids = bundle.page.candidates.map(c => c.expression);
    expect(ids).toContain("getByTestId('gym-card-title')");
    expect(ids).not.toContain("getByTestId('footer-copyright')");
    expect(ids).not.toContain("getByTestId('support-modal-close')");

    const distances = bundle.page.candidates.map(c => c.semanticDistance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(Math.max(...distances)).toBeLessThanOrEqual(0.4);
  });

  it('given a page carrying forty similar test ids -> when assembleBundle ranks them -> then the candidate list is capped at ten', { tags: ['@unit', '@runner'] }, () => {
    const many = Array.from({ length: 40 }, (_, i) => `gym-card-name${i}`);
    const bundle = assembleBundle({
      test: TEST,
      result: result({ errors: [{ message: "Locator: getByTestId('gym-card-name')" }] }),
      sidecars: { ...EMPTY_SIDECARS, page: pageSidecar(many) },
      context: CONTEXT,
    });
    expect(bundle.page.candidates.length).toBeLessThanOrEqual(10);
  });

  it('given a result that consumed its whole timeout -> when assembleBundle runs -> then the budget used ratio is 1', { tags: ['@unit', '@runner'] }, () => {
    const bundle = assembleBundle({
      test: TEST,
      result: result({ duration: 30_000 }),
      sidecars: EMPTY_SIDECARS,
      context: CONTEXT,
    });
    expect(bundle.timing.budgetUsedRatio).toBe(1);
  });

  it('given attachments named trace and screenshot -> when assembleBundle runs -> then each is linked by name and the absent video stays null', { tags: ['@unit', '@runner'] }, () => {
    const bundle = assembleBundle({
      test: TEST,
      result: result({
        attachments: [
          { name: 'trace', path: '/tmp/trace.zip', contentType: 'application/zip' },
          { name: 'screenshot', path: '/tmp/shot.png', contentType: 'image/png' },
        ],
      }),
      sidecars: EMPTY_SIDECARS,
      context: CONTEXT,
    });

    expect(bundle.artifacts.tracePath).toBe('/tmp/trace.zip');
    expect(bundle.visual.screenshotPath).toBe('/tmp/shot.png');
    expect(bundle.artifacts.videoPath).toBeNull();
  });
});
