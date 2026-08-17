/**
 * The heal pipeline, end to end.
 *
 * Order is load-bearing, and two of the gates are the whole reason this is
 * defensible at all:
 *
 *   1. NEVER_HEAL kinds are refused outright. A schema violation or an
 *      uncaught application error IS the bug; "repairing" it would delete the
 *      most valuable signal a suite produces.
 *   2. Known-flaky tests are refused. Healing a flake is the worst outcome
 *      available: a permanent code change made to chase noise, the flake
 *      continues, and now the selector is wrong too. Flaky and broken are
 *      different problems, and the engine must decide which it is FIRST.
 *
 * Only then does it generate candidates, and only then does Playwright decide.
 */

import { NEVER_HEAL, ROUTING, isHealable, type EvidenceBundle } from '@atest/core';

import {
  assessBundle,
  generateCandidates,
  missingTestIds,
  DEFAULT_CANDIDATE_OPTIONS,
  type CandidateOptions,
  type HealCandidate,
} from './candidates.js';
import { patchConstant, type PatchResult } from './patch.js';
import { validateHeal, type ValidationRecord } from './validate.js';

export type ProposalStatus =
  | 'proposed'
  | 'refused-never-heal'
  | 'refused-flaky'
  | 'refused-ineligible'
  | 'no-candidates'
  | 'no-constant'
  | 'rejected';

export interface TierOneRecord {
  readonly used: boolean;
  readonly model: string | null;
  readonly outcome: string;
  readonly reasoning: string | null;
  readonly confidence: number | null;
  readonly usd: number;
  /** True when Tier 1 picked something other than Tier 0's top candidate. */
  readonly changedChoice: boolean;
}

export interface HealProposal {
  readonly status: ProposalStatus;
  readonly evidenceId: string;
  readonly testTitle: string;
  readonly reason: string;
  readonly intendedSelector: string | null;
  readonly candidates: readonly HealCandidate[];
  readonly chosen: HealCandidate | null;
  readonly patch: PatchResult | null;
  readonly validation: ValidationRecord | null;
  readonly tierOne: TierOneRecord | null;
}

export interface ProposeOptions {
  readonly cwd: string;
  /** Constants file that defines the selector. */
  readonly constantsFile: string;
  readonly constantsText: string;
  readonly specFile: string;
  readonly config?: string | undefined;
  readonly project?: string | undefined;
  readonly validationRuns: number;
  readonly checkCollateral: boolean;
  readonly candidateOptions?: CandidateOptions | undefined;
  /** Flake score for this test, when history is available. */
  readonly flakeScore?: number | undefined;
  readonly flakeThreshold?: number | undefined;
  /** Skip the re-run — for `--dry-run`, which must never claim validation. */
  readonly skipValidation?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Optional Tier-1 ranker. Given the same verified candidates, it may reorder
   * them by intent — and nothing else. Its choice is still validated by a
   * re-run, so a wrong answer costs a rejected proposal, never a bad patch.
   */
  readonly rankCandidates?:
    | ((input: {
        readonly candidates: readonly HealCandidate[];
        readonly missingTestId: string;
      }) => Promise<TierOneRecord & { readonly chosen: string | null; readonly realBug: boolean }>)
    | undefined;
}

export const DEFAULT_HEAL_OPTIONS = {
  validationRuns: 3,
  checkCollateral: true,
  flakeThreshold: 0.15,
};

function refuse(
  bundle: EvidenceBundle,
  status: ProposalStatus,
  reason: string,
  candidates: readonly HealCandidate[] = [],
): HealProposal {
  return {
    status,
    evidenceId: bundle.id,
    testTitle: bundle.test.title,
    reason,
    intendedSelector: bundle.intent.selector,
    candidates,
    chosen: null,
    patch: null,
    validation: null,
    tierOne: null,
  };
}

