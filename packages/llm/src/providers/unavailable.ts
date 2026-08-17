/**
 * The no-model client.
 *
 * Every call throws a NAMED error rather than returning empty output. That is
 * the degradation contract: a command either works, works with reduced scope,
 * or exits non-zero saying which. What it must never do is quietly produce a
 * worse answer that looks like a normal one.
 */

import type { z } from 'zod';

import type {
  CompleteRequest,
  CompleteResponse,
  LlmClient,
  ModelRole,
  StructuredResponse,
} from '../client.js';
import { LlmUnavailableError } from '../errors.js';
import { DEFAULT_MODELS } from '../pricing.js';

export class UnavailableLlmClient implements LlmClient {
  readonly available = false;

  constructor(private readonly reason: string) {}

  modelFor(role: ModelRole): string {
    return DEFAULT_MODELS[role];
  }

  async complete(_request: CompleteRequest): Promise<CompleteResponse> {
    throw new LlmUnavailableError(this.reason);
  }

  async completeStructured<T>(
    _request: CompleteRequest,
    _schema: z.ZodType<T>,
  ): Promise<StructuredResponse<T>> {
    throw new LlmUnavailableError(this.reason);
  }
}
