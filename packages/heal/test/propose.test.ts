import { describe, expect, it } from 'vitest';

import { assessBundle, generateCandidates } from '../src/candidates.js';
import { proposeHeal } from '../src/propose.js';
import type { EvidenceBundle, FailureKind } from '@atest/core';

const CONSTANTS = `export const TEST_IDS = {
  cardName: 'gym-card-name',
  county: 'gym-card-county',
} as const;
`;

function bundle(overrides: {
  kind?: FailureKind;
  selector?: string | null;
  testIds?: string[];
} = {}): EvidenceBundle {
  return {
    schemaVersion: 1,
    id: 'ev_abc123abc123' as EvidenceBundle['id'],
    runId: 'run-1',
    traceId: 'trace',
    capturedAt: new Date().toISOString(),
    test: {
      id: 'test-1',
      title: 'Given a gym name, when a visitor searches, then only that gym is displayed',
      titlePath: [],
      file: 'tests/features/gyms/gyms.ui.acceptance.spec.ts',
      line: 47,
      project: 'chromium-desktop',
      tags: [],
      retry: 0,
      workerIndex: 0,
      shard: null,
    },
    failure: {
      kind: overrides.kind ?? 'locator_not_found',
      message: '',
      stack: '',
      matcher: 'toBeVisible',
      expected: 'visible',
      actual: 'element(s) not found',
      timedOut: true,
    },
    intent: {
      steps: [],
      failingStep: null,
      selector: overrides.selector === undefined ? "getByTestId('gym-card-name')" : overrides.selector,
      selectorSource: null,
    },
    page: {
      url: 'http://localhost:8080/gyms',
      title: 'Gyms',
      ariaSnapshot: '',
      candidates: [],
      htmlDigest: null,
      testIdsPresent: overrides.testIds ?? ['gym-card-title', 'gym-card-county', 'footer-copyright'],
    },
    visual: { screenshotPath: null, diffPath: null, diffPixelRatio: null },
    network: { failed: [], slow: [], statusCounts: {} },
    console: { errors: [], warnings: [] },
    timing: { testMs: 1000, failingActionMs: null, navigationMs: null, budgetUsedRatio: 0.1 },
    env: {
      appEnv: 'local',
      baseUrl: '',
      browser: 'chromium',
      platform: 'darwin',
      workers: 4,
      commit: '',
      changedPaths: [],
    },
    appSpans: null,
    artifacts: { tracePath: null, videoPath: null },
  };
}

const BASE = {
  cwd: '.',
  constantsFile: 'src/ui/pages/gyms/gyms.constants.ts',
  constantsText: CONSTANTS,
  specFile: 'tests/features/gyms/gyms.ui.acceptance.spec.ts',
  validationRuns: 3,
  checkCollateral: true,
  skipValidation: true,
};

describe('proposeHeal — the hard guards', () => {
  it('given a schema_violation failure -> when proposeHeal runs -> then it refuses as never-heal and produces no patch', { tags: ['@unit', '@heal'] }, async () => {
    // The wire contract broke. "Repairing" it deletes the most valuable signal
    // the suite produces.
    const result = await proposeHeal(bundle({ kind: 'schema_violation' }), BASE);
    expect(result.status).toBe('refused-never-heal');
    expect(result.patch).toBeNull();
  });

  it('given an app_error failure -> when proposeHeal runs -> then it refuses as never-heal', { tags: ['@unit', '@heal'] }, async () => {
    const result = await proposeHeal(bundle({ kind: 'app_error' }), BASE);
    expect(result.status).toBe('refused-never-heal');
  });

  it('given network, navigation, http status or infra failures -> when proposeHeal runs on each -> then every one is refused as never-heal', { tags: ['@unit', '@heal'] }, async () => {
    for (const kind of ['network_error', 'navigation_failure', 'http_status', 'infra'] as const) {
      const result = await proposeHeal(bundle({ kind }), BASE);
      expect(result.status).toBe('refused-never-heal');
    }
  });

  it('given a test whose flake score is above the threshold -> when proposeHeal runs -> then it refuses as flaky and advises bisecting first', { tags: ['@unit', '@heal'] }, async () => {
    // Healing a flake is the worst outcome available: a permanent code change
    // made to chase noise, with the flake still there afterwards.
    const result = await proposeHeal(bundle(), { ...BASE, flakeScore: 0.4 });
    expect(result.status).toBe('refused-flaky');
    expect(result.reason).toContain('Bisect it first');
  });

  it('given a test whose flake score is below the threshold -> when proposeHeal runs -> then a heal is proposed', { tags: ['@unit', '@heal'] }, async () => {
    const result = await proposeHeal(bundle(), { ...BASE, flakeScore: 0.02 });
    expect(result.status).toBe('proposed');
  });
});

