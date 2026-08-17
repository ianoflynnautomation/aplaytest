/**
 * Semantic exit codes, so CI can branch without parsing text.
 *
 * `TEST_FAILURES` is deliberately 1 — the same code `playwright test` already
 * returns — so putting atest in front of an existing pipeline changes nothing
 * about how that pipeline reads success.
 */
export const EXIT = {
  OK: 0,
  TEST_FAILURES: 1,
  USAGE: 2,
  LLM_UNAVAILABLE: 3,
  POLICY_VIOLATION: 4,
  INTERNAL: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class UsageError extends Error {
  readonly exitCode: ExitCode = EXIT.USAGE;
}

export class PolicyError extends Error {
  readonly exitCode: ExitCode = EXIT.POLICY_VIOLATION;
}
