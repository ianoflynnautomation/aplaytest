import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { patchConstant } from '../src/patch.js';
import { buildRecord, revertHeal, writeRecord } from '../src/ledger.js';
import type { HealProposal } from '../src/propose.js';

const CONSTANTS = `export const GYM_CARD_TEST_IDS = {
  name: 'gym-card-name',
} as const;

export const TEST_IDS = {
  cardName: 'gym-card-name',
} as const;
`;

describe('buildRecord', () => {
  it('given a patch that rewrote a shared literal -> when buildRecord runs -> then from is the literal, not a scraped message or the full locator', { tags: ['@unit', '@heal'] }, () => {
    const patch = patchConstant(CONSTANTS, {
      file: 'gyms.constants.ts',
      from: 'gym-card-name',
      to: 'gym-card-title',
    });
    const record = buildRecord(proposal(patch), context());

    expect(record).not.toBeNull();
    expect(record?.patch.from).toBe('gym-card-name');
    expect(record?.patch.to).toBe('gym-card-title');
    expect(record?.patch.constants).toEqual(expect.arrayContaining(['GYM_CARD_TEST_IDS.name', 'TEST_IDS.cardName']));
  });
});

describe('revertHeal', () => {
  it('given a heal that updated two constants sharing one literal -> when revertHeal runs -> then the file is restored rather than refused as changed', { tags: ['@unit', '@heal'] }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atest-heal-ledger-'));
    const file = join(dir, 'gyms.constants.ts');
    const patch = patchConstant(CONSTANTS, { file, from: 'gym-card-name', to: 'gym-card-title' });
    expect(patch.after).not.toBeNull();
    await writeFile(file, patch.after ?? '', 'utf8');

    const record = buildRecord(proposal(patch), context());
    expect(record).not.toBeNull();
    await writeRecord(record!, dir);

    const result = await revertHeal(record!.healId, { dir });

    expect(result.status).toBe('reverted');
    expect(await readFile(file, 'utf8')).toBe(CONSTANTS);
  });
});

function candidate() {
  return {
    value: 'gym-card-title',
    expression: "getByTestId('gym-card-title')",
    strategy: 'testid' as const,
    stabilityRank: 1,
    semanticDistance: 0.1,
    stabilityDelta: 0,
    score: 0.9,
  };
}

function context() {
  return {
    project: 'chromium',
    failureKind: 'locator_not_found',
    atestVersion: '0.1.0',
    testFile: 'tests/gyms.spec.ts',
  };
}

function proposal(patch: ReturnType<typeof patchConstant>): HealProposal {
  return {
    status: 'proposed',
    evidenceId: 'ev_abc123abc123',
    testTitle: 'shows the gym name',
    reason: 'selector renamed',
    intendedSelector: "getByTestId('gym-card-name')",
    candidates: [candidate()],
    chosen: candidate(),
    patch,
    validation: null,
    tierOne: null,
  };
}
