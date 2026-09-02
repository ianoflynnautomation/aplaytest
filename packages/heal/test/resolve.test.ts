import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyHealTarget, globToRegExp, resolveSelectorSource } from '../src/resolve.js';

describe('classifyHealTarget', () => {
  it('given constants, page object, section and spec paths -> when classifyHealTarget reads each -> then every path is classified to its reviewable kind', { tags: ['@unit', '@heal'] }, () => {
    expect(classifyHealTarget('src/ui/pages/gyms/gyms.constants.ts')).toBe('constants');
    expect(classifyHealTarget('src/ui/pages/gyms/gyms.page.ts')).toBe('page-object');
    expect(classifyHealTarget('src/ui/sections/footer.section.ts')).toBe('page-object');
    expect(classifyHealTarget('tests/features/gyms/gyms.snapshot.acceptance.spec.ts')).toBe('spec');
  });
});

describe('globToRegExp', () => {
  it('given the default heal.targets globs -> when globToRegExp compiles them -> then constants and spec paths match while a page object does not', { tags: ['@unit', '@heal'] }, () => {
    const constants = globToRegExp('src/**/*.constants.ts');
    expect(constants.test('src/ui/pages/gyms/gyms.constants.ts')).toBe(true);
    expect(constants.test('src/ui/pages/gyms/gyms.page.ts')).toBe(false);

    const specs = globToRegExp('tests/**/*.spec.ts');
    expect(specs.test('tests/features/gyms/gyms.snapshot.acceptance.spec.ts')).toBe(true);
  });
});

describe('resolveSelectorSource', () => {
  it('given a literal present in both a constants file and a spec -> when resolveSelectorSource runs -> then the constants file is preferred', { tags: ['@integration', '@heal'] }, async () => {
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

  it('given a literal present only inline in a spec -> when resolveSelectorSource runs -> then the spec is resolved with an anonymous binding path', { tags: ['@integration', '@heal'] }, async () => {
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
