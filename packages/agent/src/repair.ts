/**
 * The repair agent — Tier 1 of healing.
 *
 * It does exactly one thing: given candidates that Tier 0 already produced and
 * verified, pick the one that matches the test's INTENT. It is handed options;
 * it never invents a selector. That single constraint removes the entire class
 * of "the AI suggested a locator that does not exist".
 *
 * The most valuable answer it can give is `isRealBug: true` — "do not heal
 * this, the application is broken". Making that a normal, first-class output
 * rather than an exception path is what stops the agent rationalising a patch
 * for a failure that deserves a bug report.
 *
 * Whatever it returns, Tier 0's validation still decides: the choice is
 * re-run against Playwright before anything is proposed.
 */

import { z } from 'zod';
import type { LlmClient } from '@atest/llm';
import { BudgetGuard, RefusalError } from '@atest/llm';

export const RepairChoiceSchema = z.object({
  diagnosis: z.enum([
    'selector_renamed',
    'selector_moved',
    'element_removed',
    'ambiguous_match',
    'timing_not_selector',
    'app_regression',
    'unknown',
  ]),
  chosen: z
    .string()
    .nullable()
    .describe('Exactly one of the offered candidate values, or null to decline.'),
  // See the note on AuthorPlanSchema: `.max()` is stripped from the wire schema
  // and checked client-side, so the length the model should aim for goes in the
  // description and the max is only a backstop.
  reasoning: z.string().max(4000).describe('Why this candidate matches the intent. Two or three sentences.'),
  confidence: z.number().min(0).max(1).describe('0 to 1.'),
  /**
   * True when the failure is an application defect rather than drift.
   * The engine discards the choice and reports a bug instead.
   */
  isRealBug: z.boolean(),
});

export type RepairChoice = z.infer<typeof RepairChoiceSchema>;

export interface RepairCandidate {
  readonly value: string;
  readonly expression: string;
  readonly semanticDistance: number;
}

export interface RepairInput {
  readonly testTitle: string;
  /** The page-object call and its domain arguments, e.g. expectCardData({name}). */
  readonly intent: string | null;
  readonly missingTestId: string;
  readonly failureKind: string;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly ariaSnapshot: string;
  readonly candidates: readonly RepairCandidate[];
}

export type RepairOutcome =
  | { readonly status: 'chose'; readonly choice: RepairChoice; readonly usd: number }
  | { readonly status: 'declined'; readonly choice: RepairChoice; readonly usd: number }
  | { readonly status: 'real-bug'; readonly choice: RepairChoice; readonly usd: number }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'invalid'; readonly reason: string; readonly usd: number };

/**
 * The invariant prefix — identical on every call in a run, so it is the cache
 * prefix. Anything varying per failure goes in the user message instead.
 */
export const REPAIR_SYSTEM_PROMPT = `You rank pre-verified locator candidates for a broken Playwright test.

A deterministic engine has already established the facts:
- which test id the selector referenced
- that this id is ABSENT from the page
- which test ids ARE present, ranked by string distance

Your only job is to choose which candidate matches what the test was trying to
do. You are choosing among the options given. Do not invent a selector; do not
suggest one that is not in the list.

Prefer the candidate whose meaning matches the test's intent over the one whose
name looks closest. If the failing call was expecting a gym's NAME, an id that
holds a county or an address is the wrong answer however similar it reads.

Answer with "chosen": null when no candidate genuinely matches. A refusal is a
correct and useful answer; a confident wrong choice costs a reviewer their
attention, which is the scarcest thing in this system.

Set "isRealBug": true when the evidence points at the application being broken
rather than a renamed test id — an element that is genuinely gone, an error
state rendered where content should be. Healing must not paper over a real
defect.

The response shape is enforced by the API's structured-output schema, so this
prompt does not restate it. A hand-written shape here would be a second source
of truth that drifts from RepairChoiceSchema the first time a field changes.`;

function buildUserMessage(input: RepairInput, ariaBudget: number): string {
  const aria =
    input.ariaSnapshot.length > ariaBudget
      ? `${input.ariaSnapshot.slice(0, ariaBudget)}\n… (truncated)`
      : input.ariaSnapshot;

  return [
    `TEST: ${input.testTitle}`,
    input.intent === null ? '' : `INTENT: ${input.intent}`,
    `FAILURE: ${input.failureKind}`,
    input.expected === null ? '' : `EXPECTED: ${input.expected}`,
    input.actual === null ? '' : `RECEIVED: ${input.actual}`,
    '',
    `MISSING TEST ID: ${input.missingTestId}`,
    '',
    'CANDIDATES (all verified present on the page):',
    ...input.candidates.map(
      c => `  - ${c.value}  (string distance ${c.semanticDistance.toFixed(2)})`,
    ),
    '',
    'PAGE (accessibility tree):',
    aria === '' ? '  (not captured)' : aria,
  ]
    .filter(l => l !== '')
    .join('\n');
}

export interface RepairOptions {
  /** ARIA is the cheap, semantic page representation; cap it anyway. */
  readonly ariaCharBudget?: number | undefined;
  readonly budget?: BudgetGuard | undefined;
}

export async function runRepairAgent(
  client: LlmClient,
  input: RepairInput,
  options: RepairOptions = {},
): Promise<RepairOutcome> {
  if (!client.available) {
    return {
      status: 'unavailable',
      reason: 'no model configured — Tier 0 ranking stands',
    };
  }

  if (input.candidates.length === 0) {
    return { status: 'unavailable', reason: 'no candidates to rank' };
  }

  const budget = options.budget ?? new BudgetGuard();

  try {
    budget.assertCanSpend();

    const response = await client.completeStructured(
      {
        role: 'heal',
        system: REPAIR_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(input, options.ariaCharBudget ?? 24_000) }],
      },
      RepairChoiceSchema,
    );

    budget.record(response.usage);
    const choice = response.value;

    if (choice.isRealBug) {
      return { status: 'real-bug', choice, usd: response.usage.usd };
    }

    if (choice.chosen === null) {
      return { status: 'declined', choice, usd: response.usage.usd };
    }

    // A choice outside the offered set is rejected rather than trusted. The
    // whole safety property of Tier 1 is that it may only pick from options
    // Tier 0 verified against the live page.
    const offered = new Set(input.candidates.map(c => c.value));
    if (!offered.has(choice.chosen)) {
      return {
        status: 'invalid',
        reason:
          `The model chose "${choice.chosen}", which was not among the candidates. ` +
          'Falling back to the Tier-0 ranking.',
        usd: response.usage.usd,
      };
    }

    return { status: 'chose', choice, usd: response.usage.usd };
  } catch (error) {
    if (error instanceof RefusalError) {
      return { status: 'unavailable', reason: `the model declined (${error.category ?? 'no category'})` };
    }
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
