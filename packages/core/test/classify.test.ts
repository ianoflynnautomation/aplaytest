import { describe, expect, it } from 'vitest';

import { classify } from '../src/taxonomy/classify.js';
import { isHealable, NEVER_HEAL, countsTowardFlakeStats } from '../src/taxonomy/kinds.js';
import type { ClassifiableFailure, RequestRecord } from '../src/evidence/types.js';

/** Build a failure fixture. Real Playwright message text goes in `message`. */
function failure(overrides: Partial<ClassifiableFailure> = {}): ClassifiableFailure {
  return {
    message: '',
    stack: '',
    matcher: null,
    timedOut: false,
    consoleErrors: [],
    failedRequests: [],
    budgetUsedRatio: 0.2,
    ...overrides,
  };
}

function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    url: 'http://127.0.0.1:8080/api/gyms',
    method: 'GET',
    status: 200,
    durationMs: 120,
    failureText: null,
    schemaError: null,
    ...overrides,
  };
}

describe('classify — locator resolution', () => {
  it('given a strict mode violation naming 12 matched elements -> when classify runs -> then kind is locator_ambiguous', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        message: [
          `Error: strict mode violation: getByTestId('gyms-list-item') resolved to 12 elements:`,
          `    1) <li data-testid="gyms-list-item">…</li>`,
          `    2) <li data-testid="gyms-list-item">…</li>`,
        ].join('\n'),
      }),
    );
    expect(c.kind).toBe('locator_ambiguous');
  });

  it('given a toBeVisible timeout reporting element(s) not found -> when classify runs -> then kind is locator_not_found and the kind is healable', { tags: ['@unit', '@taxonomy'] }, () => {
    // This is the discriminator that decides whether healing even applies.
    const c = classify(
      failure({
        matcher: 'toBeVisible',
        timedOut: true,
        message: [
          `Error: expect(locator).toBeVisible() failed`,
          ``,
          `Locator: getByTestId('gym-card-name')`,
          `Expected: visible`,
          `Received: <element(s) not found>`,
          `Timeout: 5000ms`,
        ].join('\n'),
      }),
    );
    expect(c.kind).toBe('locator_not_found');
    expect(isHealable(c.kind)).toBe(true);
  });

  it('given a toBeVisible timeout reporting a received value of hidden -> when classify runs -> then kind is assertion_visibility', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        matcher: 'toBeVisible',
        timedOut: true,
        message: [
          `Error: expect(locator).toBeVisible() failed`,
          ``,
          `Locator: getByTestId('no-data-state')`,
          `Expected: visible`,
          `Received: hidden`,
          `Timeout: 5000ms`,
        ].join('\n'),
      }),
    );
    expect(c.kind).toBe('assertion_visibility');
  });

  it('given a click timeout whose call log resolved the locator to a disabled element -> when classify runs -> then kind is locator_not_actionable', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        timedOut: true,
        message: [
          `Error: locator.click: Timeout 30000ms exceeded.`,
          `Call log:`,
          `  - waiting for getByTestId('select-filter-select')`,
          `  -   locator resolved to <select data-testid="select-filter-select">…</select>`,
          `  - attempting click action`,
          `  -   waiting for element to be visible, enabled and stable`,
          `  -   element is not enabled`,
        ].join('\n'),
      }),
    );
    expect(c.kind).toBe('locator_not_actionable');
  });

  it('given a click timeout whose call log never resolved the locator -> when classify runs -> then kind is locator_not_found', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        timedOut: true,
        message: [
          `Error: locator.click: Timeout 30000ms exceeded.`,
          `Call log:`,
          `  - waiting for getByTestId('search-clear-button')`,
        ].join('\n'),
      }),
    );
    expect(c.kind).toBe('locator_not_found');
  });
});

describe('classify — assertions and snapshots', () => {
  it('given a toHaveText failure with differing expected and received strings -> when classify runs -> then kind is assertion_value_mismatch and the kind is healable', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        matcher: 'toHaveText',
        message: [
          `Error: expect(locator).toHaveText(expected) failed`,
          ``,
          `Locator: getByTestId('gyms-page-header-title')`,
          `Expected string: "Gyms"`,
          `Received string: "BJJ Gyms"`,
        ].join('\n'),
      }),
    );
    expect(c.kind).toBe('assertion_value_mismatch');
    // Assertion heals may be proposed but never auto-applied.
    expect(isHealable(c.kind)).toBe(true);
  });

  it('given a toHaveScreenshot failure reporting differing pixels -> when classify runs -> then kind is visual_diff rather than a selector heal', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        matcher: 'toHaveScreenshot',
        message: [
          `Error: expect(page).toHaveScreenshot(expected) failed`,
          ``,
          `  12345 pixels (ratio 0.02 of all image pixels) are different.`,
        ].join('\n'),
      }),
    );
    expect(c.kind).toBe('visual_diff');
  });

  it('given a toMatchAriaSnapshot failure -> when classify runs -> then kind is aria_diff', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(failure({ matcher: 'toMatchAriaSnapshot', message: 'toMatchAriaSnapshot failed' }));
    expect(c.kind).toBe('aria_diff');
  });
});

