/**
 * The Anthropic provider.
 *
 * Three things here are deliberate and easy to get wrong:
 *
 *   1. NO sampling parameters. `temperature`, `top_p` and `top_k` are rejected
 *      with a 400 on current Opus and Sonnet models. Depth is `effort`.
 *   2. The system prompt is a cacheable block, ordered first. It is the only
 *      part guaranteed byte-identical across a run, so it is the cache prefix.
 *   3. `stop_reason: "refusal"` arrives as a normal HTTP 200. Reading
 *      `content[0]` without checking it will break.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

import {
  EMPTY_USAGE,
  type CompleteRequest,
  type CompleteResponse,
  type LlmClient,
  type ModelRole,
  type StructuredResponse,
  type Usage,
} from '../client.js';
import { RefusalError, StructuredOutputError } from '../errors.js';
import { DEFAULT_EFFORT, DEFAULT_MODELS, costUsd } from '../pricing.js';

export interface AnthropicClientOptions {
  readonly apiKey?: string | undefined;
  readonly models?: Partial<Record<ModelRole, string>> | undefined;
  readonly maxTokens?: number | undefined;
  /** Emitted for each call so the CLI can disclose model usage inline. */
  onUsage?: ((usage: Usage, model: string) => void) | undefined;
}

const DEFAULT_MAX_TOKENS = 16_000;

interface RawResponse {
  content: { type: string; text?: string }[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function extractText(response: RawResponse): string {
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('');
}


export class AnthropicLlmClient implements LlmClient {
  readonly available = true;
  private readonly anthropic: Anthropic;
  private readonly models: Record<ModelRole, string>;

  constructor(private readonly options: AnthropicClientOptions = {}) {
    this.anthropic =
      options.apiKey === undefined ? new Anthropic() : new Anthropic({ apiKey: options.apiKey });
    this.models = { ...DEFAULT_MODELS, ...options.models };
  }

  modelFor(role: ModelRole): string {
    return this.models[role];
  }

  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    const model = this.modelFor(request.role);

    const response = (await this.anthropic.messages.create({
      model,
      max_tokens: request.maxTokens ?? this.options.maxTokens ?? DEFAULT_MAX_TOKENS,
      // The cache prefix: marked cacheable, and rendered before `messages`.
      system: [
        {
          type: 'text',
          text: request.system,
          
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      // Depth, not sampling. `temperature` here would be a 400.
      output_config: { effort: request.effort ?? DEFAULT_EFFORT[request.role] },
      thinking: { type: 'adaptive' },
    } as never)) as unknown as RawResponse;

    const usage = this.toUsage(response, model);
    this.options.onUsage?.(usage, model);

    const refused = response.stop_reason === 'refusal';
    return {
      // Empty on refusal rather than whatever partial text exists: callers
      // that ignore `refused` should get nothing, not something plausible.
      text: refused ? '' : extractText(response),
      usage,
      model: response.model ?? model,
      refused,
      refusalCategory: response.stop_details?.category ?? null,
    };
  }

  /**
   * Structured output via the API's own schema constraint, not prompting.
   *
   * The earlier implementation asked for JSON in prose and re-parsed the text,
   * with one repair round when that failed. Measured against the live model,
   * that is not a robustness question — it is a correctness one. The author
   * agent's prompt asked for a test plan and never mentioned JSON, so the model
   * returned an excellent Markdown plan; every field parsed as `undefined`, the
   * repair round produced more prose, and the run failed after 100 seconds and
   * $0.19. The repair agent only worked because its prompt happened to carry
   * "Reply with JSON only, matching this shape:".
   *
   * `output_config.format` constrains the response at the API level, so the
   * schema is enforced rather than requested and the repair round has nothing
   * left to do.
   */
  async completeStructured<T>(
    request: CompleteRequest,
    schema: z.ZodType<T>,
  ): Promise<StructuredResponse<T>> {
    const model = this.modelFor(request.role);

    const response = (await this.anthropic.messages.parse({
      model,
      max_tokens: request.maxTokens ?? this.options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: request.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      output_config: {
        effort: request.effort ?? DEFAULT_EFFORT[request.role],
        format: zodOutputFormat(schema),
      },
      thinking: { type: 'adaptive' },
    } as never)) as unknown as RawResponse & { parsed_output: T | null };

    const usage = this.toUsage(response, model);
    this.options.onUsage?.(usage, model);

    if (response.stop_reason === 'refusal') {
      throw new RefusalError(response.stop_details?.category ?? null);
    }

    const text = extractText(response);

    if (response.parsed_output === null || response.parsed_output === undefined) {
      // Reached when the response is schema-shaped but fails a constraint the
      // API does not enforce (string lengths, array bounds — the SDK strips
      // those from the wire schema and checks them client-side), or when the
      // turn was truncated. Nothing a retry would fix, so it fails loudly.
      throw new StructuredOutputError(
        response.stop_reason === 'max_tokens'
          ? 'response hit max_tokens before the schema was satisfied'
          : 'response did not satisfy the schema',
        text,
      );
    }

    return {
      usage,
      model: response.model ?? model,
      refused: false,
      refusalCategory: null,
      value: response.parsed_output,
      raw: text,
      repaired: false,
    };
  }

  private toUsage(response: RawResponse, model: string): Usage {
    const counts = {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
    };
    return { ...counts, usd: costUsd(model, counts) };
  }
}


export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    usd: a.usd + b.usd,
  };
}

export { EMPTY_USAGE };
