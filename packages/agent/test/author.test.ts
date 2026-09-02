import { FakeLlmClient, UnavailableLlmClient } from '@atest/llm';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { RepairChoiceSchema } from '../src/repair.js';
import {
  AuthorDraftSchema,
  AuthorPlanSchema,
  PLAN_SYSTEM_PROMPT,
  SYNTHESIZE_SYSTEM_PROMPT,
  runAuthorAgent,
  type AuthorGrounding,
} from '../src/author.js';

const GROUNDING: AuthorGrounding = {
  feature: 'gyms',
  conventions: '# CLAUDE.md\nWeb-first assertions only.',
  pageObjectApi: ['goTo(page: Page): Promise<void>', 'searchFor(page: Page, term: string): Promise<void>'],
  pageObjectPath: 'src/ui/pages/gyms/gyms.page.ts',
  seededData: "export const SEEDED_GYM = { name: '011 Grappling' };",
  exemplars: [{ path: 'tests/gyms.ui.spec.ts', source: "test('x', async () => {});", reason: 'same feature' }],
};

const PLAN = {
  title: 'Given seeded gyms, when searching by name, then only that gym is listed',
  steps: ['Open the gyms directory', 'Search for the seeded gym', 'Only that gym is listed'],
  fixtures: ['SEEDED_GYM'],
  expectedToDieFrom: 'unfiltered',
  rationale: 'Search is the primary way users find a gym.',
};

const DRAFT = {
  spec: "import { test } from '@ui/fixtures';\n\ntest('x', async ({ gymsPage }) => { await gymsPage.goTo(); });",
  methodsUsed: ['gymsPage.goTo', 'gymsPage.searchFor'],
  needsNewPageObjectMethod: false,
  notes: 'Uses only the listed methods.',
};

describe('author agent', () => {
  it('given a client queued with a plan and a draft -> when runAuthorAgent runs -> then it makes two separate calls, planning before synthesising', { tags: ['@unit', '@agent'] }, () => {
    // Separated so a human can reject a plan before any code exists. Reviewing
    // prose is cheap; reviewing plausible-looking code is not.
    const client = new FakeLlmClient([{ reply: PLAN }, { reply: DRAFT }]);
    return runAuthorAgent(client, { goal: 'test gym search', grounding: GROUNDING }).then(result => {
      expect(result.status).toBe('drafted');
      expect(client.callCount).toBe(2);
      expect(client.requests[0]?.system).toBe(PLAN_SYSTEM_PROMPT);
      expect(client.requests[1]?.system).toBe(SYNTHESIZE_SYSTEM_PROMPT);
    });
  });

  it('given the planOnly option -> when runAuthorAgent runs -> then it stops at status planned after a single call', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: PLAN }]);
    const result = await runAuthorAgent(
      client,
      { goal: 'test gym search', grounding: GROUNDING },
      { planOnly: true },
    );
    expect(result.status).toBe('planned');
    expect(client.callCount).toBe(1);
  });

  it('given a draft naming a page-object method absent from the grounding -> when runAuthorAgent validates it -> then the run is declined naming the invented method', { tags: ['@unit', '@agent'] }, async () => {
    // The prompt asks the model not to invent methods. This is the enforcement
    // that makes that a fact rather than a hope — a spec calling a method that
    // is not there fails at import time, long after the agent looked correct.
    const client = new FakeLlmClient([
      { reply: PLAN },
      { reply: { ...DRAFT, methodsUsed: ['gymsPage.goTo', 'gymsPage.filterByCounty'] } },
    ]);
    const result = await runAuthorAgent(client, { goal: 'g', grounding: GROUNDING });

    expect(result.status).toBe('declined');
    if (result.status === 'declined') expect(result.reason).toContain('filterByCounty');
  });

  it('given a paid plan followed by an unparseable draft -> when runAuthorAgent runs -> then status is unavailable and the plan cost is still reported', { tags: ['@unit', '@agent'] }, async () => {
    // Reporting zero for a run that paid for a plan understates the cost of
    // exactly the runs that produced nothing.
    const client = new FakeLlmClient([
      { reply: PLAN, usage: { usd: 0.02 } },
      { reply: 'not valid json at all' },
    ]);
    const result = await runAuthorAgent(client, { goal: 'g', grounding: GROUNDING });

    expect(result.status).toBe('unavailable');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('given no model is configured -> when runAuthorAgent runs -> then status is unavailable and costUsd is 0', { tags: ['@unit', '@agent'] }, async () => {
    const result = await runAuthorAgent(new UnavailableLlmClient('no key'), {
      goal: 'g',
      grounding: GROUNDING,
    });
    expect(result.status).toBe('unavailable');
    expect(result.costUsd).toBe(0);
  });

  it('given a grounding shared by both calls -> when runAuthorAgent builds the prompts -> then each message opens with the same grounding prefix, so the cache hits', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: PLAN }, { reply: DRAFT }]);
    await runAuthorAgent(client, { goal: 'test gym search', grounding: GROUNDING });

    const first = client.requests[0]?.messages[0]?.content ?? '';
    const second = client.requests[1]?.messages[0]?.content ?? '';
    expect(first.startsWith('Feature: gyms')).toBe(true);
    expect(second.startsWith('Feature: gyms')).toBe(true);
  });

  it('given an exemplar carrying its source -> when runAuthorAgent builds the prompt -> then the verbatim exemplar source is included', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: PLAN }, { reply: DRAFT }]);
    await runAuthorAgent(client, { goal: 'g', grounding: GROUNDING });
    expect(client.requests[0]?.messages[0]?.content).toContain("test('x', async () => {});");
  });
});

