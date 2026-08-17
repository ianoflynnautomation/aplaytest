import { describe, expect, it } from 'vitest';

import { parsePlaywrightError, splitCallLog } from '../src/errors.js';

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
