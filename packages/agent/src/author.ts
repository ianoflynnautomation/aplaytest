/**
 * The author agent — plan, then synthesize.
 *
 * It writes a test; it never decides whether that test is any good. That
 * judgement belongs to the falsifiability gate in @atest/author, which runs
 * the candidate against a real app with the data broken underneath it. The
 * split matters: a model asked "is this test meaningful?" will say yes about
 * its own output, and it will be wrong in exactly the cases that matter.
 *
 * Two model calls, deliberately separated:
 *
 *   PLAN       domain-language steps a human can review BEFORE any code
 *              exists. Reviewing prose is cheap; reviewing a plausible-
 *              looking spec is not, because plausible code reads as correct.
 *   SYNTHESIZE code, constrained to the page-object API it was given.
 *
 * The synthesis step is handed exemplar specs rather than a style guide, for
 * the same reason the repair agent is handed candidates rather than a page:
 * concrete beats descriptive. It also cannot invent a page-object method —
 * the schema constrains it to the signatures retrieved in phase 1, and
 * anything else is rejected before it reaches disk.
 */

import { z } from 'zod';
import type { LlmClient } from '@atest/llm';
import { BudgetGuard, RefusalError } from '@atest/llm';

/**
 * LENGTH LIVES IN `.describe()`, NOT IN `.max()`.
 *
 * `.max()` is a constraint the API does not enforce: the SDK strips string
 * lengths and array bounds out of the wire schema and checks them client-side
 * afterwards. So a tight max is invisible to the model and fatal to the run —
 * measured here, an 800-character cap on `notes` threw away a completed
 * generation because the model wrote 900 characters it was never told to avoid.
 *
 * Descriptions ARE sent. Say the intended length there, where it can be
 * obeyed, and leave `.max()` as a backstop generous enough that tripping it
 * means something genuinely pathological happened.
 */
export const AuthorPlanSchema = z.object({
  title: z
    .string()
    .min(10)
    .max(400)
    .describe('Given <context>, when <action>, then <business outcome>. Around 100 characters.'),
  steps: z
    .array(z.string().max(600).describe('One business action or observable outcome, one sentence.'))
    .min(1)
    .max(12)
    .describe('Domain-language steps a non-engineer can review. No selectors, no DTO field names.'),
  fixtures: z
    .array(z.string())
    .max(10)
    .describe('Names of seeded fixtures this test relies on, taken from the provided data.'),
  /**
   * Which mutant the author expects to kill this test.
   *
   * A commitment made BEFORE the code exists, and the most useful line in the
   * whole plan: an agent that cannot name a way its test could fail has not
   * designed a test, and the gate will say so a few minutes later.
   */
  expectedToDieFrom: z.enum(['empty-page', 'unfiltered', 'http-500', 'none']),
  rationale: z
    .string()
    .max(2000)
    .describe('Why this is worth testing. Two or three sentences.'),
});

export type AuthorPlan = z.infer<typeof AuthorPlanSchema>;

export const AuthorDraftSchema = z.object({
  spec: z.string().min(40).describe('The complete spec file contents, ready to write to disk.'),
  methodsUsed: z
    .array(z.string())
    .max(30)
    .describe('Page-object methods this spec calls. Checked against the API you were given.'),
  needsNewPageObjectMethod: z
    .boolean()
    .describe('True when the task cannot be done with the page-object methods provided.'),
  notes: z
    .string()
    .max(4000)
    .describe('Anything the reviewer should know. Keep it to a few sentences.'),
});

export type AuthorDraft = z.infer<typeof AuthorDraftSchema>;

export interface AuthorGrounding {
  readonly feature: string;
  readonly conventions: string | null;
  readonly pageObjectApi: readonly string[];
  readonly pageObjectPath: string | null;
  readonly seededData: string | null;
  readonly exemplars: readonly { path: string; source: string; reason: string }[];
}

export interface AuthorInput {
  readonly goal: string;
  readonly grounding: AuthorGrounding;
}

export type AuthorOutcome =
  | { readonly status: 'planned'; readonly plan: AuthorPlan; readonly costUsd: number }
  | {
      readonly status: 'drafted';
      readonly plan: AuthorPlan;
      readonly draft: AuthorDraft;
      readonly costUsd: number;
    }
  | { readonly status: 'declined'; readonly reason: string; readonly costUsd: number }
  // Not `costUsd: 0`. Synthesis can fail after planning already succeeded and
  // was paid for, and reporting that spend as zero would understate the cost
  // of exactly the runs that produced nothing.
  | { readonly status: 'unavailable'; readonly reason: string; readonly costUsd: number };

