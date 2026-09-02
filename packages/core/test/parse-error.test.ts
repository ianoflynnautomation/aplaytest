import { describe, expect, it } from 'vitest';

import { parsePlaywrightError, splitCallLog, stripCodeFrame } from '../src/taxonomy/parse-error.js';

describe('parsePlaywrightError', () => {
  it('given a toHaveText failure with Locator, Expected, Received and Timeout lines -> when parsePlaywrightError runs -> then the matcher, locator, expected, actual and timeoutMs are extracted', { tags: ['@unit', '@taxonomy'] }, () => {
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

  it('given one assertion carrying a Timeout: line and one failing structurally without it -> when parsePlaywrightError runs -> then timedOut is true only for the assertion that waited', { tags: ['@unit', '@taxonomy'] }, () => {
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

  it('given an error message carrying the ANSI colour codes Playwright embeds -> when parsePlaywrightError runs -> then the matcher, locator, expected and actual parse as if uncoloured', { tags: ['@unit', '@taxonomy'] }, () => {
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

  it('given an assertion failure with no Received: line and a trailing Error: line -> when parsePlaywrightError runs -> then actual is the trailing error text', { tags: ['@unit', '@taxonomy'] }, () => {
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

  it('given an assertion failure carrying an explicit Received string: line -> when parsePlaywrightError runs -> then actual is that received value', { tags: ['@unit', '@taxonomy'] }, () => {
    const parsed = parsePlaywrightError(
      [`Error: expect(locator).toHaveText(expected) failed`, `Received string: "BJJ Gyms"`].join('\n'),
    );
    expect(parsed.actual).toBe('"BJJ Gyms"');
  });

  it('given a message reporting Timeout 30000ms exceeded -> when parsePlaywrightError runs -> then timedOut is true and timeoutMs is 30000', { tags: ['@unit', '@taxonomy'] }, () => {
    const parsed = parsePlaywrightError(
      [`Error: locator.click: Timeout 30000ms exceeded.`, `Call log:`, `  - waiting for getByTestId('x')`].join(
        '\n',
      ),
    );
    expect(parsed.timedOut).toBe(true);
    expect(parsed.timeoutMs).toBe(30000);
  });

  it('given a timeout message with a call log and no Locator: line -> when parsePlaywrightError runs -> then the locator is recovered from the call log', { tags: ['@unit', '@taxonomy'] }, () => {
    const parsed = parsePlaywrightError(
      [
        `Error: locator.click: Timeout 30000ms exceeded.`,
        `Call log:`,
        `  - waiting for getByTestId('search-clear-button')`,
      ].join('\n'),
    );
    expect(parsed.locator).toBe("getByTestId('search-clear-button')");
  });

  it('given a strict mode violation message -> when parsePlaywrightError runs -> then the locator is recovered from the violation text', { tags: ['@unit', '@taxonomy'] }, () => {
    const parsed = parsePlaywrightError(
      `Error: strict mode violation: getByTestId('gyms-list-item') resolved to 12 elements:`,
    );
    expect(parsed.locator).toBe("getByTestId('gyms-list-item')");
  });

  it('given a negated expect(locator).not.toBeVisible() failure -> when parsePlaywrightError runs -> then the matcher is toBeVisible', { tags: ['@unit', '@taxonomy'] }, () => {
    const parsed = parsePlaywrightError('Error: expect(locator).not.toBeVisible() failed');
    expect(parsed.matcher).toBe('toBeVisible');
  });

  it('given a message with nothing parseable -> when parsePlaywrightError runs -> then matcher, locator, expected and actual are all null rather than guesses', { tags: ['@unit', '@taxonomy'] }, () => {
    // A fabricated locator here would send healing after the wrong element.
    const parsed = parsePlaywrightError('Error: something entirely unexpected');
    expect(parsed.matcher).toBeNull();
    expect(parsed.locator).toBeNull();
    expect(parsed.expected).toBeNull();
    expect(parsed.actual).toBeNull();
  });
});

describe('splitCallLog', () => {
  it('given a message containing a Call log: section -> when splitCallLog runs -> then the summary and the call log are returned separately', { tags: ['@unit', '@taxonomy'] }, () => {
    const { summary, callLog } = splitCallLog(
      ['Error: locator.click: Timeout 30000ms exceeded.', 'Call log:', '  - waiting for x'].join('\n'),
    );
    expect(summary).toBe('Error: locator.click: Timeout 30000ms exceeded.');
    expect(callLog).toContain('waiting for x');
  });

  it('given a message carrying no call log -> when splitCallLog runs -> then callLog is null', { tags: ['@unit', '@taxonomy'] }, () => {
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

  it('given a timeout message carrying a quoted source code frame -> when stripCodeFrame runs -> then the quoted user source and the file location are removed', { tags: ['@unit', '@taxonomy'] }, () => {
    const stripped = stripCodeFrame(REAL);

    // The line that caused a `navigation_failure` verdict for a click timeout.
    expect(stripped).not.toContain('page.goto');
    expect(stripped).not.toContain('mobile-nav.ui.acceptance.spec.ts:15:44');
  });

  it('given a timeout message carrying a quoted source code frame -> when stripCodeFrame runs -> then the Playwright summary and call log are kept', { tags: ['@unit', '@taxonomy'] }, () => {
    const stripped = stripCodeFrame(REAL);

    expect(stripped).toContain('locator.click: Timeout 10000ms exceeded.');
    expect(stripped).toContain("waiting for getByTestId('navigation-mobile-toggle')");
  });

  it('given a message with no code frame -> when stripCodeFrame runs -> then the message is returned untouched', { tags: ['@unit', '@taxonomy'] }, () => {
    const plain = 'Error: expect(locator).toBeVisible() failed\nTimeout: 8000ms';

    expect(stripCodeFrame(plain)).toBe(plain);
  });

  // A genuine navigation failure names page.goto in Playwright's own prose,
  // not in a quoted source line. Stripping must not cost us that.
  it('given a page.goto failure named in the Playwright error prose -> when stripCodeFrame runs -> then page.goto is kept', { tags: ['@unit', '@taxonomy'] }, () => {
    const real = 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8080/gyms';

    expect(stripCodeFrame(real)).toContain('page.goto');
  });
});
