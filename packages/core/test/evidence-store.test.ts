import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadRunBundles, parseEvidenceBundle } from '../src/evidence/store.js';
import { formatFailingStep } from '../src/evidence/types.js';

describe('parseEvidenceBundle', () => {
  it('rejects a value that is not a bundle', () => {
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

  it('accepts a bundle with the current schema and required fields', () => {
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
  it('renders a page-object call or null', () => {
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
  it('loads the newest run by name and skips unreadable files', async () => {
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
