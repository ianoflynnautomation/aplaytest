"use strict";
/**
 * Capture fixtures — the optional upgrade over the reporter alone.
 *
 * A Playwright reporter runs in the main process and cannot reach into the
 * browser, so the things that best explain a failure — the ARIA tree, which
 * test ids actually exist, what the network did, what the app logged — have to
 * be collected in the worker and handed over as attachments.
 *
 * Three properties this file must hold, in priority order:
 *
 *   1. NEVER fail a test. Every capture is wrapped; a capture error is a
 *      warning on stderr, never an exception. Diagnostics that can break the
 *      suite are worse than no diagnostics.
 *   2. Cost nothing on green. The expensive work (ARIA snapshot, test-id
 *      sweep) runs only when a test has actually failed.
 *   3. Need no spec changes. Registered with `auto: true`, so adding it is a
 *      one-line change in the fixture composition and nothing else.
 *
 * UI PROJECTS ONLY. `auto: true` plus a `{ page }` dependency means Playwright
 * launches a browser for every test in the project, including tests that only
 * use `request`. API projects must compose `atestApiFixtures` from
 * ./api-fixtures.js instead — see the note there.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.expect = exports.test = exports.atestFixtures = void 0;
exports.createCaptureFixture = createCaptureFixture;
const test_1 = require("@playwright/test");
const sidecar_js_1 = require("./sidecar.js");
const DEFAULTS = {
    testIdAttribute: 'data-testid',
    slowRequestMs: 2_000,
    maxRequests: 200,
    maxConsoleEntries: 100,
};
function warn(message) {
    process.stderr.write(`[atest] ${message}\n`);
}
/** Run a capture step; never let it escape. */
async function safely(label, fn, fallback) {
    try {
        return await fn();
    }
    catch (error) {
        warn(`capture "${label}" failed: ${error instanceof Error ? error.message : String(error)}`);
        return fallback;
    }
}
async function attach(testInfo, name, payload) {
    await safely(`attach ${name}`, async () => {
        await testInfo.attach(name, {
            body: JSON.stringify(payload),
            contentType: 'application/json',
        });
    }, undefined);
}
/**
 * Collect every test id currently in the DOM.
 *
 * This single list answers the most common healing question — "was the id
 * renamed, or is the element genuinely gone?" — without a model and without a
 * second browser session.
 */
