import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BudgetGuard } from '../src/budget.js';
import { createLlmClient, describeAvailability } from '../src/factory.js';
import { FakeLlmClient } from '../src/fake.js';
import { BudgetExceededError, LlmUnavailableError, RefusalError } from '../src/errors.js';
import { checkCacheable, costUsd, DEFAULT_MODELS, MODELS, specFor } from '../src/pricing.js';

describe('degradation — no key is not a crash', () => {
  it('given an environment with no API key -> when createLlmClient builds a client -> then the client reports unavailable rather than throwing at startup', { tags: ['@unit', '@llm'] }, () => {
    // Every deterministic feature must keep working; only paths that genuinely
    // need a model may fail.
    const client = createLlmClient({ env: {} });
    expect(client.available).toBe(false);
  });

  it('given an unavailable client -> when complete is called -> then it rejects with LlmUnavailableError rather than returning empty output', { tags: ['@unit', '@llm'] }, async () => {
    // Silently degrading to a worse answer that looks normal is the failure
    // mode the whole contract exists to prevent.
    const client = createLlmClient({ env: {} });
    await expect(client.complete({ role: 'heal', system: 's', messages: [] })).rejects.toThrow(
      LlmUnavailableError,
    );
  });

  it('given an environment with no API key -> when complete is called -> then the rejection names the missing ANTHROPIC_API_KEY', { tags: ['@unit', '@llm'] }, async () => {
    const client = createLlmClient({ env: {} });
    await expect(
      client.complete({ role: 'heal', system: 's', messages: [] }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('given a present API key and an explicit disable -> when createLlmClient builds a client -> then the client reports unavailable', { tags: ['@unit', '@llm'] }, () => {
    const client = createLlmClient({ env: { ANTHROPIC_API_KEY: 'sk-test' }, disabled: true });
    expect(client.available).toBe(false);
  });

  it('given an environment carrying an API key -> when createLlmClient builds a client -> then the client is available and maps the heal role to its model', { tags: ['@unit', '@llm'] }, () => {
    const client = createLlmClient({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
    expect(client.available).toBe(true);
    expect(client.modelFor('heal')).toBe('claude-sonnet-5');
  });

  it('given an unavailable client -> when describeAvailability renders it -> then the description says deterministic tier only', { tags: ['@unit', '@llm'] }, () => {
    expect(describeAvailability(createLlmClient({ env: {} }), ['heal'])).toContain(
      'deterministic tier only',
    );
  });
});

describe('model selection', () => {
  it('given the default model map -> when the roles are inspected -> then classify, heal and author map to Haiku, Sonnet and Opus respectively', { tags: ['@unit', '@llm'] }, () => {
    expect(DEFAULT_MODELS.classify).toBe('claude-haiku-4-5');
    expect(DEFAULT_MODELS.heal).toBe('claude-sonnet-5');
    expect(DEFAULT_MODELS.author).toBe('claude-opus-5');
  });

  it('given every default model -> when specFor looks each up -> then all of them carry a pricing entry', { tags: ['@unit', '@llm'] }, () => {
    for (const model of Object.values(DEFAULT_MODELS)) {
      expect(specFor(model), `${model} has no pricing entry`).not.toBeNull();
    }
  });
});

describe('cost accounting', () => {
  it('given one million input tokens on Opus 5 -> when costUsd prices them -> then the cost is 5 dollars', { tags: ['@unit', '@llm'] }, () => {
    // Opus 5: $5/MTok in, $25/MTok out.
    const cost = costUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(5, 6);
  });

  it('given the same token count as base input and as cache reads -> when costUsd prices both -> then the cache read costs a tenth of base input', { tags: ['@unit', '@llm'] }, () => {
    const base = costUsd('claude-sonnet-5', {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const cached = costUsd('claude-sonnet-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 0,
    });
    expect(cached).toBeCloseTo(base * 0.1, 6);
  });

  it('given a model with no pricing entry -> when costUsd prices it -> then the cost is 0 rather than a guess', { tags: ['@unit', '@llm'] }, () => {
    expect(
      costUsd('some-future-model', {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0);
  });
});

describe('cache prefix minimums', () => {
  it('given the cache prefix minimums for Opus, Sonnet and Haiku -> when they are compared -> then the minimum rises rather than tracking model size', { tags: ['@unit', '@llm'] }, () => {
    // The trap: a prefix that caches on Opus 5 silently does not on Haiku 4.5,
    // and Haiku is where the high-volume classify path runs.
    expect(MODELS['claude-opus-5']?.minCacheablePrefix).toBe(512);
    expect(MODELS['claude-sonnet-5']?.minCacheablePrefix).toBe(1024);
    expect(MODELS['claude-haiku-4-5']?.minCacheablePrefix).toBe(4096);
  });

  it('given one prefix above the Opus and Sonnet minimums but below the Haiku one -> when checkCacheable checks each model -> then only Haiku warns that caching is silently ignored', { tags: ['@unit', '@llm'] }, () => {
    // ~2000 tokens: comfortably above Opus 5 (512) and Sonnet 5 (1024), well
    // below Haiku 4.5 (4096). The identical conventions block therefore caches
    // on the heal path and silently does not on the high-volume classify path.
    const prefix = 'x'.repeat(8000);

    expect(checkCacheable('claude-opus-5', prefix)).toBeNull();
    expect(checkCacheable('claude-sonnet-5', prefix)).toBeNull();

    const warning = checkCacheable('claude-haiku-4-5', prefix);
    expect(warning).not.toBeNull();
    expect(warning?.message).toContain('silently ignored');
    expect(warning?.minimum).toBe(4096);
  });

  it('given a prefix well above the Haiku minimum -> when checkCacheable checks it -> then no warning is returned', { tags: ['@unit', '@llm'] }, () => {
    expect(checkCacheable('claude-haiku-4-5', 'x'.repeat(20_000))).toBeNull();
  });
});

describe('BudgetGuard', () => {
  it('given a budget guard already past its total -> when assertCanSpend runs -> then it throws BudgetExceededError before the call is made', { tags: ['@unit', '@llm'] }, () => {
    const guard = new BudgetGuard({ perCallUsd: 1, totalUsd: 0.1, maxCalls: 100 });
    guard.record({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: 0.2,
    });
    expect(() => guard.assertCanSpend()).toThrow(BudgetExceededError);
  });

  it('given a budget guard at its call limit -> when assertCanSpend runs -> then it throws naming the call count and limit', { tags: ['@unit', '@llm'] }, () => {
    const guard = new BudgetGuard({ perCallUsd: 1, totalUsd: 100, maxCalls: 2 });
    for (let i = 0; i < 2; i++) {
      guard.record({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usd: 0.001,
      });
    }
    expect(() => guard.assertCanSpend()).toThrow(/2 calls, limit 2/);
  });

  it('given a guard with one recorded call that hit the cache -> when summary renders it -> then one line reports the call count, cached tokens and spend', { tags: ['@unit', '@llm'] }, () => {
    const guard = new BudgetGuard();
    expect(guard.summary()).toBe('no model calls');

    guard.record({
      inputTokens: 4000,
      outputTokens: 200,
      cacheReadTokens: 3000,
      cacheWriteTokens: 0,
      usd: 0.012,
    });
    expect(guard.summary()).toContain('1 model call');
    expect(guard.summary()).toContain('3000 cached');
    expect(guard.summary()).toContain('$0.0120');
  });

  it('given a guard with one recorded call that missed the cache -> when summary renders it -> then it says no cache hits', { tags: ['@unit', '@llm'] }, () => {
    const guard = new BudgetGuard();
    guard.record({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: 0.001,
    });
    expect(guard.summary()).toContain('no cache hits');
  });
});

describe('FakeLlmClient — structured output', () => {
  const Schema = z.object({ choice: z.string(), confidence: z.number() });

  it('given a scripted response matching the schema -> when completeStructured decodes it -> then the value is returned and no repair is recorded', { tags: ['@unit', '@llm'] }, async () => {
    const client = new FakeLlmClient([{ reply: { choice: 'gym-card-title', confidence: 0.9 } }]);
    const result = await client.completeStructured(
      { role: 'heal', system: 's', messages: [] },
      Schema,
    );
    expect(result.value.choice).toBe('gym-card-title');
    expect(result.repaired).toBe(false);
  });

  it('given a malformed response followed by a valid one -> when completeStructured decodes them -> then the repair succeeds after exactly two calls', { tags: ['@unit', '@llm'] }, async () => {
    const client = new FakeLlmClient([
      { reply: 'not json at all' },
      { reply: { choice: 'gym-card-title', confidence: 0.9 } },
    ]);
    const result = await client.completeStructured(
      { role: 'heal', system: 's', messages: [] },
      Schema,
    );
    expect(result.repaired).toBe(true);
    expect(client.callCount).toBe(2);
  });

  it('given two consecutive malformed responses -> when completeStructured decodes them -> then it rejects after two calls rather than looping', { tags: ['@unit', '@llm'] }, async () => {
    const client = new FakeLlmClient([{ reply: 'garbage' }, { reply: 'still garbage' }]);
    await expect(
      client.completeStructured({ role: 'heal', system: 's', messages: [] }, Schema),
    ).rejects.toThrow(/did not match the schema/);
    expect(client.callCount).toBe(2);
  });

  it('given a response carrying a refusal stop reason -> when completeStructured decodes it -> then it rejects with RefusalError rather than empty text', { tags: ['@unit', '@llm'] }, async () => {
    // A refusal is HTTP 200 with stop_reason "refusal"; code that reads
    // content[0] without checking breaks on it.
    const client = new FakeLlmClient([{ reply: '', refused: true, refusalCategory: 'cyber' }]);
    await expect(
      client.completeStructured({ role: 'heal', system: 's', messages: [] }, Schema),
    ).rejects.toThrow(RefusalError);
  });

  it('given a fake client scripted for one call -> when a second call is made -> then it rejects saying the script ran out', { tags: ['@unit', '@llm'] }, async () => {
    const client = new FakeLlmClient([{ reply: '{}' }]);
    await client.complete({ role: 'heal', system: 's', messages: [] });
    await expect(client.complete({ role: 'heal', system: 's', messages: [] })).rejects.toThrow(
      /ran out of script/,
    );
  });
});