describe('proposeHeal — eligibility', () => {
  it('given a page where the missing test id is actually present -> when proposeHeal runs -> then it refuses as ineligible, because that is not a rename', { tags: ['@unit', '@heal'] }, async () => {
    const result = await proposeHeal(
      bundle({ testIds: ['gym-card-name', 'gym-card-county'] }),
      BASE,
    );
    expect(result.status).toBe('refused-ineligible');
    expect(result.reason).toContain('IS present');
  });

  it('given a bundle carrying no captured test-id index -> when proposeHeal runs -> then it refuses as ineligible and names the capture fixtures', { tags: ['@unit', '@heal'] }, async () => {
    const result = await proposeHeal(bundle({ testIds: [] }), BASE);
    expect(result.status).toBe('refused-ineligible');
    expect(result.reason).toContain('capture fixtures');
  });

  it('given a nameless getByRole selector -> when proposeHeal runs -> then it refuses as ineligible rather than guessing a name', { tags: ['@unit', '@heal'] }, async () => {
    const result = await proposeHeal(bundle({ selector: "getByRole('heading')" }), BASE);
    expect(result.status).toBe('refused-ineligible');
    expect(result.reason).toContain('without a name');
  });

  it('given a named getByRole selector and an aria snapshot holding a near match -> when proposeHeal runs -> then a role heal is proposed from the accessibility tree', { tags: ['@unit', '@heal'] }, async () => {
    const pageObject = `const typeFilter = (page: Page) => filters(page).getByRole('button', { name: 'Seminars', exact: true });\n`;
    const result = await proposeHeal(
      {
        ...bundle({ selector: "getByRole('button', { name: 'Seminars' })", testIds: [] }),
        page: {
          ...bundle().page,
          testIdsPresent: [],
          ariaSnapshot: '- button "Seminar"\n- button "Camps"\n- heading "Events"\n',
        },
      },
      {
        ...BASE,
        constantsFile: 'src/ui/pages/events/events.page.ts',
        constantsText: pageObject,
      },
    );

    expect(result.status).toBe('proposed');
    expect(result.chosen?.strategy).toBe('role');
    expect(result.chosen?.value).toBe('Seminar');
    expect(result.patch?.after).toContain("name: 'Seminar'");
  });

  it('given a page whose test ids resemble nothing in the failing selector -> when proposeHeal runs -> then it reports no candidates and says the element was probably removed', { tags: ['@unit', '@heal'] }, async () => {
    // Nothing on the page resembles the missing id. That is a real change,
    // and inventing a heal for it would hide a deletion.
    const result = await proposeHeal(
      bundle({ testIds: ['footer-copyright', 'navigation-links'] }),
      BASE,
    );
    expect(result.status).toBe('no-candidates');
    expect(result.reason).toContain('probably removed');
  });
});

describe('proposeHeal — the proposal', () => {
  it('given a renamed test id present on the page -> when proposeHeal runs -> then the closest rename is chosen and every constant bound to the literal is patched', { tags: ['@unit', '@heal'] }, async () => {
    const result = await proposeHeal(bundle(), BASE);

    expect(result.status).toBe('proposed');
    expect(result.chosen?.value).toBe('gym-card-title');
    expect(result.patch?.after).toContain("cardName: 'gym-card-title'");
    expect(result.patch?.after).toContain("county: 'gym-card-county'");
  });

  it('given validation is skipped -> when proposeHeal produces a proposal -> then no validation record is attached and the reason says NOT VALIDATED', { tags: ['@unit', '@heal'] }, async () => {
    // A dry run must not produce a record that reads as verified.
    const result = await proposeHeal(bundle(), BASE);
    expect(result.validation).toBeNull();
    expect(result.reason).toContain('NOT VALIDATED');
  });

  it('given a page holding a rename, a sibling field and an unrelated id -> when generateCandidates ranks them -> then the rename leads, the sibling follows and the unrelated id is excluded', { tags: ['@unit', '@heal'] }, async () => {
    const candidates = generateCandidates(bundle());
    expect(candidates[0]?.value).toBe('gym-card-title');
    expect(candidates.map(c => c.value)).toContain('gym-card-county');
    expect(candidates.map(c => c.value)).not.toContain('footer-copyright');
  });
});

