import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { featureKeyOf, ground, type GroundingBundle } from '../src/ground.js';

let root: string;

async function write(relative: string, content: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atest-ground-'));

  await write('CLAUDE.md', '# Conventions\nWeb-first assertions only.');

  // The real repo's shape: a page object with siblings that share its name.
  await write(
    'src/ui/pages/gyms/gyms.card.mapper.ts',
    'export function gymCardFromDto(gym: GymDto): GymCard { return gym; }',
  );
  await write('src/ui/pages/gyms/gyms.constants.ts', 'export const TEST_IDS = {};');
  await write(
    'src/ui/pages/gyms/gyms.page.ts',
    `export async function goTo(page: Page): Promise<void> {}
export async function filterByCounty(page: Page, county: string): Promise<void> {}`,
  );

  await write('tests/testdata/seeded/gyms.ts', "export const SEEDED_GYM = { name: 'X' };");

  await write(
    'tests/features/_template/_template.ui.acceptance.spec.ts',
    "import { test } from '@ui/fixtures';\ntest('placeholder', async () => {});",
  );
  await write(
    'tests/features/gyms/gyms.ui.acceptance.spec.ts',
    "import { test } from '@ui/fixtures';\ntest('gyms list loads', async ({ gymsPage }) => {});",
  );
  await write(
    'tests/features/gyms/gyms.api.acceptance.spec.ts',
    "import { test } from '@api/fixtures';\ntest('gyms api', async () => {});",
  );
  await write(
    'tests/features/events/events.ui.acceptance.spec.ts',
    `import { test } from '@ui/fixtures';
test.describe('Events', { tag: ['@ui'] }, () => {
  test('events list loads', async ({ eventsPage }) => {
    await eventsPage.navigate();
    await eventsPage.verifyIsLoaded();
  });
});`,
  );
});

describe('featureKeyOf', () => {
  it('given a path under tests/features/<name>/ -> when featureKeyOf reads it -> then the feature directory name is returned', { tags: ['@unit', '@author'] }, () => {
    expect(featureKeyOf('tests/features/gyms/gyms.ui.acceptance.spec.ts')).toBe('gyms');
    expect(featureKeyOf('/abs/tests/features/events/x.spec.ts')).toBe('events');
  });

  it('given a path outside tests/features -> when featureKeyOf reads it -> then the feature falls back to the filename prefix', { tags: ['@unit', '@author'] }, () => {
    expect(featureKeyOf('e2e/stores.ui.spec.ts')).toBe('stores');
  });
});

describe('ground — page object selection', () => {
  let bundle: GroundingBundle;
  beforeAll(async () => {
    bundle = await ground({ cwd: root, feature: 'gyms' });
  });

  it('given a feature whose page object has siblings sorting before it -> when ground selects the page object -> then it picks gyms.page.ts rather than the mapper', { tags: ['@integration', '@author'] }, () => {
    // REGRESSION GUARD, found against the real repo: first-match-by-name
    // returned `gyms.card.mapper.ts` and handed the agent one DTO mapper in
    // place of the entire page-object API.
    expect(bundle.pageObjectPath).toContain('gyms.page.ts');
    expect(bundle.pageObjectPath).not.toContain('mapper');
  });

  it('given a page object exporting several methods -> when ground builds the bundle -> then the page-object API lists the real method signatures', { tags: ['@integration', '@author'] }, () => {
    expect(bundle.pageObjectApi.join()).toContain('filterByCounty');
  });

  it('given a repo with CLAUDE.md and seeded testdata -> when ground builds the bundle -> then the conventions and seeded fixture paths are resolved', { tags: ['@integration', '@author'] }, () => {
    expect(bundle.conventionsPath).toBe('CLAUDE.md');
    expect(bundle.seededDataPath).toContain('gyms.ts');
    expect(bundle.conventions).toContain('Web-first');
  });
});

describe('ground — exemplar selection', () => {
  let bundle: GroundingBundle;
  beforeAll(async () => {
    bundle = await ground({ cwd: root, feature: 'gyms' });
  });

  it('given a repo holding specs for several features -> when ground selects exemplars -> then the first comes from the same feature', { tags: ['@integration', '@author'] }, () => {
    expect(bundle.exemplars[0]?.path).toContain('gyms');
  });

  it('given a repo holding specs for several features -> when ground selects exemplars -> then the second comes from a genuinely different feature', { tags: ['@integration', '@author'] }, () => {
    // REGRESSION GUARD: ranking `gyms.api.acceptance.spec.ts` below the
    // same-feature threshold made it look like another feature's file, so the
    // agent got two gyms specs while being told the second showed
    // cross-feature idiom — the one thing it was there to do.
    const second = bundle.exemplars[1];
    expect(second).toBeDefined();
    expect(featureKeyOf(second!.path)).not.toBe('gyms');
  });

  it('given a repo holding both a _template scaffold and real specs -> when ground selects exemplars -> then no scaffold is offered', { tags: ['@integration', '@author'] }, () => {
    // Templates are deliberately minimal; a two-step placeholder teaches no
    // idiom. Against the real repo `_template` tied on kind and won on
    // alphabetical order.
    for (const exemplar of bundle.exemplars) {
      expect(exemplar.path).not.toContain('_template');
    }
  });

  it('given a selected exemplar -> when ground builds the bundle -> then the verbatim spec source is carried, not a summary', { tags: ['@integration', '@author'] }, () => {
    expect(bundle.exemplars[0]?.source).toContain('test(');
  });
});

describe('ground — a repository it knows nothing about', () => {
  it('given an empty repository -> when ground builds the bundle -> then the page object, conventions and exemplars are absent and the gaps are named', { tags: ['@integration', '@author'] }, async () => {
    const empty = await mkdtemp(join(tmpdir(), 'atest-ground-empty-'));
    const bundle = await ground({ cwd: empty, feature: 'gyms' });

    expect(bundle.pageObjectPath).toBeNull();
    expect(bundle.conventions).toBeNull();
    expect(bundle.exemplars).toHaveLength(0);
    expect(bundle.missing.length).toBeGreaterThan(0);
    expect(bundle.missing.join(' ')).toContain('page object');
  });
});
