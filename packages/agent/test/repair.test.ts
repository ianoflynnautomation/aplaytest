import { describe, expect, it } from 'vitest';
import { BudgetGuard, FakeLlmClient, UnavailableLlmClient } from '@atest/llm';

import { REPAIR_SYSTEM_PROMPT, runRepairAgent, type RepairInput } from '../src/repair.js';

const INPUT: RepairInput = {
  testTitle: 'Given a gym name, when a visitor searches, then only that gym is displayed',
  intent: "gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' })",
  missingTestId: 'gym-card-name',
  failureKind: 'locator_not_found',
  expected: 'visible',
  actual: 'element(s) not found',
  ariaSnapshot: '- heading "Gyms"\n- list:\n  - listitem: Blackwater Valley BJJ',
  candidates: [
    { value: 'gym-card-title', expression: "getByTestId('gym-card-title')", semanticDistance: 0.1 },
    { value: 'gym-card-county', expression: "getByTestId('gym-card-county')", semanticDistance: 0.3 },
  ],
};

const choice = (over: Record<string, unknown> = {}) => ({
  diagnosis: 'selector_renamed',
  chosen: 'gym-card-title',
  reasoning: 'The card renders the gym name under gym-card-title.',
  confidence: 0.94,
  isRealBug: false,
  ...over,
});

describe('runRepairAgent — without a model', () => {
  it('given no model is configured -> when runRepairAgent runs -> then status is unavailable, leaving the Tier 0 ranking to stand', { tags: ['@unit', '@agent'] }, async () => {
    // The deterministic ranking is already correct in most cases; a missing
    // key must reduce scope, never correctness.
    const outcome = await runRepairAgent(new UnavailableLlmClient('no key'), INPUT);
    expect(outcome.status).toBe('unavailable');
  });

  it('given an empty candidate list -> when runRepairAgent runs -> then status is unavailable and no model call is made', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([]);
    const outcome = await runRepairAgent(client, { ...INPUT, candidates: [] });
    expect(outcome.status).toBe('unavailable');
    expect(client.callCount).toBe(0);
  });
});

describe('runRepairAgent — choosing', () => {
  it('given a model choosing an offered candidate -> when runRepairAgent runs -> then status is chose and the choice is that candidate', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    const outcome = await runRepairAgent(client, INPUT);

    expect(outcome.status).toBe('chose');
    if (outcome.status === 'chose') expect(outcome.choice.chosen).toBe('gym-card-title');
  });

  it('given a model choosing a selector outside the offered candidates -> when runRepairAgent validates it -> then status is invalid, naming the Tier-0 ranking', { tags: ['@unit', '@agent'] }, async () => {
    // The safety property of Tier 1 is that it may only pick options Tier 0
    // verified against the live page. A selector the model invented has never
    // been checked against anything.
    const client = new FakeLlmClient([{ reply: choice({ chosen: 'gym-card-invented' }) }]);
    const outcome = await runRepairAgent(client, INPUT);

    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.reason).toContain('not among the candidates');
      expect(outcome.reason).toContain('Tier-0 ranking');
    }
  });

  it('given a model declining with low confidence -> when runRepairAgent runs -> then status is declined rather than a failure', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: choice({ chosen: null, confidence: 0.2 }) }]);
    const outcome = await runRepairAgent(client, INPUT);
    expect(outcome.status).toBe('declined');
  });

  it('given a model reporting the failure is a real bug -> when runRepairAgent runs -> then status is real-bug, a first-class outcome', { tags: ['@unit', '@agent'] }, async () => {
    // The most valuable thing the agent can say. Making it a normal answer is
    // what stops it rationalising a patch for a genuine application defect.
    const client = new FakeLlmClient([
      { reply: choice({ isRealBug: true, diagnosis: 'element_removed', chosen: null }) },
    ]);
    const outcome = await runRepairAgent(client, INPUT);
    expect(outcome.status).toBe('real-bug');
  });
});

describe('runRepairAgent — prompt construction', () => {
  it('given a repair request -> when runRepairAgent builds the prompt -> then the invariant block is the system prefix and carries no per-failure detail', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    await runRepairAgent(client, INPUT);

    const request = client.requests[0];
    expect(request?.system).toBe(REPAIR_SYSTEM_PROMPT);
    // Per-failure detail must NOT be in the cached prefix, or nothing caches.
    expect(request?.system).not.toContain('Blackwater');
  });

  it('given a repair input carrying an intent and candidates -> when runRepairAgent builds the prompt -> then the intent, the candidates and the missing test id are all sent', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    await runRepairAgent(client, INPUT);

    const message = client.requests[0]?.messages[0]?.content ?? '';
    expect(message).toContain("expectCardData({ name: 'Blackwater Valley BJJ' })");
    expect(message).toContain('gym-card-title');
    expect(message).toContain('MISSING TEST ID: gym-card-name');
  });

  it('given an ARIA snapshot far past the character budget -> when runRepairAgent builds the prompt -> then the snapshot is truncated and the message stays small', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    await runRepairAgent(client, { ...INPUT, ariaSnapshot: 'x'.repeat(50_000) }, { ariaCharBudget: 500 });

    const message = client.requests[0]?.messages[0]?.content ?? '';
    expect(message).toContain('(truncated)');
    expect(message.length).toBeLessThan(2_000);
  });

  it('given a repair request -> when runRepairAgent calls the client -> then the request carries the heal role, so it runs on the mid-tier model', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    await runRepairAgent(client, INPUT);
    expect(client.requests[0]?.role).toBe('heal');
  });
});

describe('runRepairAgent — budget', () => {
  it('given a budget guard already past its pool -> when runRepairAgent runs -> then status is unavailable and no call is made', { tags: ['@unit', '@agent'] }, async () => {
    const guard = new BudgetGuard({ perCallUsd: 1, totalUsd: 0.01, maxCalls: 10 });
    guard.record({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: 0.5,
    });

    const client = new FakeLlmClient([{ reply: choice() }]);
    const outcome = await runRepairAgent(client, INPUT, { budget: guard });

    expect(outcome.status).toBe('unavailable');
    // The call must not have been made — the guard runs BEFORE spending.
    expect(client.callCount).toBe(0);
  });

  it('given a model returning unparseable output twice -> when runRepairAgent runs -> then status is unavailable rather than a crash', { tags: ['@unit', '@agent'] }, async () => {
    const client = new FakeLlmClient([{ reply: 'not json' }, { reply: 'still not json' }]);
    const outcome = await runRepairAgent(client, INPUT);
    expect(outcome.status).toBe('unavailable');
  });
});
