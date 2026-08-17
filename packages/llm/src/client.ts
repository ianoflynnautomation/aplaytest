/**
 * The model boundary.
 *
 * Exactly one interface, injected everywhere. Engines take an `LlmClient`
 * rather than reaching for a provider, which is what makes the agent loop
 * testable against a scripted fake and what keeps a model SDK out of the
 * packages that run inside a test worker.
 *
 * Note what is NOT here: no `temperature`, no `top_p`, no `top_k`. Those are
 * rejected outright by current Opus and Sonnet models — the familiar
 * "temperature: 0 for determinism" is now a 400, and it never guaranteed
 * identical output anyway. Depth is controlled by `effort`.
 */

import type { z } from 'zod';

export type ModelRole = 'classify' | 'heal' | 'author' | 'vision';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly usd: number;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usd: 0,
};

export interface CompleteRequest {
  readonly role: ModelRole;
  /**
   * Invariant prefix: system prompt, repo conventions, exemplars.
   *
   * Kept separate from `messages` because it is the CACHE PREFIX. It must be
   * byte-identical across every call in a run; anything that varies per
   * request belongs in `messages` instead.
   */
  readonly system: string;
  readonly messages: readonly Message[];
  readonly effort?: Effort | undefined;
  readonly maxTokens?: number | undefined;
}

export interface CompleteResponse {
  readonly text: string;
  readonly usage: Usage;
  readonly model: string;
  /** True when the model declined. Callers must check before using `text`. */
  readonly refused: boolean;
  readonly refusalCategory: string | null;
}

export interface StructuredResponse<T> extends Omit<CompleteResponse, 'text'> {
  readonly value: T;
  readonly raw: string;
  /**
   * Always false on the Anthropic provider: `output_config.format` constrains
   * the response at the API level, so there is no malformed output to repair.
   * The scripted test client still sets it, which is what keeps the old
   * prompt-and-reparse path exercised.
   */
  readonly repaired: boolean;
}

export interface LlmClient {
  readonly available: boolean;
  /** Model id per role, for reporting and cost attribution. */
  modelFor(role: ModelRole): string;
  complete(request: CompleteRequest): Promise<CompleteResponse>;
  /**
   * Decode into a Zod schema. There is exactly one parse path in the system,
   * and it is validated — no regex over prose anywhere.
   */
  completeStructured<T>(
    request: CompleteRequest,
    schema: z.ZodType<T>,
  ): Promise<StructuredResponse<T>>;
}
