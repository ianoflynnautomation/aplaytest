import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ciGenerate } from '../src/commands/ci.js';

async function generate(flags: Parameters<typeof ciGenerate>[0] = { dryRun: false }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atest-ci-'));
  const out = join(dir, 'workflow.yml');
  await ciGenerate({ ...flags, out, dryRun: false });
  return readFile(out, 'utf8');
}

describe('ci generate — the security constraint', () => {
  it('keeps model credentials OUT of the job that runs branch code', async () => {
    // This is the whole reason the workflow has this shape. On a pull request
    // the test job executes specs, fixtures and the Playwright config from the
    // branch — a key there is one commit from exfiltration.
    const yaml = await generate();
    const testJob = yaml.slice(yaml.indexOf('  test:'), yaml.indexOf('  analyze:'));

    expect(testJob).not.toContain('ANTHROPIC_API_KEY');
    expect(testJob).not.toContain('secrets.');
  });

  it('puts the credential in the analyze job, which runs no application code', async () => {
    const yaml = await generate();
    const analyzeJob = yaml.slice(yaml.indexOf('  analyze:'), yaml.indexOf('  policy:'));

    expect(analyzeJob).toContain('ANTHROPIC_API_KEY');
    expect(analyzeJob).not.toContain('playwright test');
  });

  it('makes analyze best-effort so an outage cannot turn red into an incident', async () => {
    const yaml = await generate();
    const analyzeJob = yaml.slice(yaml.indexOf('  analyze:'), yaml.indexOf('  policy:'));
    expect(analyzeJob).toContain('continue-on-error: true');
  });

  it('does NOT make the policy gate best-effort — quarantine hygiene must bite', async () => {
    const yaml = await generate();
    const policyJob = yaml.slice(yaml.indexOf('  policy:'));
    expect(policyJob).not.toContain('continue-on-error');
    expect(policyJob).toContain('flaky expire --ci');
  });
});

describe('ci generate — conventions', () => {
  it('sets persist-credentials: false on every checkout', async () => {
    const yaml = await generate();
    const checkouts = (yaml.match(/actions\/checkout/g) ?? []).length;
    const guards = (yaml.match(/persist-credentials: false/g) ?? []).length;
    expect(guards).toBe(checkouts);
  });

  it('lets actions/* float by tag and hash-pins every third-party action', async () => {
    // Mirrors a real zizmor policy: actions/* may float, everything else must
    // be hash-pinned. Emitting an unpinned third-party action would fail the
    // consumer's own workflow lint.
    //
    // This assertion used to require EVERY action to start with `actions/`,
    // which is not the policy — it forbids third-party actions outright. It
    // then rejected a correctly SHA-pinned `azure/login`, while its own failure
    // message said "must be hash-pinned". A guard whose message and check
    // disagree sends you to fix the wrong thing.
    const yaml = await generate();
    for (const line of yaml.split('\n').filter(l => l.includes('uses:'))) {
      const action = (line.split('uses:')[1] ?? '').split('#')[0]?.trim() ?? '';
      if (action === '' || action.startsWith('actions/')) continue;
      const ref = action.split('@')[1] ?? '';
      expect(/^[0-9a-f]{40}$/.test(ref), `${action} must be pinned to a full commit SHA`).toBe(
        true,
      );
    }
  });

  it('gives every job a timeout', async () => {
    // Scoped to the jobs section: two-space keys also appear under `on:`
    // (pull_request, push, workflow_dispatch), which would over-count.
    const yaml = await generate();
    const jobsSection = yaml.slice(yaml.indexOf('\njobs:'));
    const jobs = (jobsSection.match(/^ {2}\w+:$/gm) ?? []).length;

    expect(jobs).toBe(3);
    expect((yaml.match(/timeout-minutes:/g) ?? []).length).toBe(jobs);
  });

  it('ends with exactly one newline, so it passes yamllint', async () => {
    // A trailing blank line fails yamllint — and in a repo that lints its own
    // workflows, the generated file would break the build it was made for.
    const yaml = await generate();
    expect(yaml.endsWith('\n')).toBe(true);
    expect(yaml.endsWith('\n\n')).toBe(false);
  });

  it('shares one run id across shards so analyze can merge them', async () => {
    const yaml = await generate();
    expect(yaml).toContain('ATEST_RUN_ID');
  });
});

