/**
 * Model selection, pricing, and the cache-prefix rules.
 *
 * Cost is computed from real per-token rates rather than estimated, so the
 * CLI can always disclose what a run actually spent. A user must never have
 * to wonder whether a number came from a model or a measurement.
 */

import type { Effort, ModelRole } from './client.js';

export interface ModelSpec {
  readonly id: string;
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /**
   * Minimum cacheable prefix, in tokens.
   *
   * NOT monotonic across generations, which is the trap: 512 on Opus 5 but
   * 4096 on Haiku 4.5. A conventions block that caches fine on the heal path
   * can silently fail to cache on the classify path, with no error — just
   * `cache_creation_input_tokens: 0` forever.
   */
  readonly minCacheablePrefix: number;
  readonly contextWindow: number;
}

export const MODELS: Readonly<Record<string, ModelSpec>> = {
  'claude-opus-5': {
    id: 'claude-opus-5',
    inputPerMTok: 5,
    outputPerMTok: 25,
    minCacheablePrefix: 512,
    contextWindow: 1_000_000,
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    inputPerMTok: 3,
    outputPerMTok: 15,
    minCacheablePrefix: 1024,
    contextWindow: 1_000_000,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    inputPerMTok: 1,
    outputPerMTok: 5,
    minCacheablePrefix: 4096,
    contextWindow: 200_000,
  },
};

/**
 * Role → model. Split by JOB SHAPE, not by a vague quality axis.
 *
 *   classify — taxonomy tie-breaks and phrasing. High volume, low stakes, and
 *              the deterministic tier has already done the real work.
 *   heal     — ranking pre-verified candidates by intent. A judgement call
 *              between a handful of options, not a research task.
 *   author   — planning, browser exploration, code synthesis.
 */
export const DEFAULT_MODELS: Readonly<Record<ModelRole, string>> = {
  classify: 'claude-haiku-4-5',
  heal: 'claude-sonnet-5',
  author: 'claude-opus-5',
  vision: 'claude-sonnet-5',
};

export const DEFAULT_EFFORT: Readonly<Record<ModelRole, Effort>> = {
  classify: 'low',
  heal: 'medium',
  // The documented setting for coding and agentic work.
  author: 'xhigh',
  vision: 'medium',
};

export function specFor(modelId: string): ModelSpec | null {
  return MODELS[modelId] ?? null;
}

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * Cache reads cost ~0.1× base input; writes cost 1.25× (5-minute TTL).
 * Two requests break even, so an analyze pass over several failures is well
 * past the threshold on its second call.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function costUsd(modelId: string, counts: TokenCounts): number {
  const spec = specFor(modelId);
  if (spec === null) return 0;

  const perInputToken = spec.inputPerMTok / 1_000_000;
  const perOutputToken = spec.outputPerMTok / 1_000_000;

  return (
    counts.inputTokens * perInputToken +
    counts.outputTokens * perOutputToken +
    counts.cacheReadTokens * perInputToken * CACHE_READ_MULTIPLIER +
    counts.cacheWriteTokens * perInputToken * CACHE_WRITE_MULTIPLIER
  );
}

export interface CacheWarning {
  readonly model: string;
  readonly prefixTokens: number;
  readonly minimum: number;
  readonly message: string;
}

/** Rough token estimate. Only used to warn, never to bill. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Warn when a prefix is too short to cache on this model.
 *
 * Silent is the problem: below the minimum the API simply does not cache and
 * reports nothing, so the first sign is a bill.
 */
export function checkCacheable(modelId: string, systemPrompt: string): CacheWarning | null {
  const spec = specFor(modelId);
  if (spec === null) return null;

  const prefixTokens = estimateTokens(systemPrompt);
  if (prefixTokens >= spec.minCacheablePrefix) return null;

  return {
    model: modelId,
    prefixTokens,
    minimum: spec.minCacheablePrefix,
    message:
      `Cache prefix is ~${prefixTokens} tokens, below the ${spec.minCacheablePrefix}-token ` +
      `minimum for ${modelId}. cache_control will be silently ignored — no error, just no ` +
      'caching. Note the minimum is not monotonic across models.',
  };
}
