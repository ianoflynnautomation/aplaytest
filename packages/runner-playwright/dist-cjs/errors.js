"use strict";
/**
 * Parse Playwright's error prose into structured signals.
 *
 * Playwright reports failures as formatted human text, not structured data —
 * `TestError` carries `message` and `stack`, but not the matcher name, the
 * locator, or the expected/received pair. Everything downstream (the
 * classifier, candidate generation, the heal ledger) needs those as fields, so
 * exactly one module does the string work and is tested against real output.
 *
 * When a field cannot be found the answer is `null`, never a guess. A wrong
 * locator here would send the healing engine after the wrong element.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripAnsi = stripAnsi;
exports.parsePlaywrightError = parsePlaywrightError;
exports.splitCallLog = splitCallLog;
const MATCHER_PATTERNS = [
    // expect(locator).toBeVisible() failed
    /expect\((?:locator|page|received|apiResponse)\)\.(?:not\.)?(\w+)\(/,
    // Timed out 5000ms waiting for expect(locator).toHaveText(expected)
    /waiting for expect\([^)]*\)\.(?:not\.)?(\w+)\(/,
];
const LOCATOR_PATTERNS = [
    // "Locator: getByTestId('gym-card-name')"
    /^\s*Locator:\s*(.+?)\s*$/m,
    // "  - waiting for getByTestId('search-clear-button')"
    /waiting for (getBy\w+\([^\n]*?\)|locator\([^\n]*?\)|frameLocator\([^\n]*?\))/,
    // "strict mode violation: getByTestId('gyms-list-item') resolved to 12 elements"
    /strict mode violation:\s*(.+?)\s+resolved to/,
    // "locator.click: ..." with a call-log resolution line
    /locator resolved to\s+(<[^\n]+>)/,
];
const EXPECTED_PATTERN = /^\s*Expected(?:\s+(?:string|pattern|value|array|object))?:\s*(.+?)\s*$/m;
const RECEIVED_PATTERN = /^\s*Received(?:\s+(?:string|value|array|object))?:\s*(.+?)\s*$/m;
const TIMEOUT_PATTERNS = [
    /Timeout:\s*(\d+)ms/,
    /Timeout\s+(\d+)ms exceeded/,
    /Test timeout of\s+(\d+)ms exceeded/,
    /Timed out\s+(\d+)ms waiting/,
];
/**
 * Playwright colourises `error.message` with ANSI escapes, even when stdout is
 * not a TTY. Left in place they defeat every pattern here (the matcher name is
 * split by escapes mid-word) and they are pure waste in a token budget when a
 * bundle reaches a model. Strip once, at the boundary.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;
function stripAnsi(input) {
    return input.replace(ANSI_PATTERN, '');
}
function firstCapture(text, patterns) {
    for (const re of patterns) {
        const captured = re.exec(text)?.[1];
        if (captured !== undefined && captured.trim() !== '')
            return captured.trim();
    }
    return null;
}
/**
 * Modern Playwright reports the received side as a trailing `Error: <reason>`
 * line rather than `Received: …`:
 *
 *   Error: expect(locator).toBeVisible() failed
 *   Locator: getByTestId('gym-card-name')
 *   Expected: visible
 *   Timeout: 1000ms
 *   Error: element(s) not found        ← this is the "received"
 *
 * The FIRST `Error:` line is always the header, whatever it says — so the
 * reason is a subsequent one. A message with a single `Error:` line has no
 * separate received value and must return null rather than echoing its own
 * header back as if it were the observed result.
 */
function reasonLine(message) {
    const errorLines = message
        .split('\n')
        .map(line => /^\s*Error:\s*(.+?)\s*$/.exec(line)?.[1])
        .filter((value) => value !== undefined && value !== '');
    return errorLines.slice(1).find(line => !line.includes('expect(')) ?? null;
}
function parsePlaywrightError(rawMessage, rawStack = '') {
    const message = stripAnsi(rawMessage);
    const stack = stripAnsi(rawStack);
    const text = `${message}\n${stack}`;
    const timeoutRaw = firstCapture(text, TIMEOUT_PATTERNS);
    const timeoutMs = timeoutRaw === null ? null : Number.parseInt(timeoutRaw, 10);
    // A `Timeout: Nms` line is an OUTCOME, not configuration: Playwright emits
    // it only when the assertion actually consumed its budget. A failure that
    // resolves immediately — a strict-mode violation, say — carries no such
    // line. Verified against real 1.62 output.
    const exhaustedBudget = /^\s*Timeout:\s*\d+ms\s*$/m.test(message);
    return {
        matcher: firstCapture(message, MATCHER_PATTERNS),
        expected: firstCapture(message, [EXPECTED_PATTERN]),
        actual: firstCapture(message, [RECEIVED_PATTERN]) ?? reasonLine(message),
        locator: firstCapture(text, LOCATOR_PATTERNS),
        timedOut: exhaustedBudget || /exceeded|Timed out/i.test(text),
        timeoutMs: Number.isNaN(timeoutMs) ? null : timeoutMs,
    };
}
/**
 * Playwright prints a trailing "Call log:" block that is invaluable for a
 * human and pure noise for a token budget. Split it so the caller decides.
 */
function splitCallLog(message) {
    const index = message.indexOf('Call log:');
    if (index === -1)
        return { summary: message.trim(), callLog: null };
    return {
        summary: message.slice(0, index).trim(),
        callLog: message.slice(index).trim(),
    };
}
//# sourceMappingURL=errors.js.map