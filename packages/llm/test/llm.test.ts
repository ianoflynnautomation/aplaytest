import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BudgetGuard } from '../src/budget.js';
import { createLlmClient, describeAvailability } from '../src/factory.js';
import { FakeLlmClient } from '../src/fake.js';
import { BudgetExceededError, LlmUnavailableError, RefusalError } from '../src/errors.js';
import { checkCacheable, costUsd, DEFAULT_MODELS, MODELS, specFor } from '../src/pricing.js';

describe('degradation — no key is not a crash', () => {
  it('resolves to an unavailable client rather than throwing at startup', () => {
    // Every deterministic feature must keep working; only paths that genuinely
    // need a model may fail.
    const client = createLlmClient({ env: {} });
    expect(client.available).toBe(false);
  });

  it('throws a NAMED error, never returns empty output', async () => {
    // Silently degrading to a worse answer that looks normal is the failure
    // mode the whole contract exists to prevent.
    const client = createLlmClient({ env: {} });
    await expect(client.complete({ role: 'heal', system: 's', messages: [] })).rejects.toThrow(
      LlmUnavailableError,
    );
  });

  it('names the reason so the CLI can print something actionable', async () => {
    const client = createLlmClient({ env: {} });
    await expect(
      client.complete({ role: 'heal', system: 's', messages: [] }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('honours an explicit disable over a present key', () => {
    const client = createLlmClient({ env: { ANTHROPIC_API_KEY: 'sk-test' }, disabled: true });
    expect(client.available).toBe(false);
  });

  it('builds a real client when a key exists', () => {
    const client = createLlmClient({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
    expect(client.available).toBe(true);
    expect(client.modelFor('heal')).toBe('claude-sonnet-5');
  });

  it('still reports which models it would use, so doctor can say so', () => {
    expect(describeAvailability(createLlmClient({ env: {} }), ['heal'])).toContain(
      'deterministic tier only',
    );
  });
});

describe('model selection', () => {
  it('splits roles by job shape, not by a vague quality axis', () => {
    expect(DEFAULT_MODELS.classify).toBe('claude-haiku-4-5');
    expect(DEFAULT_MODELS.heal).toBe('claude-sonnet-5');
    expect(DEFAULT_MODELS.author).toBe('claude-opus-5');
  });

  it('knows every default model', () => {
    for (const model of Object.values(DEFAULT_MODELS)) {
      expect(specFor(model), `${model} has no pricing entry`).not.toBeNull();
    }
  });
});

describe('cost accounting', () => {
  it('computes cost from real per-token rates', () => {
    // Opus 5: $5/MTok in, $25/MTok out.
    const cost = costUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(5, 6);
  });

  it('prices cache reads at a tenth of base input', () => {
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

  it('returns zero for an unknown model rather than guessing a price', () => {
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
  it('encodes that the minimum is NOT monotonic across models', () => {
    // The trap: a prefix that caches on Opus 5 silently does not on Haiku 4.5,
    // and Haiku is where the high-volume classify path runs.
    expect(MODELS['claude-opus-5']?.minCacheablePrefix).toBe(512);
    expect(MODELS['claude-sonnet-5']?.minCacheablePrefix).toBe(1024);
    expect(MODELS['claude-haiku-4-5']?.minCacheablePrefix).toBe(4096);
  });

  it('warns for one model and not another on the SAME prefix', () => {
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

  it('is quiet when the prefix clears the bar', () => {
    expect(checkCacheable('claude-haiku-4-5', 'x'.repeat(20_000))).toBeNull();
  });
});

describe('BudgetGuard', () => {
  it('throws BEFORE a call, so the limit is enforced rather than observed', () => {
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

  it('caps call count as well as spend, to stop a runaway loop', () => {
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

  it('discloses usage in one line, including whether the cache was hit', () => {
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

  it('says plainly when nothing was cached', () => {
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

  it('decodes a valid response', async () => {
    const client = new FakeLlmClient([{ reply: { choice: 'gym-card-title', confidence: 0.9 } }]);
    const result = await client.completeStructured(
      { role: 'heal', system: 's', messages: [] },
      Schema,
    );
    expect(result.value.choice).toBe('gym-card-title');
    expect(result.repaired).toBe(false);
  });

  it('repairs a malformed response exactly once', async () => {
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

  it('gives up after one repair instead of looping on a stuck model', async () => {
    const client = new FakeLlmClient([{ reply: 'garbage' }, { reply: 'still garbage' }]);
    await expect(
      client.completeStructured({ role: 'heal', system: 's', messages: [] }, Schema),
    ).rejects.toThrow(/did not match the schema/);
    expect(client.callCount).toBe(2);
  });

  it('surfaces a refusal as a typed error rather than empty text', async () => {
    // A refusal is HTTP 200 with stop_reason "refusal"; code that reads
    // content[0] without checking breaks on it.
    const client = new FakeLlmClient([{ reply: '', refused: true, refusalCategory: 'cyber' }]);
    await expect(
      client.completeStructured({ role: 'heal', system: 's', messages: [] }, Schema),
    ).rejects.toThrow(RefusalError);
  });

  it('fails loudly when the code makes more calls than the script expects', async () => {
    const client = new FakeLlmClient([{ reply: '{}' }]);
    await client.complete({ role: 'heal', system: 's', messages: [] });
    await expect(client.complete({ role: 'heal', system: 's', messages: [] })).rejects.toThrow(
      /ran out of script/,
    );
  });
});
