import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyHealTarget, globToRegExp, resolveSelectorSource } from '../src/resolve.js';

describe('classifyHealTarget', () => {
  it('prefers the reviewable file, matching the bjjeire layout', () => {
    expect(classifyHealTarget('src/ui/pages/gyms/gyms.constants.ts')).toBe('constants');
    expect(classifyHealTarget('src/ui/pages/gyms/gyms.page.ts')).toBe('page-object');
    expect(classifyHealTarget('src/ui/sections/footer.section.ts')).toBe('page-object');
    expect(classifyHealTarget('tests/features/gyms/gyms.snapshot.acceptance.spec.ts')).toBe('spec');
  });
});

describe('globToRegExp', () => {
  it('matches the default heal.targets globs', () => {
    const constants = globToRegExp('src/**/*.constants.ts');
    expect(constants.test('src/ui/pages/gyms/gyms.constants.ts')).toBe(true);
    expect(constants.test('src/ui/pages/gyms/gyms.page.ts')).toBe(false);

    const specs = globToRegExp('tests/**/*.spec.ts');
    expect(specs.test('tests/features/gyms/gyms.snapshot.acceptance.spec.ts')).toBe(true);
  });
});

describe('resolveSelectorSource', () => {
  it('prefers the constants file when the literal also appears in a spec', async () => {
    const root = await mkdir(join(tmpdir(), `atest-resolve-${Date.now()}`), { recursive: true });
    await mkdir(join(root, 'src/ui/pages/gyms'), { recursive: true });
    await mkdir(join(root, 'tests/features/gyms'), { recursive: true });

    await writeFile(
      join(root, 'src/ui/pages/gyms/gyms.constants.ts'),
      `export const TEST_IDS = { header: 'gyms-page-header' } as const;\n`,
      'utf8',
    );
    await writeFile(
      join(root, 'tests/features/gyms/gyms.snapshot.acceptance.spec.ts'),
      `await expect(page.getByTestId('gyms-page-header')).toHaveScreenshot('gyms-header.png');\n`,
      'utf8',
    );

    const resolved = await resolveSelectorSource({ cwd: root, value: 'gyms-page-header' });
    expect(resolved?.kind).toBe('constants');
    expect(resolved?.file).toBe('src/ui/pages/gyms/gyms.constants.ts');
  });

  it('falls back to a spec-inline locator when there is no constants file', async () => {
    const root = await mkdir(join(tmpdir(), `atest-resolve-spec-${Date.now()}`), { recursive: true });
    await mkdir(join(root, 'tests/features/gyms'), { recursive: true });
    await writeFile(
      join(root, 'tests/features/gyms/gyms.snapshot.acceptance.spec.ts'),
      `await expect(page.getByTestId('no-data-state')).toMatchAriaSnapshot({ name: 'empty.aria.yml' });\n`,
      'utf8',
    );

    const resolved = await resolveSelectorSource({ cwd: root, value: 'no-data-state' });
    expect(resolved?.kind).toBe('spec');
    expect(resolved?.hits[0]?.path).toBe('(anonymous)');
  });
});