describe('AuthorPlanSchema', () => {
  it('given a plan with expectedToDieFrom removed -> when AuthorPlanSchema parses it -> then parsing fails, forcing the author to name a mutation', { tags: ['@unit', '@agent'] }, () => {
    // An agent that cannot name a mutation that would break its test has not
    // designed a test.
    const { expectedToDieFrom, ...withoutFailureMode } = PLAN;
    expect(expectedToDieFrom).toBeDefined();
    expect(AuthorPlanSchema.safeParse(withoutFailureMode).success).toBe(false);
  });

  it('given a plan naming an unknown mutation -> when AuthorPlanSchema parses it -> then parsing fails', { tags: ['@unit', '@agent'] }, () => {
    expect(AuthorPlanSchema.safeParse({ ...PLAN, expectedToDieFrom: 'vibes' }).success).toBe(false);
  });

  it('given a plan whose expectedToDieFrom is none -> when AuthorPlanSchema parses it -> then parsing succeeds, so the agent can admit it rather than invent one', { tags: ['@unit', '@agent'] }, () => {
    expect(AuthorPlanSchema.safeParse({ ...PLAN, expectedToDieFrom: 'none' }).success).toBe(true);
  });
});

describe('schema length constraints', () => {
  /**
   * REGRESSION GUARD, found on a live run.
   *
   * `.max()` on a string or array is NOT sent to the model — the SDK strips
   * those constraints out of the wire schema and validates them client-side
   * after the response arrives. A tight max is therefore invisible to the
   * model and fatal to the run: an 800-character cap on `notes` discarded a
   * completed generation because the model wrote 900 characters it was never
   * asked to stay under.
   *
   * `.describe()` IS sent. So every bounded field must carry one.
   */
  const boundedFieldsHaveDescriptions = (schema: z.ZodObject): string[] => {
    const offenders: string[] = [];
    for (const [name, field] of Object.entries(schema.shape)) {
      const json = z.toJSONSchema(field as z.ZodType, { io: 'output' }) as {
        maxLength?: number;
        maxItems?: number;
        description?: string;
      };
      const bounded = json.maxLength !== undefined || json.maxItems !== undefined;
      if (bounded && (json.description ?? '') === '') offenders.push(name);
    }
    return offenders;
  };

  it('given AuthorPlanSchema -> when its length-bounded fields are inspected -> then every one carries a description the model can see', { tags: ['@unit', '@agent'] }, () => {
    expect(boundedFieldsHaveDescriptions(AuthorPlanSchema)).toEqual([]);
  });

  it('given AuthorDraftSchema -> when its length-bounded fields are inspected -> then every one carries a description the model can see', { tags: ['@unit', '@agent'] }, () => {
    expect(boundedFieldsHaveDescriptions(AuthorDraftSchema)).toEqual([]);
  });

  it('given RepairChoiceSchema -> when its length-bounded fields are inspected -> then every one carries a description the model can see', { tags: ['@unit', '@agent'] }, () => {
    expect(boundedFieldsHaveDescriptions(RepairChoiceSchema)).toEqual([]);
  });

  it('given the notes field of AuthorDraftSchema -> when its maxLength is inspected -> then the backstop allows at least 2000 characters of normal prose', { tags: ['@unit', '@agent'] }, () => {
    // The backstop guards against pathological output, not against prose.
    const json = z.toJSONSchema(AuthorDraftSchema, { io: 'output' }) as {
      properties: Record<string, { maxLength?: number }>;
    };
    expect(json.properties['notes']?.maxLength ?? 0).toBeGreaterThanOrEqual(2000);
  });
});
