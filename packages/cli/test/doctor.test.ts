import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { doctor } from '../src/commands/doctor.js';
import { EXIT } from '../src/exit.js';

let out: string[];
let restore: () => void;

beforeEach(() => {
  out = [];
  const write = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  restore = () => {
    spy.mockRestore();
    void write;
  };
});

afterEach(() => restore());

const text = (): string => out.join('');

describe('doctor', () => {
  it('given a project directory named by --cwd -> when doctor runs -> then it diagnoses that directory rather than the process cwd', { tags: ['@integration', '@cli'] }, async () => {
    // REGRESSION GUARD: doctor ignored --cwd while every other command honoured
    // it, so `aplaytest doctor --cwd ../suite` reported the wrong repo's Playwright
    // version and every file as missing — the most misleading answer a
    // diagnostic can give.
    const root = await mkdtemp(join(tmpdir(), 'atest-doctor-'));
    await writeFile(join(root, 'playwright.config.ts'), 'export default {};', 'utf8');
    await writeFile(join(root, 'CLAUDE.md'), '# Conventions', 'utf8');

    const code = await doctor({ runs: '.atest/runs', ledger: '.atest/q.json', cwd: root });

    expect(code).toBe(EXIT.OK);
    expect(text()).toContain('playwright.config.ts');
    expect(text()).toContain('CLAUDE.md');
  });

  it('given a directory holding no Playwright config -> when doctor runs -> then it warns, because the gate, heal and bisect all spawn Playwright', { tags: ['@integration', '@cli'] }, async () => {
    // The gate, heal and bisect all spawn Playwright; without a config they
    // fail several layers away and atest gets the blame.
    const empty = await mkdtemp(join(tmpdir(), 'atest-doctor-empty-'));
    await doctor({ runs: '.atest/runs', ledger: '.atest/q.json', cwd: empty });

    expect(text()).toContain('playwright config');
    expect(text()).toMatch(/none found/);
  });

  it('given no model key configured -> when doctor runs -> then it names the one capability the missing key actually costs', { tags: ['@integration', '@cli'] }, async () => {
    // "deterministic features unaffected" read as "nothing is lost". Authoring
    // is genuinely unavailable without a model, and saying so is the point.
    const empty = await mkdtemp(join(tmpdir(), 'atest-doctor-key-'));
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await doctor({ runs: '.atest/runs', ledger: '.atest/q.json', cwd: empty });
    vi.unstubAllEnvs();

    expect(text()).toContain('agent author');
    expect(text()).toContain('gate');
  });

  it('given a named feature and a repository holding its files -> when doctor runs -> then the grounding for that feature is reported', { tags: ['@integration', '@cli'] }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'atest-doctor-feat-'));
    await mkdir(join(root, 'src/ui/pages/gyms'), { recursive: true });
    await writeFile(
      join(root, 'src/ui/pages/gyms/gyms.page.ts'),
      'export async function goTo(page: Page): Promise<void> {}',
      'utf8',
    );

    await doctor({ runs: '.atest/runs', ledger: '.atest/q.json', cwd: root, feature: 'gyms' });

    expect(text()).toContain('page object (gyms)');
    expect(text()).toContain('gyms.page.ts');
  });

  it('given a directory producing only warnings -> when doctor runs -> then the exit code stays 0, because a warning is not a broken install', { tags: ['@integration', '@cli'] }, async () => {
    const empty = await mkdtemp(join(tmpdir(), 'atest-doctor-warn-'));
    expect(await doctor({ runs: '.atest/runs', ledger: '.atest/q.json', cwd: empty })).toBe(EXIT.OK);
  });
});
