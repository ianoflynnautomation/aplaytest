/**
 * Locator stability ranking and parsing.
 *
 * A heal that makes a test pass by moving to a WEAKER locator is not a win:
 * replacing a test id with a text match makes the test green and makes it
 * fragile, coupling it to copy that product can change at any time. The engine
 * therefore treats a negative stability delta as a warning that forces human
 * review, and refuses to generate anything below a configured floor.
 */

export const LOCATOR_STRATEGIES = [
  'testid',
  'role',
  'label',
  'placeholder',
  'text',
  'css',
  'xpath',
] as const;

export type LocatorStrategy = (typeof LOCATOR_STRATEGIES)[number];

/** Lower is more durable. */
export const STABILITY_RANK: Readonly<Record<LocatorStrategy, number>> = {
  testid: 0,
  role: 1,
  label: 2,
  placeholder: 3,
  text: 4,
  css: 5,
  xpath: 6,
};

export const MAX_STABILITY_RANK = 6;

export interface ParsedLocator {
  readonly strategy: LocatorStrategy;
  /** The identifying value: a test id, an accessible name, a CSS selector. */
  readonly value: string;
  /** The original expression, verbatim. */
  readonly raw: string;
  /**
   * Accessible name when the locator carries one (`getByRole('button', { name })`).
   * Null for nameless roles — those are too vague to heal.
   */
  readonly accessibleName: string | null;
}

const ROLE_WITH_NAME =
  /getByRole\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{[^}]*\bname:\s*['"`]([^'"`]+)['"`]/;
const ROLE_ONLY = /getByRole\(\s*['"`]([^'"`]+)['"`]/;

const PATTERNS: ReadonlyArray<{ strategy: LocatorStrategy; re: RegExp }> = [
  { strategy: 'testid', re: /getByTestId\(\s*['"`]([^'"`]+)['"`]/ },
  { strategy: 'testid', re: /\[data-testid=['"]?([^\]'"]+)['"]?\]/ },
  { strategy: 'label', re: /getByLabel\(\s*['"`]([^'"`]+)['"`]/ },
  { strategy: 'placeholder', re: /getByPlaceholder\(\s*['"`]([^'"`]+)['"`]/ },
  { strategy: 'text', re: /getByText\(\s*['"`]([^'"`]+)['"`]/ },
  { strategy: 'text', re: /text=(.+)$/ },
  { strategy: 'xpath', re: /^\s*(?:xpath=)?(\/\/.+)$/ },
];

/**
 * Best-effort parse of a Playwright selector or locator expression.
 * Returns null when nothing recognisable is present — callers must handle it
 * rather than assuming a strategy.
 */
export function parseLocator(expression: string | null | undefined): ParsedLocator | null {
  if (expression === null || expression === undefined) return null;
  const raw = expression.trim();
  if (raw === '') return null;

  const namedRole = ROLE_WITH_NAME.exec(raw);
  const role = namedRole?.[1];
  const roleName = namedRole?.[2];
  if (role !== undefined && role !== '' && roleName !== undefined && roleName !== '') {
    return { strategy: 'role', value: role, raw, accessibleName: roleName };
  }

  const bareRole = ROLE_ONLY.exec(raw);
  const bare = bareRole?.[1];
  if (bare !== undefined && bare !== '') {
    return { strategy: 'role', value: bare, raw, accessibleName: null };
  }

  for (const { strategy, re } of PATTERNS) {
    const match = re.exec(raw);
    const captured = match?.[1];
    if (captured !== undefined && captured !== '') {
      return { strategy, value: captured, raw, accessibleName: null };
    }
  }

  // Anything left that looks like a selector is treated as CSS. This is a
  // deliberate floor, not a guess: CSS ranks low, so an unparsed locator can
  // never be mistaken for a durable one.
  return { strategy: 'css', value: raw, raw, accessibleName: null };
}

export function stabilityRankOf(strategy: LocatorStrategy): number {
  return STABILITY_RANK[strategy];
}

/**
 * Positive = the replacement is MORE stable. Negative = less stable, which
 * requires human review regardless of aggressiveness setting.
 */
export function stabilityDelta(from: LocatorStrategy, to: LocatorStrategy): number {
  return STABILITY_RANK[from] - STABILITY_RANK[to];
}

/**
 * Positional, prefix-weighted distance between two test ids.
 *
 * Test ids in a component-structured app read outside-in —
 * `<feature>-<component>-<element>` — so the LEADING tokens identify where the
 * element lives and the trailing token identifies what it is. Elements get
 * renamed far more often than they move between features, so disagreement in
 * the prefix is the stronger signal that these are different elements.
 * Weights therefore decay from the front.
 *
 *   gym-card-name → gym-card-title    0.17  same place, renamed  ← the common heal
 *   gym-card-name → gym-card-county   0.17  same place, sibling field
 *   gym-card-name → event-card-name   0.50  different feature
 *   gym-card-name → checkout-submit   1.00  unrelated
 *
 * Note that a rename and a sibling field score identically. That is honest:
 * nothing in the STRING distinguishes them. Separating the two is exactly the
 * judgement the Tier-1 ranker exists to make, using the failing assertion's
 * domain arguments — which is why Tier 0 hands over candidates rather than
 * picking one.
 *
 * Returns 0 (identical) .. 1 (nothing in common).
 */
export function testIdDistance(a: string, b: string): number {
  if (a === b) return 0;

  const at = a.split(/[-_.:]/).filter(Boolean);
  const bt = b.split(/[-_.:]/).filter(Boolean);
  if (at.length === 0 || bt.length === 0) return 1;

  const length = Math.max(at.length, bt.length);
  let mismatchWeight = 0;
  let totalWeight = 0;

  for (let i = 0; i < length; i++) {
    // Leading tokens weigh most: position 0 of a 3-token id carries 3/6.
    const weight = length - i;
    totalWeight += weight;
    if (at[i] !== bt[i]) mismatchWeight += weight;
  }

  return totalWeight === 0 ? 1 : Math.min(1, mismatchWeight / totalWeight);
}
