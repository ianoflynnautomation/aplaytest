/**
 * The MCP safety layer.
 *
 * This server runs with the user's filesystem permissions and is driven by a
 * model. Three independent gates, because "the agent applied a patch I never
 * saw" is the failure people rightly fear:
 *
 *   1. READ-ONLY BY DEFAULT. Mutating tools need `ATEST_MCP_WRITE=1`. A fresh
 *      install can inspect everything and change nothing.
 *   2. EXPLICIT CONFIRMATION. Every mutating call must also pass
 *      `confirm: true`, so a model cannot mutate by accident while exploring.
 *   3. RESPONSE HYGIENE. Size caps and redaction, because evidence bundles
 *      from an authenticated suite WILL contain bearer tokens and those must
 *      never reach a model.
 */

import { redact } from '@atest/core';

export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'atest_apply_heal',
  'atest_quarantine',
  // The gate restores the spec it mutates, so it leaves no net change — but it
  // DOES rewrite a tracked file for the duration of several Playwright runs.
  // A process killed mid-gate leaves a mutated spec and a .atest-gate-backup
  // beside it, which is a working-tree change whatever the intent was.
  'atest_gate_test',
]);

export interface SafetyConfig {
  readonly writeEnabled: boolean;
  /** Cap per response. Over-cap content is truncated with an explicit marker. */
  readonly maxResponseChars: number;
  readonly redactKeys: readonly string[];
}

export const DEFAULT_SAFETY: SafetyConfig = {
  writeEnabled: false,
  maxResponseChars: 120_000,
  redactKeys: ['password', 'token', 'authorization', 'cookie', 'secret', 'api-key'],
};

export function safetyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): SafetyConfig {
  return { ...DEFAULT_SAFETY, writeEnabled: env['ATEST_MCP_WRITE'] === '1' };
}

export interface GateResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly message?: string;
}

export function gate(toolName: string, input: unknown, config: SafetyConfig): GateResult {
  if (!WRITE_TOOLS.has(toolName)) return { ok: true };

  if (!config.writeEnabled) {
    return {
      ok: false,
      error: 'write_disabled',
      message:
        `${toolName} modifies the working tree. Set ATEST_MCP_WRITE=1 to enable mutating ` +
        'tools; this server is read-only by default.',
    };
  }

  if ((input as { confirm?: unknown } | null)?.confirm !== true) {
    return {
      ok: false,
      error: 'confirmation_required',
      message:
        `${toolName} requires confirm: true. Show the diff to the user and get their ` +
        'agreement before calling again.',
    };
  }

  return { ok: true };
}

export interface SanitisedPayload {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Redact, serialise, and cap.
 *
 * Truncation is always MARKED. A silently shortened ARIA snapshot would lead a
 * model to conclude an element is absent when it was merely cut off — which is
 * exactly the wrong answer for a healing tool.
 */
export function sanitise(value: unknown, config: SafetyConfig): SanitisedPayload {
  const text = JSON.stringify(redact(value, config.redactKeys), null, 2);

  if (text.length <= config.maxResponseChars) return { text, truncated: false };

  return {
    text:
      `${text.slice(0, config.maxResponseChars)}\n\n… TRUNCATED: response exceeded ` +
      `${config.maxResponseChars} characters. Narrow the query, or read the full record from ` +
      'the resource URI.',
    truncated: true,
  };
}
