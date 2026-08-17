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
  it('reads a strict-mode violation as ambiguous, not as not-found', () => {
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

  it('reads "element(s) not found" as a locator problem, not a visibility problem', () => {
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

  it('reads a hidden-but-present element as a visibility assertion', () => {
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

  it('prefers not-actionable over not-found when the element did resolve', () => {
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

  it('classifies an action that never resolved its locator as not-found', () => {
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
  it('classifies a text mismatch as a value mismatch', () => {
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

  it('routes a screenshot diff to the visual kind, not to selector healing', () => {
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

  it('recognises an aria snapshot mismatch', () => {
    const c = classify(failure({ matcher: 'toMatchAriaSnapshot', message: 'toMatchAriaSnapshot failed' }));
    expect(c.kind).toBe('aria_diff');
  });
});

describe('classify — the never-heal guards', () => {
  it('classifies a Zod parse failure as a schema violation and refuses to heal it', () => {
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

  it('detects a schema failure carried on a request record even when the message is generic', () => {
    const c = classify(
      failure({
        message: 'Error: expect(received).toBeTruthy()',
        failedRequests: [request({ schemaError: 'expected array, received object' })],
      }),
    );
    expect(c.kind).toBe('schema_violation');
  });

  it('treats an uncaught app exception as the root cause, ahead of any locator rule', () => {
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

  it('does NOT let an ordinary console warning veto a legitimate heal', () => {
    const c = classify(
      failure({
        matcher: 'toBeVisible',
        message: `Received: <element(s) not found>\nLocator: getByTestId('gym-card-name')`,
        consoleErrors: ['Failed to load resource: favicon.ico 404'],
      }),
    );
    expect(c.kind).toBe('locator_not_found');
  });

  it('classifies a crashed browser as infra and excludes it from flake statistics', () => {
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

  it('classifies a refused connection as a network error', () => {
    const c = classify(
      failure({
        message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8080/gyms',
      }),
    );
    expect(c.kind).toBe('network_error');
    expect(isHealable(c.kind)).toBe(false);
  });

  it('classifies an unexpected HTTP status as an API finding, not a heal candidate', () => {
    const c = classify(failure({ matcher: 'toBeOK', message: 'Error: expect(received).toBeOK()' }));
    expect(c.kind).toBe('http_status');
    expect(isHealable(c.kind)).toBe(false);
  });
});

describe('classify — auditability and fallbacks', () => {
  it('always reports the rule that fired and the signals it saw', () => {
    const c = classify(failure({ message: 'strict mode violation: resolved to 3 elements' }));
    expect(c.rule).toBe('locator.ambiguous');
    expect(c.signals.length).toBeGreaterThan(0);
  });

  it('falls back to unknown rather than guessing, and says so', () => {
    const c = classify(failure({ message: 'Error: something nobody anticipated' }));
    expect(c.kind).toBe('unknown');
    expect(c.rule).toBe('none');
    expect(c.confidence).toBe('low');
  });

  it('uses the low-confidence timeout fallback when a test exhausts its budget', () => {
    const c = classify(
      failure({ message: 'Test timeout of 30000ms exceeded.', timedOut: true, budgetUsedRatio: 1 }),
    );
    expect(c.kind).toBe('assertion_visibility');
    expect(c.confidence).toBe('low');
  });
});
