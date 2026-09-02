import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadRunBundles, parseEvidenceBundle } from '../src/evidence/store.js';
import { formatFailingStep } from '../src/evidence/types.js';

describe('parseEvidenceBundle', () => {
  it('given null, a bundle missing required fields, or an unsupported schemaVersion -> when parseEvidenceBundle runs -> then it returns null', { tags: ['@unit', '@evidence-store'] }, () => {
    expect(parseEvidenceBundle(null)).toBeNull();
    expect(parseEvidenceBundle({ schemaVersion: 1 })).toBeNull();
    expect(
      parseEvidenceBundle({
        schemaVersion: 2,
        id: 'x',
        test: { title: 't' },
        failure: { kind: 'k' },
      }),
    ).toBeNull();
  });

  it('given a bundle on the current schema with every required field -> when parseEvidenceBundle runs -> then it returns the bundle carrying its id', { tags: ['@unit', '@evidence-store'] }, () => {
    const parsed = parseEvidenceBundle({
      schemaVersion: 1,
      id: 'ev_1',
      test: { title: 'a gym can be found by name' },
      failure: { kind: 'locator_not_found' },
    });
    expect(parsed?.id).toBe('ev_1');
  });
});

describe('formatFailingStep', () => {
  it('given a null step and a failed page-object step -> when formatFailingStep runs -> then it returns null and the rendered page-object call respectively', { tags: ['@unit', '@evidence-store'] }, () => {
    expect(formatFailingStep(null)).toBeNull();
    expect(
      formatFailingStep({
        pageObject: 'gymsPage',
        method: 'expectCardData',
        args: ['011 Grappling'],
        startedAt: '',
        durationMs: 1,
        failed: true,
      }),
    ).toBe('gymsPage.expectCardData(011 Grappling)');
  });
});

describe('loadRunBundles', () => {
  it('given two run directories where the newest holds one valid and one malformed bundle -> when loadRunBundles reads the root -> then it returns the valid bundle from the newest run and reports the malformed file as skipped', { tags: ['@integration', '@evidence-store'] }, async () => {
    const root = await mkdir(join(tmpdir(), `atest-ev-${Date.now()}`), { recursive: true });
    await mkdir(join(root, 'run-a'), { recursive: true });
    await mkdir(join(root, 'run-b'), { recursive: true });

    await writeFile(
      join(root, 'run-b', 'ok.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'ev_ok',
        test: { title: 'ok' },
        failure: { kind: 'locator_not_found' },
      }),
      'utf8',
    );
    await writeFile(join(root, 'run-b', 'bad.json'), '{not json', 'utf8');
    await writeFile(
      join(root, 'run-a', 'old.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'ev_old',
        test: { title: 'old' },
        failure: { kind: 'locator_not_found' },
      }),
      'utf8',
    );

    const loaded = await loadRunBundles(root);
    expect(loaded.runId).toBe('run-b');
    expect(loaded.bundles.map(b => b.id)).toEqual(['ev_ok']);
    expect(loaded.skipped.some(s => s.file === 'bad.json')).toBe(true);
  });
});
