"use strict";
/**
 * The failure taxonomy.
 *
 * Classification is deterministic — string and structure matching over the
 * Playwright error plus features of the evidence bundle. No model is involved.
 * The taxonomy exists to ROUTE a failure: to healing, to flaky analysis, or to
 * "stop, this is a real bug".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROUTING = exports.NEVER_HEAL = exports.FAILURE_KINDS = void 0;
exports.healEligibility = healEligibility;
exports.isHealable = isHealable;
exports.countsTowardFlakeStats = countsTowardFlakeStats;
exports.FAILURE_KINDS = [
    'locator_not_found', // strict mode: 0 matches
    'locator_ambiguous', // strict mode violation: >1 match
    'locator_not_actionable', // found, but intercepted / disabled / unstable
    'assertion_value_mismatch', // toHaveText / toMatchObject / toHaveValue …
    'assertion_visibility', // toBeVisible / toBeHidden timed out
    'visual_diff', // toHaveScreenshot
    'aria_diff', // toMatchAriaSnapshot
    'navigation_failure',
    'network_error', // request failed / connection refused
    'http_status', // unexpected status in an API spec
    'schema_violation', // Zod parse failed — the wire contract broke
    'app_error', // console error / error boundary rendered
    'infra', // browser crash, OOM, port-forward down
    'unknown',
];
/**
 * Kinds that must NEVER produce a heal proposal, at any aggressiveness level.
 *
 * This is the most important guard in the system and it is code, not policy.
 * A suite's Zod schemas and console-error assertions exist so that drift fails
 * LOUDLY; a framework that "helpfully" repaired a `schema_violation` would
 * destroy the most valuable signal the suite produces.
 */
exports.NEVER_HEAL = new Set([
    'schema_violation',
    'app_error',
    'http_status',
    'network_error',
    'navigation_failure',
    'infra',
]);
exports.ROUTING = {
    locator_not_found: {
        heal: 'full',
        flake: 'weak',
        note: 'Element address is gone. The bread-and-butter heal.',
    },
    locator_ambiguous: {
        heal: 'full',
        flake: 'weak',
        note: 'More than one match — often a genuine duplication in the app.',
    },
    locator_not_actionable: {
        heal: 'propose-only',
        flake: 'strong',
        note: 'Found but not interactable. Usually timing or animation, not a wrong selector.',
    },
    assertion_value_mismatch: {
        heal: 'propose-only',
        flake: 'weak',
        note: 'Changing an assertion changes what the test proves. Human decides.',
    },
    assertion_visibility: {
        heal: 'propose-only',
        flake: 'strong',
        note: 'Most common genuine flake.',
    },
    visual_diff: {
        heal: 'propose-only',
        flake: 'weak',
        note: 'Route to the snapshot workflow, not to selector healing.',
    },
    aria_diff: {
        heal: 'propose-only',
        flake: 'weak',
        note: 'A semantic change — nearly always a real change.',
    },
    navigation_failure: {
        heal: 'never',
        flake: 'strong',
        note: 'Environment or app. Not a selector problem.',
    },
    network_error: {
        heal: 'never',
        flake: 'strong',
        note: 'Environment or app. Not a selector problem.',
    },
    http_status: {
        heal: 'never',
        flake: 'weak',
        note: 'The API behaved differently. That is the finding.',
    },
    schema_violation: {
        heal: 'never',
        flake: 'excluded',
        note: 'The wire contract broke. This IS the bug — never repair it.',
    },
    app_error: {
        heal: 'never',
        flake: 'weak',
        note: 'The application errored. This IS the bug — never repair it.',
    },
    infra: {
        heal: 'never',
        flake: 'excluded',
        note: 'Browser crash or environment failure. Not evidence about the test.',
    },
    unknown: {
        heal: 'never',
        flake: 'weak',
        note: 'Unclassified. Every occurrence is a taxonomy gap worth reporting.',
    },
};
function healEligibility(kind) {
    if (exports.NEVER_HEAL.has(kind))
        return 'never';
    return exports.ROUTING[kind].heal;
}
function isHealable(kind) {
    return healEligibility(kind) !== 'never';
}
function countsTowardFlakeStats(kind) {
    return exports.ROUTING[kind].flake !== 'excluded';
}
//# sourceMappingURL=kinds.js.map