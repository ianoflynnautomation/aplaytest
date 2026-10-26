import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { heal, type HealFlags } from '../src/commands/heal.js';
import { EXIT } from '../src/exit.js';

const TEST_ID = 'gym-card';
const PROJECT = 'chromium';

let out: string[];
let restore: () => void;

beforeEach(() => {
  out = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  restore = () => spy.mockRestore();
});

afterEach(() => restore());

const text = (): string => out.join('');

function proposals(): { status: string }[] {
  const parsed: unknown = JSON.parse(text());
  if (!Array.isArray(parsed)) throw new Error('heal --json did not print a proposal array');
  return parsed as { status: string }[];
}

function flags(root: string, extra: Partial<HealFlags> = {}): HealFlags {
  return {
    evidence: join(root, 'evidence'),
    runs: join(root, 'runs'),
    db: join(root, 'history.sqlite'),
    apply: false,
    dryRun: true,
    json: true,
    noCollateral: true,
    healLedger: join(root, 'heals'),
    force: false,
    noLlm: true,
    minRuns: '10',
    ...extra,
  };
}

async function writeEvidence(root: string): Promise<void> {
  const dir = join(root, 'evidence', 'run-1');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'bundle.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'ev_1',
      test: {
        id: TEST_ID,
        title: 'visitor should see the gym card',
        project: PROJECT,
      },
      failure: { kind: 'locator_not_found' },
      intent: { selector: null, steps: [], failingStep: null, selectorSource: null },
    }),
    'utf8',
  );
}

async function writeRuns(root: string, outcomes: readonly ('passed' | 'failed')[]): Promise<void> {
  const dir = join(root, 'runs');
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  await Promise.all(
    outcomes.map((outcome, index) => {
      const at = new Date(now - (outcomes.length - index) * 60_000).toISOString();
      return writeFile(
        join(dir, `run-${index}.json`),
        JSON.stringify({
          schemaVersion: 1,
          runId: `run-${index}`,
          startedAt: at,
          finishedAt: at,
          commit: null,
          branch: null,
          appEnv: null,
          ci: false,
          workers: 1,
          shard: null,
          atestVersion: '0.1.1',
          playwrightVersion: null,
          attempts: [
            {
              testId: TEST_ID,
              title: 'visitor should see the gym card',
              titlePath: ['gyms'],
              file: 'tests/gyms.spec.ts',
              line: 10,
              project: PROJECT,
              tags: [],
              retry: 0,
              outcome,
              failureKind: null,
              durationMs: 20,
              workerIndex: 0,
              shard: null,
              traceId: null,
              evidenceId: null,
              coScheduled: [],
              routes: [],
            },
          ],
        }),
        'utf8',
      );
    }),
  );
}

describe('heal — flake gate', () => {
  it('given ten alternating outcomes for the failing test -> when heal runs -> then it refuses as flaky before proposing a selector', { tags: ['@integration', '@cli'] }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'atest-heal-flake-'));
    await writeEvidence(root);
    await writeRuns(
      root,
      Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? 'passed' : 'failed')),
    );

    const code = await heal(flags(root));

    expect(code).toBe(EXIT.OK);
    expect(proposals().map(proposal => proposal.status)).toEqual(['refused-flaky']);
  });

  it('given fewer runs than minRuns -> when heal runs -> then the flake gate stays shut and the short sample is not reported as a score', { tags: ['@integration', '@cli'] }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'atest-heal-young-'));
    await writeEvidence(root);
    await writeRuns(root, ['passed', 'failed', 'passed']);

    await heal(flags(root, { json: false }));

    expect(text()).toContain(`flake gate: no scored history under ${join(root, 'runs')}`);
    expect(text()).toContain('refused-ineligible');
    expect(text()).not.toContain('refused-flaky');
  });

  it('given no runs directory -> when heal runs -> then it says the gate saw no scored history and still explains the bundle', { tags: ['@integration', '@cli'] }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'atest-heal-empty-'));
    await writeEvidence(root);

    await heal(flags(root, { json: false }));

    expect(text()).toContain(`flake gate: no scored history under ${join(root, 'runs')}`);
    expect(text()).toContain('refused-ineligible');
  });
});
