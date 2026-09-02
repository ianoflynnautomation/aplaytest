/**
 * @aplaytest/llm — the only package that talks to a model.
 *
 * Everything else takes an injected `LlmClient`, which is what keeps a model
 * SDK out of the reporter (running in every test worker) and lets the agent
 * loop be tested against a scripted fake.
 */

export type {
  LlmClient,
  ModelRole,
  Effort,
  Message,
  Usage,
  CompleteRequest,
  CompleteResponse,
  StructuredResponse,
} from './client.js';
export { EMPTY_USAGE } from './client.js';

export { createLlmClient, describeAvailability } from './factory.js';
export type { CreateClientOptions, Provider } from './factory.js';

export { AnthropicLlmClient } from './providers/anthropic.js';
export { UnavailableLlmClient } from './providers/unavailable.js';
export { FakeLlmClient } from './fake.js';
export type { ScriptedTurn } from './fake.js';

export { BudgetGuard, DEFAULT_BUDGET } from './budget.js';
export type { BudgetLimits, BudgetState } from './budget.js';

export {
  MODELS,
  DEFAULT_MODELS,
  DEFAULT_EFFORT,
  specFor,
  costUsd,
  checkCacheable,
  estimateTokens,
} from './pricing.js';
export type { ModelSpec, TokenCounts, CacheWarning } from './pricing.js';

export {
  LlmUnavailableError,
  BudgetExceededError,
  RefusalError,
  StructuredOutputError,
} from './errors.js';
