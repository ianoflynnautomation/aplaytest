/**
 * A scripted client for tests.
 *
 * Exported from the package, not hidden in a test folder, because the agent
 * runtime in @aplaytest/agent needs it too — and because an agent loop that can
 * only be exercised with a live API key is an agent loop nobody will test.
 */

import type { z } from 'zod';

import {
  EMPTY_USAGE,
  type CompleteRequest,
  type CompleteResponse,
  type LlmClient,
  type ModelRole,
  type StructuredResponse,
  type Usage,
} from './client.js';
import { RefusalError, StructuredOutputError } from './errors.js';
import { DEFAULT_MODELS } from './pricing.js';

export interface ScriptedTurn {
  /** Text the model "returns". Objects are serialised. */
  readonly reply: string | object;
  readonly refused?: boolean;
  readonly refusalCategory?: string;
  readonly usage?: Partial<Usage>;
}

export class FakeLlmClient implements LlmClient {
  readonly available = true;
  /** Every request made, in order — assert against these. */
  readonly requests: CompleteRequest[] = [];
  private turn = 0;

  constructor(private readonly script: readonly ScriptedTurn[]) {}

  modelFor(role: ModelRole): string {
    return DEFAULT_MODELS[role];
  }

  get callCount(): number {
    return this.turn;
  }

  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    this.requests.push(request);
    const scripted = this.script[this.turn];
    this.turn += 1;

    if (scripted === undefined) {
      throw new Error(
        `FakeLlmClient ran out of script at call ${this.turn} — the code under test made ` +
          'more model calls than expected.',
      );
    }

    const text = typeof scripted.reply === 'string' ? scripted.reply : JSON.stringify(scripted.reply);
    return {
      text: scripted.refused === true ? '' : text,
      usage: { ...EMPTY_USAGE, outputTokens: text.length, ...scripted.usage },
      model: this.modelFor(request.role),
      refused: scripted.refused === true,
      refusalCategory: scripted.refusalCategory ?? null,
    };
  }

  async completeStructured<T>(
    request: CompleteRequest,
    schema: z.ZodType<T>,
  ): Promise<StructuredResponse<T>> {
    const first = await this.complete(request);
    if (first.refused) throw new RefusalError(first.refusalCategory);

    const parsed = schema.safeParse(safeJson(first.text));
    if (parsed.success) return { ...first, value: parsed.data, raw: first.text, repaired: false };

    const retry = await this.complete(request);
    if (retry.refused) throw new RefusalError(retry.refusalCategory);

    const second = schema.safeParse(safeJson(retry.text));
    if (!second.success) {
      throw new StructuredOutputError(
        second.error.issues.map(i => i.message).join(', '),
        retry.text,
      );
    }
    return { ...retry, value: second.data, raw: retry.text, repaired: true };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