describe('classify — the never-heal guards', () => {
  it('given a Zod validation error in the failure message -> when classify runs -> then kind is schema_violation and healing is refused', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        message:
          'Error: Validation error: Invalid input: expected string, received number at "data[0].name"',
      }),
    );
    expect(c.kind).toBe('schema_violation');
    expect(isHealable(c.kind)).toBe(false);
    expect(NEVER_HEAL.has(c.kind)).toBe(true);
  });

  it('given a generic assertion message and a failed request carrying a schemaError -> when classify runs -> then kind is schema_violation', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        message: 'Error: expect(received).toBeTruthy()',
        failedRequests: [request({ schemaError: 'expected array, received object' })],
      }),
    );
    expect(c.kind).toBe('schema_violation');
  });

  it('given a not-found locator failure alongside an uncaught TypeError in the console -> when classify runs -> then kind is app_error and healing is refused', { tags: ['@unit', '@taxonomy'] }, () => {
    // The element is missing *because* the app threw. Healing the selector
    // here would paper over a real bug.
    const c = classify(
      failure({
        matcher: 'toBeVisible',
        timedOut: true,
        message: [
          `Error: expect(locator).toBeVisible() failed`,
          `Locator: getByTestId('gyms-list')`,
          `Received: <element(s) not found>`,
        ].join('\n'),
        consoleErrors: ["Uncaught TypeError: Cannot read properties of undefined (reading 'map')"],
      }),
    );
    expect(c.kind).toBe('app_error');
    expect(isHealable(c.kind)).toBe(false);
  });

  it('given a not-found locator failure alongside an ordinary favicon 404 console warning -> when classify runs -> then kind is locator_not_found and the heal is not vetoed', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        matcher: 'toBeVisible',
        message: `Received: <element(s) not found>\nLocator: getByTestId('gym-card-name')`,
        consoleErrors: ['Failed to load resource: favicon.ico 404'],
      }),
    );
    expect(c.kind).toBe('locator_not_found');
  });

  it('given a message reporting the browser has been closed -> when classify runs -> then kind is infra, excluded from flake statistics and not healable', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        message: 'Error: Target page, context or browser has been closed',
        timedOut: true,
      }),
    );
    expect(c.kind).toBe('infra');
    expect(countsTowardFlakeStats(c.kind)).toBe(false);
    expect(isHealable(c.kind)).toBe(false);
  });

  it('given a page.goto failure reporting net::ERR_CONNECTION_REFUSED -> when classify runs -> then kind is network_error and healing is refused', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8080/gyms',
      }),
    );
    expect(c.kind).toBe('network_error');
    expect(isHealable(c.kind)).toBe(false);
  });

  it('given a toBeOK assertion failure -> when classify runs -> then kind is http_status and healing is refused', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(failure({ matcher: 'toBeOK', message: 'Error: expect(received).toBeOK()' }));
    expect(c.kind).toBe('http_status');
    expect(isHealable(c.kind)).toBe(false);
  });
});

describe('classify — auditability and fallbacks', () => {
  it('given a strict mode violation message -> when classify runs -> then rule is locator.ambiguous and at least one signal is recorded', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(failure({ message: 'strict mode violation: resolved to 3 elements' }));
    expect(c.rule).toBe('locator.ambiguous');
    expect(c.signals.length).toBeGreaterThan(0);
  });

  it('given a failure message matching no rule -> when classify runs -> then kind is unknown with rule none and low confidence', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(failure({ message: 'Error: something nobody anticipated' }));
    expect(c.kind).toBe('unknown');
    expect(c.rule).toBe('none');
    expect(c.confidence).toBe('low');
  });

  it('given a test timeout that consumed its whole budget -> when classify runs -> then kind is assertion_visibility with low confidence', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({ message: 'Test timeout of 30000ms exceeded.', timedOut: true, budgetUsedRatio: 1 }),
    );
    expect(c.kind).toBe('assertion_visibility');
    expect(c.confidence).toBe('low');
  });

  /**
   * Playwright quotes the failing line plus a few either side into
   * `error.message`. Those neighbours are the user's source, they have already
   * run, and they must not vote. Verbatim from run 33253028409: a click that
   * timed out was routed `navigation_failure` — `heal: never` — because two
   * lines above it the spec read `await page.goto('/about')`.
   */
  it('given a click timeout whose code frame quotes an earlier page.goto -> when classify runs -> then kind is locator_not_actionable rather than navigation_failure', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({
        message: [
          'TimeoutError: locator.click: Timeout 10000ms exceeded.',
          'Call log:',
          "  - waiting for getByTestId('navigation-mobile-toggle')",
          '  - attempting click action',
          '    - waiting for element to be visible, enabled and stable',
          '',
          "  13 |       await page.goto('/about');",
          '  14 |',
          '> 15 |       await page.getByTestId(mobileToggle).click();',
          '     |                                            ^',
          '    at /repo/tests/layout/mobile-nav.ui.acceptance.spec.ts:15:44',
        ].join('\n'),
        timedOut: true,
      }),
    );

    expect(c.kind).not.toBe('navigation_failure');
    expect(c.kind).toBe('locator_not_actionable');
  });

  it('given a navigation failure Playwright reports in its own prose -> when classify runs -> then kind is network_error, because the transport outranks the navigation', { tags: ['@unit', '@taxonomy'] }, () => {
    const c = classify(
      failure({ message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8080/gyms' }),
    );

    // net::ERR_ outranks navigation: the transport is what actually broke.
    expect(c.kind).toBe('network_error');
  });
});
