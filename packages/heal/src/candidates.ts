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
  parseLocator,
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
  /** Policy: which locator kinds Tier 0 may propose. Config, not convention. */
  readonly allowedStrategies?: readonly LocatorStrategy[] | undefined;
}

export const DEFAULT_CANDIDATE_OPTIONS: CandidateOptions = {
  maxDistance: 0.4,
  minStabilityRank: 4,
  limit: 10,
  allowedStrategies: ['testid', 'role', 'label', 'text'],
};

const DEFAULT_STRATEGIES: readonly LocatorStrategy[] = ['testid', 'role', 'label', 'text'];

function allows(options: CandidateOptions, strategy: LocatorStrategy): boolean {
  const allowed = options.allowedStrategies ?? DEFAULT_STRATEGIES;
  return allowed.includes(strategy) && STABILITY_RANK[strategy] <= options.minStabilityRank;
}

export interface AriaNode {
  readonly role: string;
  readonly name: string;
}

/** Playwright ARIA snapshots: `- heading "Gyms" [level=1]`. */
export function parseAriaSnapshot(snapshot: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  const pattern = /^\s*-\s+([a-z0-9-]+)\s+"([^"]+)"/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(snapshot)) !== null) {
    const role = match[1];
    const name = match[2];
    if (role !== undefined && name !== undefined) nodes.push({ role, name });
  }
  return nodes;
}

function labelDistance(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return 0;
  if (left.length === 0 || right.length === 0) return 1;
  if (left.startsWith(right) || right.startsWith(left)) {
    return Math.abs(left.length - right.length) / Math.max(left.length, right.length);
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const grid: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    const row = grid[i];
    const prev = grid[i - 1];
    if (row === undefined || prev === undefined) continue;
    for (let j = 1; j < cols; j++) {
      const cost = left.charAt(i - 1) === right.charAt(j - 1) ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
  }
  const distance = grid[left.length]?.[right.length] ?? Math.max(left.length, right.length);
  return distance / Math.max(left.length, right.length);
}

function scoreCandidate(
  strategy: LocatorStrategy,
  from: string,
  to: string,
  options: CandidateOptions,
  role?: string,
): HealCandidate {
  const semanticDistance = strategy === 'testid' ? testIdDistance(from, to) : labelDistance(from, to);
  const stabilityRank = STABILITY_RANK[strategy];
  return {
    strategy,
    value: to,
    expression:
      strategy === 'testid'
        ? `getByTestId('${to}')`
        : strategy === 'role'
          ? `getByRole('${role ?? 'button'}', { name: '${to}' })`
          : `getBy${strategy.charAt(0).toUpperCase()}${strategy.slice(1)}('${to}')`,
    semanticDistance,
    stabilityRank,
    stabilityDelta: 0,
    score:
      0.7 * (1 - semanticDistance) +
      0.3 * (1 - stabilityRank / Math.max(1, options.minStabilityRank)),
  };
}

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
  const missing = missingTestIds(bundle.intent.selector, bundle.page.testIdsPresent);
  const parsed = parseLocator(bundle.intent.selector);
  const out: HealCandidate[] = [];

  if (allows(options, 'testid') && missing.length === 1) {
    const target = missing[0];
    if (target !== undefined) {
      for (const id of bundle.page.testIdsPresent) {
        if (id === target) continue;
        out.push(scoreCandidate('testid', target, id, options));
      }
    }
  }

  const name = parsed?.accessibleName ?? (parsed !== null && parsed.strategy !== 'testid' ? parsed.value : null);
  if (name !== null && parsed !== null && allows(options, parsed.strategy) && parsed.strategy !== 'testid') {
    const nodes = parseAriaSnapshot(bundle.page.ariaSnapshot);
    const sameRole = parsed.strategy === 'role' ? nodes.filter(node => node.role === parsed.value) : nodes;
    for (const node of sameRole) {
      if (node.name === name) continue;
      out.push(scoreCandidate(parsed.strategy, name, node.name, options, parsed.value));
    }
  }

  return out
    .filter(candidate => candidate.semanticDistance <= options.maxDistance)
    .filter(candidate => candidate.stabilityRank <= options.minStabilityRank)
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

export function assessBundle(
  bundle: EvidenceBundle,
  options: CandidateOptions = DEFAULT_CANDIDATE_OPTIONS,
): HealEligibility {
  if (bundle.intent.selector === null) {
    return { eligible: false, reason: 'no selector was recorded for this failure' };
  }

  const referenced = testIdsIn(bundle.intent.selector);
  const parsed = parseLocator(bundle.intent.selector);

  if (referenced.length > 0) {
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
      return {
        eligible: false,
        reason:
          `${missing.length} test ids are missing at once (${missing.join(', ')}). That is a ` +
          'restructure rather than a rename — heal it by hand.',
      };
    }

    if (!allows(options, 'testid')) {
      return { eligible: false, reason: 'testid heals are disabled by heal.allowedStrategies' };
    }

    return { eligible: true, reason: `"${missing[0] ?? ''}" is absent from the page` };
  }

  if (parsed === null || parsed.strategy === 'css' || parsed.strategy === 'xpath') {
    return {
      eligible: false,
      reason: 'the selector is not a healable locator (testid, role, label, or text)',
    };
  }

  if (parsed.strategy === 'role' && parsed.accessibleName === null) {
    return {
      eligible: false,
      reason: 'getByRole without a name is too vague to heal — add an accessible name, or heal by hand',
    };
  }

  if (!allows(options, parsed.strategy)) {
    return {
      eligible: false,
      reason: `${parsed.strategy} heals are disabled by heal.allowedStrategies`,
    };
  }

  if (bundle.page.ariaSnapshot.trim() === '') {
    return {
      eligible: false,
      reason:
        'no accessibility tree was captured — install the atest capture fixtures so role/label/text ' +
        'heals have something to rank against',
    };
  }

  const intended = parsed.accessibleName ?? parsed.value;
  return { eligible: true, reason: `"${intended}" is absent from the page` };
}
