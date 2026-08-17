/**
 * Typed failures.
 *
 * Every one of these is a NAMED reason a caller can branch on. The degradation
 * contract is that no command silently changes behaviour when the model is
 * missing — it either works, works with reduced scope, or exits non-zero
 * saying which of these happened.
 */

export class LlmUnavailableError extends Error {
  readonly code = 'llm_unavailable';
  constructor(reason: string) {
    super(
      `No model available: ${reason}. Deterministic features are unaffected; ` +
        'set ANTHROPIC_API_KEY to enable the model tier.',
    );
    this.name = 'LlmUnavailableError';
  }
}

export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded';
  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number,
    readonly scope: string,
  ) {
    super(
      `Budget exhausted for ${scope}: $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(2)}. ` +
        'Raise --budget or reduce the work.',
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * The model declined. A normal HTTP 200 carrying `stop_reason: "refusal"`,
 * not an error status — code that reads `content[0]` without checking will
 * break on it.
 */
export class RefusalError extends Error {
  readonly code = 'refusal';
  constructor(readonly category: string | null) {
    super(`The model declined this request${category === null ? '' : ` (${category})`}.`);
    this.name = 'RefusalError';
  }
}

export class StructuredOutputError extends Error {
  readonly code = 'invalid_output';
  constructor(
    readonly issues: string,
    readonly raw: string,
  ) {
    super(`Model output did not match the schema after one repair attempt:\n${issues}`);
    this.name = 'StructuredOutputError';
  }
}
