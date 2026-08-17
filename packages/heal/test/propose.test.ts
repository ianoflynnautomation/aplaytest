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
  it('refuses a schema violation outright', async () => {
    // The wire contract broke. "Repairing" it deletes the most valuable signal
    // the suite produces.
    const result = await proposeHeal(bundle({ kind: 'schema_violation' }), BASE);
    expect(result.status).toBe('refused-never-heal');
    expect(result.patch).toBeNull();
  });

  it('refuses an uncaught application error', async () => {
    const result = await proposeHeal(bundle({ kind: 'app_error' }), BASE);
    expect(result.status).toBe('refused-never-heal');
  });

  it('refuses network and navigation failures', async () => {
    for (const kind of ['network_error', 'navigation_failure', 'http_status', 'infra'] as const) {
      const result = await proposeHeal(bundle({ kind }), BASE);
      expect(result.status).toBe('refused-never-heal');
    }
  });

  it('refuses to heal a known flaky test', async () => {
    // Healing a flake is the worst outcome available: a permanent code change
    // made to chase noise, with the flake still there afterwards.
    const result = await proposeHeal(bundle(), { ...BASE, flakeScore: 0.4 });
    expect(result.status).toBe('refused-flaky');
    expect(result.reason).toContain('Bisect it first');
  });

  it('proceeds when the test is below the flake threshold', async () => {
    const result = await proposeHeal(bundle(), { ...BASE, flakeScore: 0.02 });
    expect(result.status).toBe('proposed');
  });
});

describe('proposeHeal — eligibility', () => {
  it('refuses when the test id IS present, because that is not a rename', async () => {
    const result = await proposeHeal(
      bundle({ testIds: ['gym-card-name', 'gym-card-county'] }),
      BASE,
    );
    expect(result.status).toBe('refused-ineligible');
    expect(result.reason).toContain('IS present');
  });

  it('refuses when no test-id index was captured, and says how to fix it', async () => {
    const result = await proposeHeal(bundle({ testIds: [] }), BASE);
    expect(result.status).toBe('refused-ineligible');
    expect(result.reason).toContain('capture fixtures');
  });

  it('refuses a non-testid selector rather than guessing', async () => {
    const result = await proposeHeal(bundle({ selector: "getByRole('heading')" }), BASE);
    expect(result.status).toBe('refused-ineligible');
  });

  it('reports element-removed rather than forcing a bad rename', async () => {
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
  it('chooses the closest rename and patches every constant bound to it', async () => {
    const result = await proposeHeal(bundle(), BASE);

    expect(result.status).toBe('proposed');
    expect(result.chosen?.value).toBe('gym-card-title');
    expect(result.patch?.after).toContain("cardName: 'gym-card-title'");
    expect(result.patch?.after).toContain("county: 'gym-card-county'");
  });

  it('never claims validation it did not perform', async () => {
    // A dry run must not produce a record that reads as verified.
    const result = await proposeHeal(bundle(), BASE);
    expect(result.validation).toBeNull();
    expect(result.reason).toContain('NOT VALIDATED');
  });

  it('ranks the sibling field below the rename', async () => {
    const candidates = generateCandidates(bundle());
    expect(candidates[0]?.value).toBe('gym-card-title');
    expect(candidates.map(c => c.value)).toContain('gym-card-county');
    expect(candidates.map(c => c.value)).not.toContain('footer-copyright');
  });
});

describe('assessBundle', () => {
  it('explains a refusal instead of returning a bare boolean', () => {
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

  it('is never consulted for a NEVER_HEAL failure', async () => {
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

  it('is never consulted for a known flaky test', async () => {
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

  it('can reorder the choice among verified candidates', async () => {
    const result = await proposeHeal(bundle(), {
      ...BASE,
      rankCandidates: ranker('gym-card-county'),
    });

    expect(result.chosen?.value).toBe('gym-card-county');
    expect(result.tierOne?.changedChoice).toBe(true);
    expect(result.patch?.after).toContain("cardName: 'gym-card-county'");
  });

  it('ignores a choice outside the candidate set and keeps Tier 0', async () => {
    // Tier 1 ranks; it does not invent. Anything not in the verified list has
    // never been checked against the page.
    const result = await proposeHeal(bundle(), {
      ...BASE,
      rankCandidates: ranker('gym-card-fabricated'),
    });

    expect(result.chosen?.value).toBe('gym-card-title');
  });

  it('refuses the heal outright when Tier 1 says it is a real bug', async () => {
    const result = await proposeHeal(bundle(), {
      ...BASE,
      rankCandidates: ranker(null, true),
    });

    expect(result.status).toBe('refused-never-heal');
    expect(result.reason).toContain('file a bug');
    expect(result.patch).toBeNull();
  });

  it('records which tier produced the choice, for the ledger', async () => {
    const withModel = await proposeHeal(bundle(), { ...BASE, rankCandidates: ranker('gym-card-title') });
    expect(withModel.tierOne?.used).toBe(true);
    expect(withModel.tierOne?.model).toBe('claude-sonnet-5');

    const withoutModel = await proposeHeal(bundle(), BASE);
    expect(withoutModel.tierOne).toBeNull();
  });
});