export async function proposeHeal(
  bundle: EvidenceBundle,
  options: ProposeOptions,
): Promise<HealProposal> {
  const kind = bundle.failure.kind;

  // Gate 1 — the hard guard. Not a policy setting; not overridable.
  if (NEVER_HEAL.has(kind) || !isHealable(kind)) {
    return refuse(
      bundle,
      'refused-never-heal',
      `${kind}: ${ROUTING[kind].note} Healing is refused for this failure kind.`,
    );
  }

  // Gate 2 — flaky before broken. Changing code to chase noise leaves you with
  // the noise AND a wrong selector.
  const threshold = options.flakeThreshold ?? DEFAULT_HEAL_OPTIONS.flakeThreshold;
  if (options.flakeScore !== undefined && options.flakeScore > threshold) {
    return refuse(
      bundle,
      'refused-flaky',
      `This test scores ${options.flakeScore.toFixed(2)} for flakiness (threshold ${threshold}). ` +
        'Healing a flake changes code permanently to chase noise. Bisect it first.',
    );
  }

  const eligibility = assessBundle(bundle);
  if (!eligibility.eligible) {
    return refuse(bundle, 'refused-ineligible', eligibility.reason);
  }

  const candidates = generateCandidates(bundle, options.candidateOptions ?? DEFAULT_CANDIDATE_OPTIONS);
  if (candidates.length === 0) {
    return refuse(
      bundle,
      'no-candidates',
      `${eligibility.reason}, and no test id on the page is close enough to be a plausible rename. ` +
        'The element was probably removed — that is a real change, not a drifted selector.',
    );
  }

  let chosen = candidates[0];
  if (chosen === undefined) return refuse(bundle, 'no-candidates', 'no candidate survived ranking');

  // The id to replace is the MISSING one, not the first one the selector
  // mentions: a composite locator names its container first, and the
  // container is usually the id that still exists.
  const intendedValue = missingTestIds(bundle.intent.selector, bundle.page.testIdsPresent)[0];
  if (intendedValue === undefined) {
    return refuse(bundle, 'refused-ineligible', 'could not identify which test id is missing');
  }

  // Tier 1: reorder by intent, if a ranker is wired in. It can only pick from
  // the candidates Tier 0 already verified, and its pick is validated exactly
  // the same way — so the worst a wrong answer costs is a rejected proposal.
  let tierOne: TierOneRecord | null = null;
  if (options.rankCandidates !== undefined) {
    const ranked = await options.rankCandidates({ candidates, missingTestId: intendedValue });
    tierOne = {
      used: ranked.used,
      model: ranked.model,
      outcome: ranked.outcome,
      reasoning: ranked.reasoning,
      confidence: ranked.confidence,
      usd: ranked.usd,
      changedChoice: ranked.chosen !== null && ranked.chosen !== chosen.value,
    };

    if (ranked.realBug) {
      return {
        ...refuse(
          bundle,
          'refused-never-heal',
          'The ranker judged this an application defect rather than a renamed selector. ' +
            'Healing is refused; file a bug.',
          candidates,
        ),
        tierOne,
      };
    }

    const preferred = candidates.find(c => c.value === ranked.chosen);
    if (preferred !== undefined) chosen = preferred;
  }

  const patch = patchConstant(options.constantsText, {
    file: options.constantsFile,
    from: intendedValue,
    to: chosen.value,
  });

  if (patch.status !== 'applied' || patch.after === null) {
    return {
      ...refuse(bundle, 'no-constant', patch.message, candidates),
      chosen,
      patch,
      tierOne,
    };
  }

  if (options.skipValidation === true) {
    return {
      status: 'proposed',
      evidenceId: bundle.id,
      testTitle: bundle.test.title,
      reason: `${eligibility.reason}. NOT VALIDATED — re-run required before this can be accepted.`,
      intendedSelector: bundle.intent.selector,
      candidates,
      chosen,
      patch,
      validation: null,
      tierOne,
    };
  }

  const validation = await validateHeal({
    cwd: options.cwd,
    specFile: options.specFile,
    testTitle: bundle.test.title,
    patchFile: options.constantsFile,
    patchedText: patch.after,
    config: options.config,
    project: options.project,
    runs: options.validationRuns,
    checkCollateral: options.checkCollateral,
    timeoutMs: options.timeoutMs,
  });

  return {
    status: validation.status === 'validated' ? 'proposed' : 'rejected',
    evidenceId: bundle.id,
    testTitle: bundle.test.title,
    reason: validation.message,
    intendedSelector: bundle.intent.selector,
    candidates,
    chosen,
    patch,
    validation,
    tierOne,
  };
}
