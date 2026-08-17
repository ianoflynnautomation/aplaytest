/**
 * Budget accounting.
 *
 * A pool shared across a whole invocation, not a per-call limit. Analysing
 * forty failures must not cost forty times the per-failure cap, and a runaway
 * agent loop is a real failure mode — the guard aborts with a typed error
 * rather than discovering the problem on an invoice.
 */

import { BudgetExceededError } from './errors.js';
import type { Usage } from './client.js';

export interface BudgetLimits {
  readonly perCallUsd: number;
  readonly totalUsd: number;
  readonly maxCalls: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  perCallUsd: 0.05,
  totalUsd: 2.0,
  maxCalls: 200,
};

export interface BudgetState {
  readonly spentUsd: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

export class BudgetGuard {
  private spentUsd = 0;
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;

  constructor(
    private readonly limits: BudgetLimits = DEFAULT_BUDGET,
    private readonly scope = 'this run',
  ) {}

  /** Throws BEFORE a call is made, so the budget is never merely observed. */
  assertCanSpend(): void {
    if (this.spentUsd >= this.limits.totalUsd) {
      throw new BudgetExceededError(this.spentUsd, this.limits.totalUsd, this.scope);
    }
    if (this.calls >= this.limits.maxCalls) {
      throw new BudgetExceededError(
        this.spentUsd,
        this.limits.totalUsd,
        `${this.scope} (${this.calls} calls, limit ${this.limits.maxCalls})`,
      );
    }
  }

  record(usage: Usage): void {
    this.spentUsd += usage.usd;
    this.calls += 1;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cacheReadTokens += usage.cacheReadTokens;
  }

  /** Would one more call of roughly this size fit? */
  canAfford(estimatedUsd: number): boolean {
    return this.spentUsd + estimatedUsd <= this.limits.totalUsd && this.calls < this.limits.maxCalls;
  }

  state(): BudgetState {
    return {
      spentUsd: this.spentUsd,
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
    };
  }

  /**
   * A one-line disclosure of model usage.
   *
   * Always shown alongside model-derived output: a user must never have to
   * wonder whether a number came from a measurement or a model.
   */
  summary(): string {
    if (this.calls === 0) return 'no model calls';
    const cacheNote =
      this.cacheReadTokens > 0 ? `, ${this.cacheReadTokens} cached` : ', no cache hits';
    return (
      `${this.calls} model call${this.calls === 1 ? '' : 's'} · ` +
      `${this.inputTokens} in / ${this.outputTokens} out${cacheNote} · ` +
      `$${this.spentUsd.toFixed(4)}`
    );
  }
}
