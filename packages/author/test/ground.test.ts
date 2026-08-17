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
  it('reads the feature from a tests/features/<name>/ path', () => {
    expect(featureKeyOf('tests/features/gyms/gyms.ui.acceptance.spec.ts')).toBe('gyms');
    expect(featureKeyOf('/abs/tests/features/events/x.spec.ts')).toBe('events');
  });

  it('falls back to the filename prefix', () => {
    expect(featureKeyOf('e2e/stores.ui.spec.ts')).toBe('stores');
  });
});

describe('ground — page object selection', () => {
  let bundle: GroundingBundle;
  beforeAll(async () => {
    bundle = await ground({ cwd: root, feature: 'gyms' });
  });

  it('picks the page object, not a sibling that sorts before it', () => {
    // REGRESSION GUARD, found against the real repo: first-match-by-name
    // returned `gyms.card.mapper.ts` and handed the agent one DTO mapper in
    // place of the entire page-object API.
    expect(bundle.pageObjectPath).toContain('gyms.page.ts');
    expect(bundle.pageObjectPath).not.toContain('mapper');
  });

  it('exposes the real methods a goal would need', () => {
    expect(bundle.pageObjectApi.join()).toContain('filterByCounty');
  });

  it('finds the conventions file and the seeded fixtures', () => {
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

  it('takes the first exemplar from the SAME feature', () => {
    expect(bundle.exemplars[0]?.path).toContain('gyms');
  });

  it('takes the second from a genuinely different feature', () => {
    // REGRESSION GUARD: ranking `gyms.api.acceptance.spec.ts` below the
    // same-feature threshold made it look like another feature's file, so the
    // agent got two gyms specs while being told the second showed
    // cross-feature idiom — the one thing it was there to do.
    const second = bundle.exemplars[1];
    expect(second).toBeDefined();
    expect(featureKeyOf(second!.path)).not.toBe('gyms');
  });

  it('does not offer a scaffold when a real spec exists', () => {
    // Templates are deliberately minimal; a two-step placeholder teaches no
    // idiom. Against the real repo `_template` tied on kind and won on
    // alphabetical order.
    for (const exemplar of bundle.exemplars) {
      expect(exemplar.path).not.toContain('_template');
    }
  });

  it('hands over source, not a summary of it', () => {
    expect(bundle.exemplars[0]?.source).toContain('test(');
  });
});

describe('ground — a repository it knows nothing about', () => {
  it('reports what is missing instead of inventing it', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'atest-ground-empty-'));
    const bundle = await ground({ cwd: empty, feature: 'gyms' });

    expect(bundle.pageObjectPath).toBeNull();
    expect(bundle.conventions).toBeNull();
    expect(bundle.exemplars).toHaveLength(0);
    expect(bundle.missing.length).toBeGreaterThan(0);
    expect(bundle.missing.join(' ')).toContain('page object');
  });
});
