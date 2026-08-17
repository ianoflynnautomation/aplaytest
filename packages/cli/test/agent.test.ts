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
  it('DELETES a candidate the gate rejects', async () => {
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
  }, 180_000);

  it('keeps it only when explicitly asked to', async () => {
    const client = new FakeLlmClient([
      { reply: PLAN },
      { reply: { spec: VACUOUS_SPEC, methodsUsed: [], needsNewPageObjectMethod: false, notes: '' } },
    ]);

    await expect(
      agentAuthor({ ...BASE, keepRejected: true }, { client }),
    ).rejects.toMatchObject({ exitCode: EXIT.POLICY_VIOLATION });

    expect(await exists(join(SMOKE, GENERATED))).toBe(true);
    expect(await readFile(join(SMOKE, GENERATED), 'utf8')).toContain('generated candidate');
  }, 180_000);

  it('never spends a model call when the grounding is only being inspected', async () => {
    const client = new FakeLlmClient([]);
    const code = await agentAuthor({ ...BASE, dryRun: true }, { client });
    expect(code).toBe(EXIT.OK);
    expect(client.callCount).toBe(0);
  });

  it('refuses to overwrite an existing spec without --force', async () => {
    const client = new FakeLlmClient([
      { reply: PLAN },
      { reply: { spec: VACUOUS_SPEC, methodsUsed: [], needsNewPageObjectMethod: false, notes: '' } },
    ]);
    await expect(
      agentAuthor({ ...BASE, out: 'tests/smoke.spec.ts', force: false }, { client }),
    ).rejects.toThrow(/already exists/);
  });

  it('exits 3 without a model rather than pretending a fallback exists', async () => {
    // There is no deterministic tier that writes a test, so this is the one
    // capability that genuinely cannot degrade.
    const code = await agentAuthor(BASE, { client: new UnavailableLlmClient('no key') });
    expect(code).toBe(EXIT.LLM_UNAVAILABLE);
    expect(await exists(join(SMOKE, GENERATED))).toBe(false);
  });

  it('requires a goal', async () => {
    await expect(agentAuthor({ ...BASE, goal: undefined })).rejects.toThrow(/--goal/);
  });
});

describe('extractTestTitle', () => {
  it('reads the title the model actually wrote, not the plan title', () => {
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

  it('handles double quotes and backticks', () => {
    expect(extractTestTitle(`test("a gym is found", async () => {});`)).toBe('a gym is found');
    expect(extractTestTitle('test(`a gym is found`, async () => {});')).toBe('a gym is found');
  });

  it('reads through a test modifier', () => {
    expect(extractTestTitle(`test.only('a gym is found', async () => {});`)).toBe('a gym is found');
  });

  it('takes the FIRST test when a spec holds several', () => {
    const spec = `test('first', async () => {});\ntest('second', async () => {});`;
    expect(extractTestTitle(spec)).toBe('first');
  });

  it('declines an interpolated title rather than greping for a literal that cannot match', () => {
    expect(extractTestTitle('test(`gym ${name} is found`, async () => {});')).toBeNull();
  });

  it('is not fooled by the word test inside a describe or a comment', () => {
    const spec = `// this tests the thing\ntest('real title', async () => {});`;
    expect(extractTestTitle(spec)).toBe('real title');
  });

  it('returns null when there is no test at all, so the caller can fall back', () => {
    expect(extractTestTitle('export const x = 1;')).toBeNull();
  });
});
