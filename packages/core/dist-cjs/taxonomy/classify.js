"use strict";
/**
 * Deterministic failure classification.
 *
 * No model. An ordered rule list, first match wins, most specific first.
 * Every classification records WHICH rule fired and WHICH signals it saw, so a
 * wrong verdict is debuggable rather than mysterious — the whole system routes
 * on this decision, and an opaque router is an unfixable router.
 *
 * ORDERING IS LOAD-BEARING. Two ordering choices in particular:
 *
 *   1. `infra` is checked first. A crashed browser surfaces as a timeout or a
 *      missing element; classifying it as `locator_not_found` would send a
 *      dead environment to the healing engine.
 *
 *   2. `schema_violation` and `app_error` are checked BEFORE any locator rule.
 *      If the app threw an uncaught exception and, as a consequence, an element
 *      never rendered, the root cause is the exception. Healing the selector
 *      would paper over a real bug — the exact outcome the NEVER_HEAL set
 *      exists to prevent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classify = classify;
exports.listRules = listRules;
const has = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());
const anyOf = (haystack, needles) => needles.filter(n => has(haystack, n));
const matcherIs = (f, ...names) => f.matcher !== null && names.some(n => f.matcher?.toLowerCase().includes(n.toLowerCase()) === true);
/** Signals that the application itself threw, rather than the test mis-looking. */
const UNCAUGHT_PATTERNS = [
    'Uncaught',
    'Unhandled',
    'Unhandled Promise Rejection',
    'TypeError:',
    'ReferenceError:',
    'The above error occurred in',
    'React will try to recreate',
];
const RULES = [
    // ── 1. Infrastructure ────────────────────────────────────────────────────
    // First, always. A dead browser must never reach the healing engine.
    {
        name: 'infra.browser-closed',
        kind: 'infra',
        confidence: 'high',
        match: f => {
            const hits = anyOf(f.message + f.stack, [
                'Target page, context or browser has been closed',
                'Browser has been closed',
                'browserType.launch',
                "Executable doesn't exist",
                'Protocol error',
                'Target crashed',
                'SIGSEGV',
                'out of memory',
            ]);
            return hits.length > 0 ? hits : null;
        },
    },
    // ── 2. Contract violations — never healable ──────────────────────────────
    {
        name: 'contract.schema-violation',
        kind: 'schema_violation',
        confidence: 'high',
        match: f => {
            const hits = anyOf(f.message + f.stack, [
                'ZodError',
                'Validation error:',
                'invalid_type',
                'unrecognized_keys',
                'invalid_union',
                'Expected object, received',
                'Required at ',
            ]);
            const fromNetwork = f.failedRequests
                .filter(r => r.schemaError !== null)
                .map(r => `schema error on ${r.method} ${r.url}`);
            const all = [...hits, ...fromNetwork];
            return all.length > 0 ? all : null;
        },
    },
    {
        name: 'contract.app-error',
        kind: 'app_error',
        confidence: 'medium',
        match: f => {
            // Deliberately requires an UNCAUGHT signal, not merely the presence of
            // console output. A stray console.warn must not veto a legitimate heal.
            const consoleHits = f.consoleErrors.filter(e => UNCAUGHT_PATTERNS.some(p => has(e, p)));
            const messageHits = anyOf(f.message, ['pageerror', 'page.on(\'pageerror\')']);
            const all = [
                ...consoleHits.map(e => `uncaught in console: ${e.slice(0, 120)}`),
                ...messageHits,
            ];
            return all.length > 0 ? all : null;
        },
    },
    // ── 3. Transport ─────────────────────────────────────────────────────────
    {
        name: 'transport.network-error',
        kind: 'network_error',
        confidence: 'high',
        match: f => {
            const hits = anyOf(f.message + f.stack, [
                'net::ERR_CONNECTION_REFUSED',
                'net::ERR_CONNECTION_RESET',
                'net::ERR_NAME_NOT_RESOLVED',
                'net::ERR_INTERNET_DISCONNECTED',
                'ECONNREFUSED',
                'ETIMEDOUT',
                'socket hang up',
                'fetch failed',
            ]);
            const fromRequests = f.failedRequests
                .filter(r => r.failureText !== null)
                .map(r => `request failed: ${r.method} ${r.url}`);
            const all = [...hits, ...fromRequests];
            return all.length > 0 ? all : null;
        },
    },
    {
        name: 'transport.navigation-failure',
        kind: 'navigation_failure',
        confidence: 'high',
        match: f => {
            const hits = anyOf(f.message, [
                'page.goto',
                'Navigation timeout',
                'navigation failed',
                'net::ERR_ABORTED',
            ]);
            return hits.length > 0 ? hits : null;
        },
    },
    {
        name: 'transport.http-status',
        kind: 'http_status',
        confidence: 'high',
        match: f => {
            if (matcherIs(f, 'toBeOK'))
                return ['matcher toBeOK failed'];
            const hits = anyOf(f.message, [
                'Unexpected status',
                'expected status',
                'toBeOK',
                'Response status code',
            ]);
            return hits.length > 0 ? hits : null;
        },
    },
    // ── 4. Snapshot comparisons ──────────────────────────────────────────────
    {
        name: 'snapshot.visual-diff',
        kind: 'visual_diff',
        confidence: 'high',
        match: f => {
            if (matcherIs(f, 'toHaveScreenshot'))
                return ['matcher toHaveScreenshot'];
            const hits = anyOf(f.message, [
                'Screenshot comparison failed',
                'toHaveScreenshot',
                'pixels (ratio',
                'A snapshot doesn\'t exist at',
            ]);
            return hits.length > 0 ? hits : null;
        },
    },
    {
        name: 'snapshot.aria-diff',
        kind: 'aria_diff',
        confidence: 'high',
        match: f => {
            if (matcherIs(f, 'toMatchAriaSnapshot'))
                return ['matcher toMatchAriaSnapshot'];
            const hits = anyOf(f.message, ['toMatchAriaSnapshot', 'aria snapshot']);
            return hits.length > 0 ? hits : null;
        },
    },
    // ── 5. Locator resolution ────────────────────────────────────────────────
    {
        name: 'locator.ambiguous',
        kind: 'locator_ambiguous',
        confidence: 'high',
        match: f => {
            const hits = anyOf(f.message, ['strict mode violation', 'resolved to 2 elements']);
            if (hits.length > 0)
                return hits;
            // "resolved to N elements" for any N > 1
            return /resolved to (\d+) elements/.test(f.message) &&
                !/resolved to 0 elements/.test(f.message)
                ? ['strict mode: multiple matches']
                : null;
        },
    },
    {
        name: 'locator.not-actionable',
        kind: 'locator_not_actionable',
        confidence: 'high',
        match: f => {
            const hits = anyOf(f.message, [
                'element is not visible',
                'element is not enabled',
                'element is not stable',
                'element is not editable',
                'intercepts pointer events',
                'element is outside of the viewport',
                'waiting for element to be visible, enabled and stable',
            ]);
            return hits.length > 0 ? hits : null;
        },
    },
    {
        name: 'locator.not-found',
        kind: 'locator_not_found',
        confidence: 'high',
        match: f => {
            const hits = anyOf(f.message, [
                'resolved to 0 elements',
                // Playwright renders a failed visibility assertion on a missing
                // element as `Received: <element(s) not found>`. That is a LOCATOR
                // problem (the address is gone), not a visibility problem — and the
                // distinction decides whether healing is even applicable, so this
                // rule must stay ahead of assertion.visibility.
                'element(s) not found',
                'locator resolved to hidden',
                'no element matching',
                'Element is not attached to the DOM',
            ]);
            // Playwright's call log says "waiting for getByTestId('…')" or
            // "waiting for locator('…')" depending on the API used.
            const waiting = /waiting for (locator|getBy|frameLocator)/i.test(f.message)
                ? ['call log: waiting for an element that never appeared']
                : [];
            // An action that timed out while resolving a locator is a not-found,
            // not a generic test timeout.
            const actionTimeout = f.timedOut && /locator\.\w+:|frameLocator|\.click\(|\.fill\(/.test(f.message)
                ? ['action timed out resolving its locator']
                : [];
            const all = [...hits, ...waiting, ...actionTimeout];
            return all.length > 0 ? all : null;
        },
    },
    // ── 6. Assertions ────────────────────────────────────────────────────────
    {
        name: 'assertion.visibility',
        kind: 'assertion_visibility',
        confidence: 'high',
        match: f => {
            if (matcherIs(f, 'toBeVisible', 'toBeHidden', 'toBeAttached', 'toHaveCount')) {
                return [`matcher ${f.matcher ?? ''} timed out`];
            }
            const hits = anyOf(f.message, ['toBeVisible', 'toBeHidden', 'toBeAttached', 'toHaveCount']);
            return hits.length > 0 ? hits : null;
        },
    },
    {
        name: 'assertion.value-mismatch',
        kind: 'assertion_value_mismatch',
        confidence: 'high',
        match: f => {
            if (matcherIs(f, 'toHaveText', 'toContainText', 'toHaveValue', 'toHaveAttribute', 'toMatchObject', 'toEqual', 'toBe', 'toHaveURL', 'toHaveTitle')) {
                return [`matcher ${f.matcher ?? ''} value mismatch`];
            }
            const hasExpectedReceived = (has(f.message, 'Expected') && has(f.message, 'Received')) ||
                has(f.message, 'Expected string') ||
                has(f.message, 'Expected pattern');
            return hasExpectedReceived ? ['expected/received mismatch in message'] : null;
        },
    },
];
/** Fallback used when a test timed out but nothing more specific matched. */
const TEST_TIMEOUT_RULE = {
    name: 'timeout.test-level',
    kind: 'assertion_visibility',
    confidence: 'low',
    match: f => f.timedOut || f.budgetUsedRatio >= 0.95
        ? [`test consumed ${(f.budgetUsedRatio * 100).toFixed(0)}% of its time budget`]
        : null,
};
function classify(failure) {
    for (const rule of RULES) {
        const signals = rule.match(failure);
        if (signals !== null && signals.length > 0) {
            return { kind: rule.kind, rule: rule.name, confidence: rule.confidence, signals };
        }
    }
    const timeoutSignals = TEST_TIMEOUT_RULE.match(failure);
    if (timeoutSignals !== null && timeoutSignals.length > 0) {
        return {
            kind: TEST_TIMEOUT_RULE.kind,
            rule: TEST_TIMEOUT_RULE.name,
            confidence: TEST_TIMEOUT_RULE.confidence,
            signals: timeoutSignals,
        };
    }
    return {
        kind: 'unknown',
        rule: 'none',
        confidence: 'low',
        signals: ['no rule matched — this is a taxonomy gap worth reporting'],
    };
}
/** Exposed for the CLI's `atest doctor --rules` and for prompt-corpus tooling. */
function listRules() {
    return [...RULES, TEST_TIMEOUT_RULE].map(r => ({ name: r.name, kind: r.kind }));
}
//# sourceMappingURL=classify.js.map