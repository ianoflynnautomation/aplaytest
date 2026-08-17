/**
 * Client construction.
 *
 * Resolving to an UnavailableLlmClient rather than throwing at startup is the
 * point: every deterministic feature keeps working, and only the code paths
 * that genuinely need a model fail — with a reason that names itself.
 */

import type { LlmClient, ModelRole } from './client.js';
import { AnthropicLlmClient, type AnthropicClientOptions } from './providers/anthropic.js';
import { UnavailableLlmClient } from './providers/unavailable.js';

export type Provider = 'anthropic' | 'none';

export interface CreateClientOptions extends AnthropicClientOptions {
  readonly provider?: Provider | undefined;
  /** Force the unavailable client — what `--no-llm` sets. */
  readonly disabled?: boolean | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export function createLlmClient(options: CreateClientOptions = {}): LlmClient {
  if (options.disabled === true) {
    return new UnavailableLlmClient('disabled by --no-llm');
  }
  if (options.provider === 'none') {
    return new UnavailableLlmClient('provider is set to "none"');
  }

  const env = options.env ?? process.env;
  const apiKey = options.apiKey ?? env['ANTHROPIC_API_KEY'];

  if (apiKey === undefined || apiKey === '') {
    return new UnavailableLlmClient('ANTHROPIC_API_KEY is not set');
  }

  return new AnthropicLlmClient({ ...options, apiKey });
}

export function describeAvailability(client: LlmClient, roles: readonly ModelRole[]): string {
  if (!client.available) return 'no model — deterministic tier only';
  return roles.map(role => `${role}: ${client.modelFor(role)}`).join(' · ');
}