export const PLAN_SYSTEM_PROMPT = `You plan acceptance tests for an existing Playwright suite.

Produce a plan a domain expert could review without reading code. Steps are
business actions and observable outcomes — never selectors, never DTO field
names, never HTTP status codes.

The hardest requirement, and the one to think about first: name the mutation
that would make this test FAIL. The suite runs every generated test against a
mutated backend — an empty dataset, an unfiltered dataset, a 500 — and rejects
any test that survives all of them.

  empty-page   the API returns no rows; kills tests asserting content exists
  unfiltered   filter and search parameters are stripped, so the endpoint
               returns the full dataset; kills tests asserting that a filter
               NARROWS results
  http-500     the API fails outright; kills almost anything that loads a
               page, and therefore proves almost nothing on its own
  none         you cannot name one

Answering "http-500" or "none" is a signal the test asserts too little. Prefer
a plan whose failure mode is empty-page or unfiltered. Environments hold full
datasets, so asserting that a known record appears in an UNFILTERED list proves
nothing — it was going to be there regardless.`;

export const SYNTHESIZE_SYSTEM_PROMPT = `You write one Playwright spec file for an existing suite.

Match the exemplar specs' idiom exactly: imports, fixture usage, naming,
assertion style. The exemplars are the specification; where they and any prose
description disagree, the exemplars win.

Hard constraints:
- Use ONLY the page-object methods listed. Do not invent one, and do not
  inline raw locators to work around a missing method — set
  needsNewPageObjectMethod instead and say what is missing.
- Use ONLY the seeded fixtures provided. Never invent test data.
- Web-first assertions only. No waitForTimeout, no polling loops, no
  arbitrary sleeps.
- The test must fail if the feature breaks. A test that passes against an
  empty or unfiltered dataset will be rejected by the gate.`;

function renderGrounding(grounding: AuthorGrounding): string {
  const parts: string[] = [`Feature: ${grounding.feature}`];

  if (grounding.conventions !== null) {
    parts.push(`## Repository conventions (verbatim)\n${grounding.conventions}`);
  }
  if (grounding.pageObjectApi.length > 0) {
    parts.push(
      `## Page object API${grounding.pageObjectPath === null ? '' : ` — ${grounding.pageObjectPath}`}\n` +
        grounding.pageObjectApi.map(s => `- ${s}`).join('\n'),
    );
  }
  if (grounding.seededData !== null) {
    parts.push(`## Seeded fixtures (verbatim)\n\`\`\`ts\n${grounding.seededData}\n\`\`\``);
  }
  for (const exemplar of grounding.exemplars) {
    parts.push(`## Exemplar — ${exemplar.path}\n_${exemplar.reason}_\n\`\`\`ts\n${exemplar.source}\n\`\`\``);
  }
  return parts.join('\n\n');
}

export interface AuthorOptions {
  readonly budget?: BudgetGuard | undefined;
  /** Stop after planning, for review before any code is generated. */
  readonly planOnly?: boolean | undefined;
}

export async function runAuthorAgent(
  client: LlmClient,
  input: AuthorInput,
  options: AuthorOptions = {},
): Promise<AuthorOutcome> {
  if (!client.available) {
    return { status: 'unavailable', reason: 'no model configured', costUsd: 0 };
  }

  const budget = options.budget ?? new BudgetGuard();
  const grounded = renderGrounding(input.grounding);
  let spent = 0;

  // Grounding is the expensive, stable prefix and BOTH calls share it, so it
  // goes first for cache reuse. The goal, which differs every time, goes last.
  let plan: AuthorPlan;
  try {
    budget.assertCanSpend();
    const response = await client.completeStructured(
      {
        role: 'author',
        system: PLAN_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `${grounded}\n\n## Goal\n${input.goal}` }],
      },
      AuthorPlanSchema,
    );
    budget.record(response.usage);
    spent += response.usage.usd;
    plan = response.value;
  } catch (error) {
    if (error instanceof RefusalError) {
      return { status: 'declined', reason: error.message, costUsd: spent };
    }
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'model unavailable',
      costUsd: spent,
    };
  }

  if (options.planOnly === true) {
    return { status: 'planned', plan, costUsd: spent };
  }

  try {
    budget.assertCanSpend();
    const response = await client.completeStructured(
      {
        role: 'author',
        system: SYNTHESIZE_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content:
              `${grounded}\n\n## Approved plan\n${JSON.stringify(plan, null, 2)}\n\n` +
              `Write the spec file implementing exactly this plan.`,
          },
        ],
      },
      AuthorDraftSchema,
    );
    budget.record(response.usage);
    spent += response.usage.usd;
    const draft = response.value;

    // The model is constrained by prompt AND by post-hoc check. Prompts are
    // guidance; this is enforcement, and it is what makes "it cannot invent a
    // page-object method" a true statement rather than an aspiration.
    const known = new Set(input.grounding.pageObjectApi.map(sig => sig.split('(')[0]));
    const invented = draft.methodsUsed.filter(m => !known.has(m.split('.').pop() ?? m));
    if (invented.length > 0 && input.grounding.pageObjectApi.length > 0) {
      return {
        status: 'declined',
        reason: `draft uses page-object methods that do not exist: ${invented.join(', ')}`,
        costUsd: spent,
      };
    }

    return { status: 'drafted', plan, draft, costUsd: spent };
  } catch (error) {
    if (error instanceof RefusalError) {
      return { status: 'declined', reason: error.message, costUsd: spent };
    }
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'model unavailable',
      costUsd: spent,
    };
  }
}
