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

export interface ParsedError {
  /** e.g. "toBeVisible", "toHaveText". Null when the failure is not an assertion. */
  readonly matcher: string | null;
  readonly expected: string | null;
  readonly actual: string | null;
  /** The locator expression, verbatim: "getByTestId('gym-card-name')". */
  readonly locator: string | null;
  readonly timedOut: boolean;
  /** Configured timeout in ms, when the message states one. */
  readonly timeoutMs: number | null;
}

const MATCHER_PATTERNS: readonly RegExp[] = [
  // expect(locator).toBeVisible() failed
  /expect\((?:locator|page|received|apiResponse)\)\.(?:not\.)?(\w+)\(/,
  // Timed out 5000ms waiting for expect(locator).toHaveText(expected)
  /waiting for expect\([^)]*\)\.(?:not\.)?(\w+)\(/,
];

const LOCATOR_PATTERNS: readonly RegExp[] = [
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

const TIMEOUT_PATTERNS: readonly RegExp[] = [
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

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

function firstCapture(text: string, patterns: readonly RegExp[]): string | null {
  for (const re of patterns) {
    const captured = re.exec(text)?.[1];
    if (captured !== undefined && captured.trim() !== '') return captured.trim();
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
function reasonLine(message: string): string | null {
  const errorLines = message
    .split('\n')
    .map(line => /^\s*Error:\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined && value !== '');

  return errorLines.slice(1).find(line => !line.includes('expect(')) ?? null;
}

export function parsePlaywrightError(rawMessage: string, rawStack = ''): ParsedError {
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
export function splitCallLog(message: string): { readonly summary: string; readonly callLog: string | null } {
  const index = message.indexOf('Call log:');
  if (index === -1) return { summary: message.trim(), callLog: null };
  return {
    summary: message.slice(0, index).trim(),
    callLog: message.slice(index).trim(),
  };
}
