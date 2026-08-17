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
  it('reports unavailable rather than failing, leaving Tier 0 to stand', async () => {
    // The deterministic ranking is already correct in most cases; a missing
    // key must reduce scope, never correctness.
    const outcome = await runRepairAgent(new UnavailableLlmClient('no key'), INPUT);
    expect(outcome.status).toBe('unavailable');
  });

  it('does not call a model when there is nothing to rank', async () => {
    const client = new FakeLlmClient([]);
    const outcome = await runRepairAgent(client, { ...INPUT, candidates: [] });
    expect(outcome.status).toBe('unavailable');
    expect(client.callCount).toBe(0);
  });
});

describe('runRepairAgent — choosing', () => {
  it('returns the chosen candidate', async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    const outcome = await runRepairAgent(client, INPUT);

    expect(outcome.status).toBe('chose');
    if (outcome.status === 'chose') expect(outcome.choice.chosen).toBe('gym-card-title');
  });

  it('REJECTS a choice outside the offered candidates', async () => {
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

  it('treats declining as a correct answer, not a failure', async () => {
    const client = new FakeLlmClient([{ reply: choice({ chosen: null, confidence: 0.2 }) }]);
    const outcome = await runRepairAgent(client, INPUT);
    expect(outcome.status).toBe('declined');
  });

  it('surfaces "this is a real bug" as a first-class outcome', async () => {
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
  it('puts the invariant block in `system`, so it is the cache prefix', async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    await runRepairAgent(client, INPUT);

    const request = client.requests[0];
    expect(request?.system).toBe(REPAIR_SYSTEM_PROMPT);
    // Per-failure detail must NOT be in the cached prefix, or nothing caches.
    expect(request?.system).not.toContain('Blackwater');
  });

  it('sends the intent and the candidate list, not a raw selector alone', async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    await runRepairAgent(client, INPUT);

    const message = client.requests[0]?.messages[0]?.content ?? '';
    expect(message).toContain("expectCardData({ name: 'Blackwater Valley BJJ' })");
    expect(message).toContain('gym-card-title');
    expect(message).toContain('MISSING TEST ID: gym-card-name');
  });

  it('truncates a huge ARIA snapshot rather than blowing the budget', async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    await runRepairAgent(client, { ...INPUT, ariaSnapshot: 'x'.repeat(50_000) }, { ariaCharBudget: 500 });

    const message = client.requests[0]?.messages[0]?.content ?? '';
    expect(message).toContain('(truncated)');
    expect(message.length).toBeLessThan(2_000);
  });

  it('uses the heal role, so it runs on the mid-tier model', async () => {
    const client = new FakeLlmClient([{ reply: choice() }]);
    await runRepairAgent(client, INPUT);
    expect(client.requests[0]?.role).toBe('heal');
  });
});

describe('runRepairAgent — budget', () => {
  it('refuses to spend past the pool and says so', async () => {
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

  it('survives a malformed response without crashing the heal run', async () => {
    const client = new FakeLlmClient([{ reply: 'not json' }, { reply: 'still not json' }]);
    const outcome = await runRepairAgent(client, INPUT);
    expect(outcome.status).toBe('unavailable');
  });
});