async function collectTestIds(page, attribute) {
    const ids = await page.evaluate(attr => {
        // Array.from rather than for-of: iterating a NodeList needs the
        // DOM.Iterable lib, and this package should carry the smallest browser
        // surface that compiles.
        const values = Array.from(document.querySelectorAll(`[${attr}]`), element => element.getAttribute(attr));
        return values.filter((value) => value !== null && value !== '');
    }, attribute);
    return [...new Set(ids)].sort();
}
function createCaptureFixture(options = {}) {
    const config = { ...DEFAULTS, ...options };
    return async ({ page }, use, testInfo) => {
        const requests = [];
        const consoleErrors = [];
        const consoleWarnings = [];
        const started = new Map();
        const routes = new Set();
        /**
         * Route coverage is recorded for EVERY test, passing or failing — unlike
         * the failure evidence below. It costs one listener and a Set, and it is
         * what lets impact analysis narrow past a shared fixture barrel that
         * makes every spec look like it depends on every feature.
         */
        const onNavigated = (frame) => {
            try {
                const { pathname } = new URL(frame.url());
                // Path only: query strings are per-test data, not coverage.
                if (pathname !== '' && pathname !== 'blank')
                    routes.add(pathname);
            }
            catch {
                // about:blank and data: URLs are not routes.
            }
        };
        const onRequest = (request) => {
            started.set(request.url(), Date.now());
        };
        const record = (entry) => {
            if (requests.length < config.maxRequests)
                requests.push(entry);
        };
        const onResponse = (response) => {
            const url = response.url();
            const startedAt = started.get(url);
            record({
                url,
                method: response.request().method(),
                status: response.status(),
                durationMs: startedAt === undefined ? 0 : Date.now() - startedAt,
                failureText: null,
                schemaError: null,
            });
        };
        const onRequestFailed = (request) => {
            const url = request.url();
            const startedAt = started.get(url);
            record({
                url,
                method: request.method(),
                status: null,
                durationMs: startedAt === undefined ? 0 : Date.now() - startedAt,
                failureText: request.failure()?.errorText ?? 'request failed',
                schemaError: null,
            });
        };
        const onConsole = (message) => {
            const type = message.type();
            if (type === 'error' && consoleErrors.length < config.maxConsoleEntries) {
                consoleErrors.push(message.text());
            }
            else if (type === 'warning' && consoleWarnings.length < config.maxConsoleEntries) {
                consoleWarnings.push(message.text());
            }
        };
        /**
         * An uncaught exception is the single strongest signal that the APP broke
         * rather than the test. It is prefixed to match the classifier's uncaught
         * patterns, which is what routes the failure to `app_error` — a kind that
         * is never healed.
         */
        const onPageError = (error) => {
            if (consoleErrors.length < config.maxConsoleEntries) {
                consoleErrors.push(`Uncaught ${error.name}: ${error.message}`);
            }
        };
        page.on('framenavigated', onNavigated);
        page.on('request', onRequest);
        page.on('response', onResponse);
        page.on('requestfailed', onRequestFailed);
        page.on('console', onConsole);
        page.on('pageerror', onPageError);
        await use();
        page.off('framenavigated', onNavigated);
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('requestfailed', onRequestFailed);
        page.off('console', onConsole);
        page.off('pageerror', onPageError);
        // Coverage is attached regardless of outcome — a passing test's routes are
        // exactly what future selection needs to know about.
        if (routes.size > 0) {
            await attach(testInfo, sidecar_js_1.SIDECAR.coverage, { routes: [...routes].sort() });
        }
        // Everything below is failure-only: green tests pay nothing beyond the
        // listeners above.
        if (testInfo.status === testInfo.expectedStatus)
            return;
        const pageClosed = page.isClosed();
        const ariaSnapshot = pageClosed
            ? ''
            : await safely('aria snapshot', () => page.locator('body').ariaSnapshot(), '');
        const testIdsPresent = pageClosed
            ? []
            : await safely('test-id sweep', () => collectTestIds(page, config.testIdAttribute), []);
        const url = pageClosed ? '' : await safely('url', async () => page.url(), '');
        const title = pageClosed ? '' : await safely('title', () => page.title(), '');
        await attach(testInfo, sidecar_js_1.SIDECAR.page, {
            url,
            title,
            ariaSnapshot,
            testIdsPresent,
            htmlDigest: null,
        });
        const failed = requests.filter(r => r.failureText !== null || (r.status ?? 0) >= 400);
        // Phase 0 uses a fixed threshold. A per-route p95 baseline needs history,
        // which arrives with the flaky engine — claiming one now would be a
        // number nobody measured.
        const slow = requests.filter(r => r.durationMs >= config.slowRequestMs);
        const statusCounts = {};
        for (const request of requests) {
            const key = request.status === null ? 'failed' : String(request.status);
            statusCounts[key] = (statusCounts[key] ?? 0) + 1;
        }
        await attach(testInfo, sidecar_js_1.SIDECAR.network, { failed, slow, statusCounts });
        await attach(testInfo, sidecar_js_1.SIDECAR.console, { errors: consoleErrors, warnings: consoleWarnings });
    };
}
/**
 * Spread into a fixture composition:
 *
 *   export const test = base.extend({ ...atestFixtures, ...featureFixtures });
 *
 * `auto: true` means specs never mention it.
 */
exports.atestFixtures = {
    atestCapture: [createCaptureFixture(), { auto: true }],
};
/** Ready-made `test` for suites with no fixtures of their own. */
exports.test = test_1.test.extend({ ...exports.atestFixtures });
var test_2 = require("@playwright/test");
Object.defineProperty(exports, "expect", { enumerable: true, get: function () { return test_2.expect; } });
//# sourceMappingURL=fixtures.js.map