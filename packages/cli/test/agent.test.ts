/**
 * End-to-end for `atest agent author`, driven by a scripted model.
 *
 * This runs REAL Playwright against the smoke example, because the property
 * under test — that a candidate failing the gate never survives on disk —
 * cannot be established by mocking the thing that decides it.
 */

import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { FakeLlmClient, UnavailableLlmClient } from '@atest/llm';
import { afterEach, describe, expect, it } from 'vitest';

import { agentAuthor, extractTestTitle, type AgentFlags } from '../src/commands/agent.js';
import { EXIT } from '../src/exit.js';

const SMOKE = new URL('../../../examples/smoke', import.meta.url).pathname;
const GENERATED = 'tests/generated.spec.ts';

const BASE: AgentFlags = {
  goal: 'check the gyms list renders',
  feature: 'smoke',
  cwd: SMOKE,
  out: GENERATED,
  validate: '1',
  planOnly: false,
  keepRejected: false,
  force: true,
  noLlm: false,
  json: false,
  dryRun: false,
};

const PLAN = {
  title: 'generated candidate',
  steps: ['Open the page', 'Assert something'],
  fixtures: [],
  expectedToDieFrom: 'empty-page',
  rationale: 'Covers the list rendering.',
};

/** Passes, but asserts nothing about server data — the gate must reject it. */
const VACUOUS_SPEC = `import { expect, test } from '@playwright/test';

test('generated candidate', async ({ page }) => {
  await page.setContent('<main><h1 data-testid="t">Gyms</h1></main>');
  await expect(page.getByTestId('t')).toBeVisible();
});
`;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  await rm(join(SMOKE, GENERATED), { force: true });
});

describe('atest agent author', () => {
  it('given a model producing a vacuous spec the gate rejects -> when agent author runs -> then it exits on the policy violation and no spec is left on disk', { tags: ['@integration', '@cli'], timeout: 180_000 }, async () => {
    // The property the command exists for. A rejected candidate is green and
    // asserts nothing — strictly worse than generating nothing, because it
    // looks like coverage to whoever reviews the diff.
    const client = new FakeLlmClient([
      { reply: PLAN },
      { reply: { spec: VACUOUS_SPEC, methodsUsed: [], needsNewPageObjectMethod: false, notes: '' } },
    ]);

    await expect(agentAuthor(BASE, { client })).rejects.toMatchObject({
      exitCode: EXIT.POLICY_VIOLATION,
    });
    expect(await exists(join(SMOKE, GENERATED))).toBe(false);
  });

  it('given a rejected candidate and the keepRejected flag -> when agent author runs -> then it still exits on the policy violation but the spec is kept on disk', { tags: ['@integration', '@cli'], timeout: 180_000 }, async () => {
    const client = new FakeLlmClient([
      { reply: PLAN },
      { reply: { spec: VACUOUS_SPEC, methodsUsed: [], needsNewPageObjectMethod: false, notes: '' } },
    ]);

    await expect(
      agentAuthor({ ...BASE, keepRejected: true }, { client }),
    ).rejects.toMatchObject({ exitCode: EXIT.POLICY_VIOLATION });

    expect(await exists(join(SMOKE, GENERATED))).toBe(true);
    expect(await readFile(join(SMOKE, GENERATED), 'utf8')).toContain('generated candidate');
  });

  it('given the dry-run flag -> when agent author runs -> then it exits ok having spent no model call', { tags: ['@integration', '@cli'] }, async () => {
    const client = new FakeLlmClient([]);
    const code = await agentAuthor({ ...BASE, dryRun: true }, { client });
    expect(code).toBe(EXIT.OK);
    expect(client.callCount).toBe(0);
  });

  it('given an output path that already exists and no force flag -> when agent author runs -> then it refuses, saying the file already exists', { tags: ['@integration', '@cli'] }, async () => {
    const client = new FakeLlmClient([
      { reply: PLAN },
      { reply: { spec: VACUOUS_SPEC, methodsUsed: [], needsNewPageObjectMethod: false, notes: '' } },
    ]);
    await expect(
      agentAuthor({ ...BASE, out: 'tests/smoke.spec.ts', force: false }, { client }),
    ).rejects.toThrow(/already exists/);
  });

  it('given no model is configured -> when agent author runs -> then it exits unavailable and writes no spec, because no deterministic tier can author one', { tags: ['@integration', '@cli'] }, async () => {
    // There is no deterministic tier that writes a test, so this is the one
    // capability that genuinely cannot degrade.
    const code = await agentAuthor(BASE, { client: new UnavailableLlmClient('no key') });
    expect(code).toBe(EXIT.LLM_UNAVAILABLE);
    expect(await exists(join(SMOKE, GENERATED))).toBe(false);
  });

  it('given no goal -> when agent author runs -> then it rejects naming the missing flag', { tags: ['@integration', '@cli'] }, async () => {
    await expect(agentAuthor({ ...BASE, goal: undefined })).rejects.toThrow(/--goal/);
  });
});

describe('extractTestTitle', () => {
  it('given a spec whose test title differs from the plan title -> when extractTestTitle reads it -> then the title the model actually wrote is returned', { tags: ['@unit', '@cli'] }, () => {
    // REGRESSION GUARD, found on a live run. The gate greps Playwright by
    // title; assuming the spec reuses the plan's title verbatim made a good
    // generated test look like an inconclusive gate run, and it was deleted.
    const spec = `import { expect, test } from './fixtures.js';

test('searching by name narrows the gyms directory to only that gym', async ({ gymsPage }) => {
  await gymsPage.goTo();
});
`;
    expect(extractTestTitle(spec)).toBe('searching by name narrows the gyms directory to only that gym');
  });

  it('given test titles quoted with double quotes and backticks -> when extractTestTitle reads them -> then each title is recovered', { tags: ['@unit', '@cli'] }, () => {
    expect(extractTestTitle(`test("a gym is found", async () => {});`)).toBe('a gym is found');
    expect(extractTestTitle('test(`a gym is found`, async () => {});')).toBe('a gym is found');
  });

  it('given a test declared with a modifier -> when extractTestTitle reads it -> then the title is still recovered', { tags: ['@unit', '@cli'] }, () => {
    expect(extractTestTitle(`test.only('a gym is found', async () => {});`)).toBe('a gym is found');
  });

  it('given a spec holding several tests -> when extractTestTitle reads it -> then the first title is taken', { tags: ['@unit', '@cli'] }, () => {
    const spec = `test('first', async () => {});\ntest('second', async () => {});`;
    expect(extractTestTitle(spec)).toBe('first');
  });

  it('given a title built by interpolation -> when extractTestTitle reads it -> then it declines rather than returning a literal that cannot match', { tags: ['@unit', '@cli'] }, () => {
    expect(extractTestTitle('test(`gym ${name} is found`, async () => {});')).toBeNull();
  });

  it('given the word test appearing in a describe block or a comment -> when extractTestTitle reads the spec -> then only a real test title is returned', { tags: ['@unit', '@cli'] }, () => {
    const spec = `// this tests the thing\ntest('real title', async () => {});`;
    expect(extractTestTitle(spec)).toBe('real title');
  });

  it('given a spec holding no test -> when extractTestTitle reads it -> then it returns null so the caller can fall back', { tags: ['@unit', '@cli'] }, () => {
    expect(extractTestTitle('export const x = 1;')).toBeNull();
  });
});
