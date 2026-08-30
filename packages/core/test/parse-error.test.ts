import { describe, expect, it } from 'vitest';

import { parsePlaywrightError, splitCallLog, stripCodeFrame } from '../src/taxonomy/parse-error.js';

describe('parsePlaywrightError', () => {
  it('extracts matcher, locator and the expected/received pair from a text assertion', () => {
    const parsed = parsePlaywrightError(
      [
        `Error: expect(locator).toHaveText(expected) failed`,
        ``,
        `Locator: getByTestId('gyms-page-header-title')`,
        `Expected string: "Gyms"`,
        `Received string: "BJJ Gyms"`,
        `Timeout: 5000ms`,
      ].join('\n'),
    );

    expect(parsed.matcher).toBe('toHaveText');
    expect(parsed.locator).toBe("getByTestId('gyms-page-header-title')");
    expect(parsed.expected).toBe('"Gyms"');
    expect(parsed.actual).toBe('"BJJ Gyms"');
    expect(parsed.timeoutMs).toBe(5000);
  });

  it('treats a Timeout: line as an outcome, because Playwright only emits it after waiting', () => {
    // Verified against real 1.62 output: an assertion that consumed its budget
    // carries "Timeout: 1000ms"; one that failed structurally (strict mode)
    // carries none. So the line reports what happened, not what was configured.
    const waited = parsePlaywrightError(
      [
        `Error: expect(locator).toBeVisible() failed`,
        `Locator: getByTestId('gym-card-name')`,
        `Expected: visible`,
        `Timeout: 1000ms`,
        `Error: element(s) not found`,
      ].join('\n'),
    );
    expect(waited.timedOut).toBe(true);

    const immediate = parsePlaywrightError(
      [
        `Error: expect(locator).toBeVisible() failed`,
        `Locator: getByTestId('gyms-list-item')`,
        `Expected: visible`,
        `Error: strict mode violation: getByTestId('gyms-list-item') resolved to 2 elements:`,
      ].join('\n'),
    );
    expect(immediate.timedOut).toBe(false);
  });

  it('strips the ANSI colour codes Playwright embeds in error.message', () => {
    // Captured verbatim from a real run. The escapes split the matcher name
    // mid-word, so every pattern here fails unless they are removed first.
    const real =
      'Error: [2mexpect([22m[31mlocator[39m[2m).[22mtoBeVisible[2m([22m[2m)[22m failed\n\n' +
      "Locator: getByTestId('gym-card-name')\n" +
      'Expected: visible\n' +
      'Timeout: 1000ms\n' +
      'Error: element(s) not found\n';

    const parsed = parsePlaywrightError(real);
    expect(parsed.matcher).toBe('toBeVisible');
    expect(parsed.locator).toBe("getByTestId('gym-card-name')");
    expect(parsed.expected).toBe('visible');
    expect(parsed.actual).toBe('element(s) not found');
  });

  it('reads the trailing Error: line as the received value', () => {
    // Modern Playwright dropped "Received:" for assertion failures; the reason
    // now arrives as a second Error: line after the header.
    const parsed = parsePlaywrightError(
      [
        `Error: expect(locator).toBeVisible() failed`,
        `Expected: visible`,
        `Error: element(s) not found`,
      ].join('\n'),
    );
    expect(parsed.actual).toBe('element(s) not found');
  });

  it('still honours an explicit Received: line when one is present', () => {
    const parsed = parsePlaywrightError(
      [`Error: expect(locator).toHaveText(expected) failed`, `Received string: "BJJ Gyms"`].join('\n'),
    );
    expect(parsed.actual).toBe('"BJJ Gyms"');
  });

  it('reports a timeout when the message says one was exceeded', () => {
    const parsed = parsePlaywrightError(
      [`Error: locator.click: Timeout 30000ms exceeded.`, `Call log:`, `  - waiting for getByTestId('x')`].join(
        '\n',
      ),
    );
    expect(parsed.timedOut).toBe(true);
    expect(parsed.timeoutMs).toBe(30000);
  });

  it('recovers the locator from a call log when there is no Locator: line', () => {
    const parsed = parsePlaywrightError(
      [
        `Error: locator.click: Timeout 30000ms exceeded.`,
        `Call log:`,
        `  - waiting for getByTestId('search-clear-button')`,
      ].join('\n'),
    );
    expect(parsed.locator).toBe("getByTestId('search-clear-button')");
  });

  it('recovers the locator from a strict mode violation', () => {
    const parsed = parsePlaywrightError(
      `Error: strict mode violation: getByTestId('gyms-list-item') resolved to 12 elements:`,
    );
    expect(parsed.locator).toBe("getByTestId('gyms-list-item')");
  });

  it('handles a negated matcher', () => {
    const parsed = parsePlaywrightError('Error: expect(locator).not.toBeVisible() failed');
    expect(parsed.matcher).toBe('toBeVisible');
  });

  it('returns nulls rather than guesses when nothing is parseable', () => {
    // A fabricated locator here would send healing after the wrong element.
    const parsed = parsePlaywrightError('Error: something entirely unexpected');
    expect(parsed.matcher).toBeNull();
    expect(parsed.locator).toBeNull();
    expect(parsed.expected).toBeNull();
    expect(parsed.actual).toBeNull();
  });
});

describe('splitCallLog', () => {
  it('separates the summary from the call log', () => {
    const { summary, callLog } = splitCallLog(
      ['Error: locator.click: Timeout 30000ms exceeded.', 'Call log:', '  - waiting for x'].join('\n'),
    );
    expect(summary).toBe('Error: locator.click: Timeout 30000ms exceeded.');
    expect(callLog).toContain('waiting for x');
  });

  it('returns a null call log when there is none', () => {
    expect(splitCallLog('Error: plain').callLog).toBeNull();
  });
});

describe('stripCodeFrame', () => {
  // Verbatim from run 33253028409, mobile-nav.ui.acceptance.spec.ts.
  const REAL = [
    'TimeoutError: locator.click: Timeout 10000ms exceeded.',
    'Call log:',
    "  - waiting for getByTestId('navigation-mobile-toggle')",
    '  - attempting click action',
    '',
    '',
    "  13 |       await page.goto('/about');",
    '  14 |',
    '> 15 |       await page.getByTestId(mobileToggle).click();',
    '     |                                            ^',
    '  16 |',
    '    at /__w/bjjeire/bjjeire/tests/layout/mobile-nav.ui.acceptance.spec.ts:15:44',
  ].join('\n');

  it("removes the user's source, which is not evidence about the failure", () => {
    const stripped = stripCodeFrame(REAL);

    // The line that caused a `navigation_failure` verdict for a click timeout.
    expect(stripped).not.toContain('page.goto');
    expect(stripped).not.toContain('mobile-nav.ui.acceptance.spec.ts:15:44');
  });

  it("keeps Playwright's own prose, including the call log", () => {
    const stripped = stripCodeFrame(REAL);

    expect(stripped).toContain('locator.click: Timeout 10000ms exceeded.');
    expect(stripped).toContain("waiting for getByTestId('navigation-mobile-toggle')");
  });

  it('leaves a message with no code frame untouched', () => {
    const plain = 'Error: expect(locator).toBeVisible() failed\nTimeout: 8000ms';

    expect(stripCodeFrame(plain)).toBe(plain);
  });

  // A genuine navigation failure names page.goto in Playwright's own prose,
  // not in a quoted source line. Stripping must not cost us that.
  it('does not touch a goto named in the error itself', () => {
    const real = 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8080/gyms';

    expect(stripCodeFrame(real)).toContain('page.goto');
  });
});