describe('proposeHeal — resolves the source when --constants is omitted', () => {
  it('given no constants file is named and one exists under the default globs -> when proposeHeal resolves the source -> then it finds that file and patches it', { tags: ['@integration', '@heal'] }, async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const root = await mkdir(join(tmpdir(), `atest-heal-resolve-${Date.now()}`), { recursive: true });
    await mkdir(join(root, 'src/ui/pages/gyms'), { recursive: true });
    await writeFile(
      join(root, 'src/ui/pages/gyms/gyms.constants.ts'),
      CONSTANTS,
      'utf8',
    );

    const result = await proposeHeal(bundle(), {
      cwd: root,
      specFile: BASE.specFile,
      validationRuns: BASE.validationRuns,
      checkCollateral: BASE.checkCollateral,
      skipValidation: BASE.skipValidation,
    });

    expect(result.status).toBe('proposed');
    expect(result.patch?.file).toBe('src/ui/pages/gyms/gyms.constants.ts');
    expect(result.patch?.after).toContain("cardName: 'gym-card-title'");
  });
});

describe('assessBundle', () => {
  it('given a bundle with no captured test ids -> when assessBundle judges it -> then it reports ineligible with a reason rather than a bare boolean', { tags: ['@unit', '@heal'] }, () => {
    const assessment = assessBundle(bundle({ testIds: [] }));
    expect(assessment.eligible).toBe(false);
    expect(assessment.reason.length).toBeGreaterThan(20);
  });
});

describe('proposeHeal — Tier 1 cannot override Tier 0 safety', () => {
  const ranker = (chosen: string | null, realBug = false) => async () => ({
    used: true,
    model: 'claude-sonnet-5',
    outcome: 'chose',
    reasoning: 'the card renders the name here',
    confidence: 0.9,
    usd: 0.01,
    changedChoice: false,
    chosen,
    realBug,
  });

  it('given a schema_violation failure and a Tier 1 ranker -> when proposeHeal runs -> then it refuses as never-heal without consulting the ranker', { tags: ['@unit', '@heal'] }, async () => {
    // The hard guard runs first. A model must not get the chance to argue
    // that a schema violation is a renamed selector.
    let called = false;
    const result = await proposeHeal(bundle({ kind: 'schema_violation' }), {
      ...BASE,
      rankCandidates: async () => {
        called = true;
        return ranker('gym-card-title')();
      },
    });

    expect(result.status).toBe('refused-never-heal');
    expect(called).toBe(false);
  });

  it('given a known flaky test and a Tier 1 ranker -> when proposeHeal runs -> then the ranker is never consulted', { tags: ['@unit', '@heal'] }, async () => {
    let called = false;
    await proposeHeal(bundle(), {
      ...BASE,
      flakeScore: 0.5,
      rankCandidates: async () => {
        called = true;
        return ranker('gym-card-title')();
      },
    });
    expect(called).toBe(false);
  });

  it('given a Tier 1 ranker choosing another verified candidate -> when proposeHeal runs -> then that candidate is chosen and the change of choice is recorded', { tags: ['@unit', '@heal'] }, async () => {
    const result = await proposeHeal(bundle(), {
      ...BASE,
      rankCandidates: ranker('gym-card-county'),
    });

    expect(result.chosen?.value).toBe('gym-card-county');
    expect(result.tierOne?.changedChoice).toBe(true);
    expect(result.patch?.after).toContain("cardName: 'gym-card-county'");
  });

  it('given a Tier 1 ranker choosing a selector outside the verified set -> when proposeHeal runs -> then the Tier 0 choice stands', { tags: ['@unit', '@heal'] }, async () => {
    // Tier 1 ranks; it does not invent. Anything not in the verified list has
    // never been checked against the page.
    const result = await proposeHeal(bundle(), {
      ...BASE,
      rankCandidates: ranker('gym-card-fabricated'),
    });

    expect(result.chosen?.value).toBe('gym-card-title');
  });

  it('given a Tier 1 ranker reporting a real bug -> when proposeHeal runs -> then the heal is refused, the reason says to file a bug and no patch is produced', { tags: ['@unit', '@heal'] }, async () => {
    const result = await proposeHeal(bundle(), {
      ...BASE,
      rankCandidates: ranker(null, true),
    });

    expect(result.status).toBe('refused-never-heal');
    expect(result.reason).toContain('file a bug');
    expect(result.patch).toBeNull();
  });

  it('given runs with and without a Tier 1 ranker -> when proposeHeal produces each proposal -> then the tier and model are recorded only when the ranker ran', { tags: ['@unit', '@heal'] }, async () => {
    const withModel = await proposeHeal(bundle(), { ...BASE, rankCandidates: ranker('gym-card-title') });
    expect(withModel.tierOne?.used).toBe(true);
    expect(withModel.tierOne?.model).toBe('claude-sonnet-5');

    const withoutModel = await proposeHeal(bundle(), BASE);
    expect(withoutModel.tierOne).toBeNull();
  });
});
