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

  it('gives flaky analysis a PERSISTENT store, not the in-memory default', async () => {
    // With :memory: each run ingests only its own shards, sees one attempt per
    // test, and reports "insufficient data" forever — the engine looks like it
    // works and never says anything.
    const yaml = await generate();
    expect(yaml).toContain('ATEST_HISTORY_URL');
    expect(yaml).toContain('azblob://');
  });

  /**
   * REGRESSION GUARD. The previous design downloaded one history.sqlite,
   * ingested into it, and re-uploaded under an If-Match precondition. Two
   * overlapping main-branch runs meant one lost the ETag race — failing the
   * step at best, discarding the other run's attempts at worst. The blob
   * layout writes one immutable object per run and shard instead, so if a
   * download/upload pair ever reappears here, the race came back with it.
   */
  it('has no download/upload round trip at all — the store IS the container', async () => {
    const yaml = await generate();
    expect(yaml).not.toContain('az storage blob download');
    expect(yaml).not.toContain('az storage blob upload');
    expect(yaml).not.toContain('--if-match');
    expect(yaml).not.toContain('history.sqlite');
  });

  /**
   * REGRESSION GUARD for a GitHub Actions expression trap.
   *
   * `on-main && '' || '?readonly=1'` reads as a ternary and is not: the empty
   * string is FALSY, so `||` always fires and every branch — main included —
   * opens the store read-only. History is then never written, and the only
   * symptom is flake verdicts reading "insufficient data" forever, which is
   * also exactly what a correctly working new store says. Nothing goes red.
   *
   * The fix is to select the read-only case with the POSITIVE condition, so
   * the truthy branch is the non-empty string.
   */
  it('does not select read-only with an empty-string branch, which would apply it always', async () => {
    const yaml = await generate();
    // Scoped to the expression itself. The comment above it in the template
    // quotes the broken form as the thing not to write, and a whole-file match
    // would fail on the warning rather than on the bug.
    const line = yaml.split('\n').find(l => l.includes('ATEST_HISTORY_URL:')) ?? '';
    expect(line).not.toMatch(/&&\s*''\s*\|\|\s*'\?readonly=1'/);
    expect(line).toContain("&& '?readonly=1' || ''");
  });

  it('opens the store read-only off main, so a pull request cannot amend the baseline', async () => {
    // A flake baseline describes trunk. A pull request that introduces an
    // unstable test must not enter the baseline before anyone merges it. Said
    // up front rather than left to a 403 per shard file.
    const yaml = await generate();
    expect(yaml).toContain('?readonly=1');
    expect(analyzeJob(yaml)).toContain("github.ref == 'refs/heads/main'");
  });

  it('still scores pull requests, rather than skipping analysis off main', async () => {
    const yaml = await generate();
    const analysis = yaml.slice(yaml.indexOf('- name: Flaky analysis'));
    // The step itself is unconditional; only the URL it is given differs.
    expect(analysis.slice(0, analysis.indexOf('run:'))).not.toContain('if:');
  });

  it('prunes only from main, where the store is writable', async () => {
    const yaml = await generate();
    const trim = yaml.slice(yaml.indexOf('- name: Trim history'));
    expect(trim).toContain("github.ref == 'refs/heads/main'");
    expect(trim).toContain("github.event_name != 'pull_request'");
    expect(trim).toContain('history prune');
  });

  it('uses the main-only writer identity for main, and the PR identity otherwise', async () => {
    // The two are different user-assigned identities on purpose: only the
    // main-branch one is granted Contributor, so "pull requests cannot write
    // history" is enforced by Entra rather than by this YAML file.
    const yaml = await generate();
    const login = yaml.slice(yaml.indexOf('- name: Log in to Azure'));
    expect(login).toContain('ATEST_HISTORY_CLIENT_ID');
    expect(login).toContain('AZURE_CLIENT_ID');
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
