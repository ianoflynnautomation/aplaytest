/**
 * Tier-0 candidate generation and ranking.
 *
 * Entirely deterministic. The model, when it is eventually wired in, RANKS
 * pre-verified candidates by intent — it never invents a selector. That single
 * choice removes the whole class of "the AI suggested a locator that does not
 * exist", and it means the engine still resolves the common cases with no
 * model at all.
 */

import {
  STABILITY_RANK,
  testIdDistance,
  type EvidenceBundle,
  type LocatorStrategy,
} from '@atest/core';

/**
 * Every test id referenced by a locator expression, in order.
 *
 * Real page objects build COMPOSITE locators —
 * `getByTestId('gyms-list-item').filter({ has: getByTestId('gym-card-name') })`
 * — so "the test id of this selector" is not a single value. Taking the first
 * one finds the container, which is usually the id that still exists, and
 * concludes there is nothing to heal.
 */
export function testIdsIn(selector: string | null): string[] {
  if (selector === null) return [];
  const pattern = /getByTestId\(\s*['"`]([^'"`]+)['"`]/g;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(selector)) !== null) {
    const id = match[1];
    if (id !== undefined) out.push(id);
  }
  return out;
}

/**
 * Which referenced test id is actually missing from the page.
 *
 * This is the id to heal. The page's own test-id index is the evidence: a
 * composite locator can reference several ids, and only the absent one broke.
 */
export function missingTestIds(selector: string | null, present: readonly string[]): string[] {
  const referenced = testIdsIn(selector);
  const set = new Set(present);
  return referenced.filter(id => !set.has(id));
}

export interface HealCandidate {
  readonly strategy: LocatorStrategy;
  /** The replacement literal, e.g. 'gym-card-title'. */
  readonly value: string;
  /** A Playwright expression, for display. */
  readonly expression: string;
  /** 0 = means the same thing, 1 = unrelated. */
  readonly semanticDistance: number;
  readonly stabilityRank: number;
  /** Negative means the heal would WEAKEN the locator. */
  readonly stabilityDelta: number;
  /** 0..1, higher is better. Ordering only — never authorisation. */
  readonly score: number;
}

export interface CandidateOptions {
  /** Reject candidates further than this from the intended selector. */
  readonly maxDistance: number;
  /** Reject strategies weaker than this rank. 4 = text; excludes css/xpath. */
  readonly minStabilityRank: number;
  readonly limit: number;
}

export const DEFAULT_CANDIDATE_OPTIONS: CandidateOptions = {
  maxDistance: 0.4,
  minStabilityRank: 4,
  limit: 10,
};

/**
 * Rank candidates from the evidence bundle's test-id index.
 *
 * Scoring is ordering only. A heal is accepted because Playwright re-ran the
 * test and it passed — never because a number here was high.
 */
export function generateCandidates(
  bundle: EvidenceBundle,
  options: CandidateOptions = DEFAULT_CANDIDATE_OPTIONS,
): HealCandidate[] {
  const present = bundle.page.testIdsPresent;
  if (present.length === 0) return [];

  const missing = missingTestIds(bundle.intent.selector, present);
  const target = missing[0];
  if (target === undefined || missing.length > 1) return [];

  return present
    .filter(id => id !== target)
    .map(id => {
      const semanticDistance = testIdDistance(target, id);
      const stabilityRank = STABILITY_RANK.testid;
      return {
        strategy: 'testid' as const,
        value: id,
        expression: `getByTestId('${id}')`,
        semanticDistance,
        stabilityRank,
        stabilityDelta: 0,
        score:
          0.7 * (1 - semanticDistance) +
          0.3 * (1 - stabilityRank / Math.max(1, options.minStabilityRank)),
      };
    })
    .filter(c => c.semanticDistance <= options.maxDistance)
    .filter(c => c.stabilityRank <= options.minStabilityRank)
    .sort((a, b) => b.score - a.score || a.semanticDistance - b.semanticDistance)
    .slice(0, options.limit);
}

/**
 * Is this bundle worth attempting a heal on at all?
 *
 * Answers with a reason rather than a boolean, so the CLI can explain a
 * refusal instead of silently doing nothing.
 */
export interface HealEligibility {
  readonly eligible: boolean;
  readonly reason: string;
}

export function assessBundle(bundle: EvidenceBundle): HealEligibility {
  if (bundle.intent.selector === null) {
    return { eligible: false, reason: 'no selector was recorded for this failure' };
  }

  const referenced = testIdsIn(bundle.intent.selector);
  if (referenced.length === 0) {
    return {
      eligible: false,
      reason: 'the selector references no test id; Tier 0 heals test ids only',
    };
  }

  if (bundle.page.testIdsPresent.length === 0) {
    return {
      eligible: false,
      reason:
        'no test-id index was captured — install the atest capture fixtures so the page is ' +
        'recorded at failure time',
    };
  }

  const missing = missingTestIds(bundle.intent.selector, bundle.page.testIdsPresent);

  if (missing.length === 0) {
    return {
      eligible: false,
      reason:
        `every test id the selector references (${referenced.join(', ')}) IS present on the page, ` +
        'so this is not a rename. The elements exist but were not matched — look at scoping, ' +
        'filtering or visibility, not at the selector.',
    };
  }

  if (missing.length > 1) {
    // Two broken ids at once is a restructure, not a rename. Healing them
    // one at a time would validate against a page that is still wrong.
    return {
      eligible: false,
      reason:
        `${missing.length} test ids are missing at once (${missing.join(', ')}). That is a ` +
        'restructure rather than a rename — heal it by hand.',
    };
  }

  return { eligible: true, reason: `"${missing[0] ?? ''}" is absent from the page` };
}
