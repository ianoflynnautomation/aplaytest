"use strict";
/**
 * Locator stability ranking and parsing.
 *
 * A heal that makes a test pass by moving to a WEAKER locator is not a win:
 * replacing a test id with a text match makes the test green and makes it
 * fragile, coupling it to copy that product can change at any time. The engine
 * therefore treats a negative stability delta as a warning that forces human
 * review, and refuses to generate anything below a configured floor.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_STABILITY_RANK = exports.STABILITY_RANK = exports.LOCATOR_STRATEGIES = void 0;
exports.parseLocator = parseLocator;
exports.stabilityRankOf = stabilityRankOf;
exports.stabilityDelta = stabilityDelta;
exports.testIdDistance = testIdDistance;
exports.LOCATOR_STRATEGIES = [
    'testid',
    'role',
    'label',
    'placeholder',
    'text',
    'css',
    'xpath',
];
/** Lower is more durable. */
exports.STABILITY_RANK = {
    testid: 0,
    role: 1,
    label: 2,
    placeholder: 3,
    text: 4,
    css: 5,
    xpath: 6,
};
exports.MAX_STABILITY_RANK = 6;
const PATTERNS = [
    { strategy: 'testid', re: /getByTestId\(\s*['"`]([^'"`]+)['"`]/ },
    { strategy: 'testid', re: /\[data-testid=['"]?([^\]'"]+)['"]?\]/ },
    { strategy: 'role', re: /getByRole\(\s*['"`]([^'"`]+)['"`]/ },
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
function parseLocator(expression) {
    if (expression === null || expression === undefined)
        return null;
    const raw = expression.trim();
    if (raw === '')
        return null;
    for (const { strategy, re } of PATTERNS) {
        const match = re.exec(raw);
        const captured = match?.[1];
        if (captured !== undefined && captured !== '') {
            return { strategy, value: captured, raw };
        }
    }
    // Anything left that looks like a selector is treated as CSS. This is a
    // deliberate floor, not a guess: CSS ranks low, so an unparsed locator can
    // never be mistaken for a durable one.
    return { strategy: 'css', value: raw, raw };
}
function stabilityRankOf(strategy) {
    return exports.STABILITY_RANK[strategy];
}
/**
 * Positive = the replacement is MORE stable. Negative = less stable, which
 * requires human review regardless of aggressiveness setting.
 */
function stabilityDelta(from, to) {
    return exports.STABILITY_RANK[from] - exports.STABILITY_RANK[to];
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
function testIdDistance(a, b) {
    if (a === b)
        return 0;
    const at = a.split(/[-_.:]/).filter(Boolean);
    const bt = b.split(/[-_.:]/).filter(Boolean);
    if (at.length === 0 || bt.length === 0)
        return 1;
    const length = Math.max(at.length, bt.length);
    let mismatchWeight = 0;
    let totalWeight = 0;
    for (let i = 0; i < length; i++) {
        // Leading tokens weigh most: position 0 of a 3-token id carries 3/6.
        const weight = length - i;
        totalWeight += weight;
        if (at[i] !== bt[i])
            mismatchWeight += weight;
    }
    return totalWeight === 0 ? 1 : Math.min(1, mismatchWeight / totalWeight);
}
//# sourceMappingURL=stability.js.map