describe('ci generate — options', () => {
  it('honours the shard count', async () => {
    const yaml = await generate({ shards: '3', dryRun: false });
    expect(yaml).toContain('shard: [1, 2, 3]');
    expect(yaml).toContain('--shard=${{ matrix.shard }}/3');
  });

  it('emits a gitlab pipeline with the same split', async () => {
    const yaml = await generate({ provider: 'gitlab', dryRun: false });
    expect(yaml).toContain('stages: [test, analyze, policy]');
    const testStage = yaml.slice(yaml.indexOf('test:'), yaml.indexOf('analyze:'));
    expect(testStage).not.toContain('ANTHROPIC_API_KEY');
  });

  it('rejects an unknown provider rather than emitting something wrong', async () => {
    await expect(generate({ provider: 'jenkins', dryRun: false })).rejects.toThrow(/Unknown provider/);
  });

  it('rejects a nonsense shard count', async () => {
    await expect(generate({ shards: '0', dryRun: false })).rejects.toThrow(/positive integer/);
  });
});

describe('ci generate — reporting', () => {
  it('builds the merged report in analyze, not per shard', async () => {
    // Merging is the whole point; running it per shard would report each
    // quarter of the run as if it were the run.
    const yaml = await generate();
    const analyze = yaml.slice(yaml.indexOf('  analyze:'), yaml.indexOf('  policy:'));
    expect(analyze).toContain('atest report');
    const test = yaml.slice(yaml.indexOf('  test:'), yaml.indexOf('  analyze:'));
    expect(test).not.toContain('atest report');
  });

  it('writes the comment to a FILE, never redirects stdout into one', async () => {
    // `atest report > comment.md` would capture the human summary too. The
    // command puts diagnostics on stderr, but the workflow must not rely on
    // that being true forever.
    const yaml = await generate();
    expect(yaml).toContain('--comment .atest-artifacts/comment.md');
    expect(yaml).not.toMatch(/atest report[^\n]*>\s*\S+\.md/);
  });

  it('posts a comment only on a pull request', async () => {
    const yaml = await generate();
    const step = yaml.slice(yaml.indexOf('Comment on the pull request'));
    expect(step).toContain("github.event_name == 'pull_request'");
  });

  it('updates its previous comment instead of posting one per push', async () => {
    const yaml = await generate();
    expect(yaml).toContain('--edit-last');
  });

  it('uploads the html report as an artifact', async () => {
    const yaml = await generate();
    expect(yaml).toContain('report.html');
  });

  it('grants pull-requests: write only to the job that comments', async () => {
    const yaml = await generate();
    const test = yaml.slice(yaml.indexOf('  test:'), yaml.indexOf('  analyze:'));
    expect(test).not.toContain('pull-requests: write');
  });
});

describe('ci generate — history persistence', () => {
  const analyzeJob = (yaml: string): string =>
    yaml.slice(yaml.indexOf('  analyze:'), yaml.indexOf('  policy:'));

  it('gives flaky analysis a FILE database, not the in-memory default', async () => {
    // With :memory: each run ingests only its own shards, sees one attempt per
    // test, and reports "insufficient data" forever — the engine looks like it
    // works and never says anything.
    const yaml = await generate();
    expect(yaml).toContain('flaky report --db .atest/history.sqlite');
  });

  it('writes history ONLY from main', async () => {
    // A flake baseline describes trunk. A pull request that introduces an
    // unstable test must not enter the baseline before anyone merges it — and
    // restricting writes to one branch removes the concurrent-write race for
    // free.
    const yaml = await generate();
    const persist = yaml.slice(yaml.indexOf('- name: Persist history'));
    expect(persist).toContain("github.ref == 'refs/heads/main'");
    expect(persist).toContain("github.event_name != 'pull_request'");
  });

  it('restores history unconditionally, so pull requests still get scored', async () => {
    const yaml = await generate();
    const restore = yaml.slice(yaml.indexOf('- name: Restore history'), yaml.indexOf('- name: Flaky analysis'));
    expect(restore).not.toContain('refs/heads/main');
  });

  it('makes the upload conditional so overlapping runs cannot clobber each other', async () => {
    const yaml = await generate();
    expect(yaml).toContain('--if-match');
    // The very first write has no ETag to match; --if-none-match '*' fails
    // rather than overwriting a blob another run just created.
    expect(yaml).toContain("--if-none-match '*'");
  });

  it('prunes before uploading, so the blob does not grow without bound', async () => {
    const yaml = await generate();
    const persist = yaml.slice(yaml.indexOf('- name: Persist history'));
    expect(persist.indexOf('history prune')).toBeLessThan(persist.indexOf('blob upload'));
  });

  it('degrades to no history when the storage account is not configured', async () => {
    // Everything else must still work on a repo that has not set this up.
    const yaml = await generate();
    expect(yaml).toContain("vars.ATEST_HISTORY_ACCOUNT != ''");
  });

  it('grants id-token to analyze for OIDC, and never to the test job', async () => {
    const yaml = await generate();
    expect(analyzeJob(yaml)).toContain('id-token: write');
    const test = yaml.slice(yaml.indexOf('  test:'), yaml.indexOf('  analyze:'));
    expect(test).not.toContain('id-token: write');
  });
});
