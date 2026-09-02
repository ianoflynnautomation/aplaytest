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
  it('given a generated workflow -> when the test job is inspected -> then it carries no model credential and no secrets reference', { tags: ['@integration', '@cli'] }, async () => {
    // This is the whole reason the workflow has this shape. On a pull request
    // the test job executes specs, fixtures and the Playwright config from the
    // branch — a key there is one commit from exfiltration.
    const yaml = await generate();
    const testJob = yaml.slice(yaml.indexOf('  test:'), yaml.indexOf('  analyze:'));

    expect(testJob).not.toContain('ANTHROPIC_API_KEY');
    expect(testJob).not.toContain('secrets.');
  });

  it('given a generated workflow -> when the analyze job is inspected -> then the model credential lives there, where no branch code runs', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    const analyzeJob = yaml.slice(yaml.indexOf('  analyze:'), yaml.indexOf('  policy:'));

    expect(analyzeJob).toContain('ANTHROPIC_API_KEY');
    expect(analyzeJob).not.toContain('playwright test');
  });

  it('given a generated workflow -> when the analyze job is inspected -> then it is best-effort, so an outage cannot turn a red build into an incident', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    const analyzeJob = yaml.slice(yaml.indexOf('  analyze:'), yaml.indexOf('  policy:'));
    expect(analyzeJob).toContain('continue-on-error: true');
  });

  it('given a generated workflow -> when the policy job is inspected -> then it is not best-effort, so quarantine hygiene still bites', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    const policyJob = yaml.slice(yaml.indexOf('  policy:'));
    expect(policyJob).not.toContain('continue-on-error');
    expect(policyJob).toContain('flaky expire --ci');
  });
});

describe('ci generate — conventions', () => {
  it('given a generated workflow -> when every checkout step is inspected -> then each sets persist-credentials to false', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    const checkouts = (yaml.match(/actions\/checkout/g) ?? []).length;
    const guards = (yaml.match(/persist-credentials: false/g) ?? []).length;
    expect(guards).toBe(checkouts);
  });

  it('given a generated workflow -> when the action references are inspected -> then first-party actions float by tag and every third-party action is hash-pinned', { tags: ['@integration', '@cli'] }, async () => {
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

  it('given a generated workflow -> when every job is inspected -> then each declares a timeout', { tags: ['@integration', '@cli'] }, async () => {
    // Scoped to the jobs section: two-space keys also appear under `on:`
    // (pull_request, push, workflow_dispatch), which would over-count.
    const yaml = await generate();
    const jobsSection = yaml.slice(yaml.indexOf('\njobs:'));
    const jobs = (jobsSection.match(/^ {2}\w+:$/gm) ?? []).length;

    expect(jobs).toBe(3);
    expect((yaml.match(/timeout-minutes:/g) ?? []).length).toBe(jobs);
  });

  it('given a generated workflow -> when the file ending is inspected -> then it ends with exactly one newline', { tags: ['@integration', '@cli'] }, async () => {
    // A trailing blank line fails yamllint — and in a repo that lints its own
    // workflows, the generated file would break the build it was made for.
    const yaml = await generate();
    expect(yaml.endsWith('\n')).toBe(true);
    expect(yaml.endsWith('\n\n')).toBe(false);
  });

  it('given a generated workflow -> when the shard jobs are inspected -> then they share one run id so analyze can merge them', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    expect(yaml).toContain('ATEST_RUN_ID');
  });
});

describe('ci generate — options', () => {
  it('given a requested shard count -> when the workflow is generated -> then that many shards are emitted', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate({ shards: '3', dryRun: false });
    expect(yaml).toContain('shard: [1, 2, 3]');
    expect(yaml).toContain('--shard=${{ matrix.shard }}/3');
  });

  it('given the gitlab provider -> when the pipeline is generated -> then it carries the same test and analyze split', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate({ provider: 'gitlab', dryRun: false });
    expect(yaml).toContain('stages: [test, analyze, policy]');
    const testStage = yaml.slice(yaml.indexOf('test:'), yaml.indexOf('analyze:'));
    expect(testStage).not.toContain('ANTHROPIC_API_KEY');
  });

  it('given an unknown provider -> when generation runs -> then it is rejected rather than emitting something wrong', { tags: ['@integration', '@cli'] }, async () => {
    await expect(generate({ provider: 'jenkins', dryRun: false })).rejects.toThrow(/Unknown provider/);
  });

  it('given a nonsense shard count -> when generation runs -> then it is rejected', { tags: ['@integration', '@cli'] }, async () => {
    await expect(generate({ shards: '0', dryRun: false })).rejects.toThrow(/positive integer/);
  });
});

describe('ci generate — reporting', () => {
  it('given a generated workflow -> when the report step is located -> then the merged report is built in analyze rather than per shard', { tags: ['@integration', '@cli'] }, async () => {
    // Merging is the whole point; running it per shard would report each
    // quarter of the run as if it were the run.
    const yaml = await generate();
    const analyze = yaml.slice(yaml.indexOf('  analyze:'), yaml.indexOf('  policy:'));
    expect(analyze).toContain('aplaytest report');
    const test = yaml.slice(yaml.indexOf('  test:'), yaml.indexOf('  analyze:'));
    expect(test).not.toContain('aplaytest report');
  });

  it('given a generated workflow -> when the comment step is inspected -> then the comment is written to a file rather than redirected from stdout', { tags: ['@integration', '@cli'] }, async () => {
    // `aplaytest report > comment.md` would capture the human summary too. The
    // command puts diagnostics on stderr, but the workflow must not rely on
    // that being true forever.
    const yaml = await generate();
    expect(yaml).toContain('--comment .atest-artifacts/comment.md');
    expect(yaml).not.toMatch(/aplaytest report[^\n]*>\s*\S+\.md/);
  });

  it('given a generated workflow -> when the comment step is inspected -> then it is conditioned on a pull request', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    const step = yaml.slice(yaml.indexOf('Comment on the pull request'));
    expect(step).toContain("github.event_name == 'pull_request'");
  });

  it('given a generated workflow -> when the comment step is inspected -> then it updates the previous comment rather than posting one per push', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    expect(yaml).toContain('--edit-last');
  });

  it('given a generated workflow -> when the artifact steps are inspected -> then the html report is uploaded', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    expect(yaml).toContain('report.html');
  });

  it('given a generated workflow -> when the job permissions are inspected -> then pull-requests write is granted only to the commenting job', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    const test = yaml.slice(yaml.indexOf('  test:'), yaml.indexOf('  analyze:'));
    expect(test).not.toContain('pull-requests: write');
  });
});

describe('ci generate — history persistence', () => {
  const analyzeJob = (yaml: string): string =>
    yaml.slice(yaml.indexOf('  analyze:'), yaml.indexOf('  policy:'));

  it('given a configured storage account -> when the workflow is generated -> then analyze points at a persistent store rather than the in-memory default', { tags: ['@integration', '@cli'] }, async () => {
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
  it('given a generated workflow -> when the history steps are inspected -> then no download or upload round trip exists, because the container is the store', { tags: ['@integration', '@cli'] }, async () => {
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
  it('given a workflow condition on the branch name -> when an empty branch string is considered -> then read-only is not selected, so it cannot apply always', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    // Scoped to the expression itself. The comment above it in the template
    // quotes the broken form as the thing not to write, and a whole-file match
    // would fail on the warning rather than on the bug.
    const line = yaml.split('\n').find(l => l.includes('ATEST_HISTORY_URL:')) ?? '';
    expect(line).not.toMatch(/&&\s*''\s*\|\|\s*'\?readonly=1'/);
    expect(line).toContain("&& '?readonly=1' || ''");
  });

  it('given a generated workflow -> when the analyze step is inspected off main -> then the store is opened read-only so a pull request cannot amend the baseline', { tags: ['@integration', '@cli'] }, async () => {
    // A flake baseline describes trunk. A pull request that introduces an
    // unstable test must not enter the baseline before anyone merges it. Said
    // up front rather than left to a 403 per shard file.
    const yaml = await generate();
    expect(yaml).toContain('?readonly=1');
    expect(analyzeJob(yaml)).toContain("github.ref == 'refs/heads/main'");
  });

  it('given a generated workflow -> when the analyze job is inspected off main -> then analysis still runs rather than being skipped', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    const analysis = yaml.slice(yaml.indexOf('- name: Flaky analysis'));
    // The step itself is unconditional; only the URL it is given differs.
    expect(analysis.slice(0, analysis.indexOf('run:'))).not.toContain('if:');
  });

  it('given a generated workflow -> when the prune step is inspected -> then it runs only from main, where the store is writable', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    const trim = yaml.slice(yaml.indexOf('- name: Trim history'));
    expect(trim).toContain("github.ref == 'refs/heads/main'");
    expect(trim).toContain("github.event_name != 'pull_request'");
    expect(trim).toContain('history prune');
  });

  it('given a generated workflow -> when the analyze credentials are inspected -> then main uses the writer identity and other branches use the pull-request identity', { tags: ['@integration', '@cli'] }, async () => {
    // The two are different user-assigned identities on purpose: only the
    // main-branch one is granted Contributor, so "pull requests cannot write
    // history" is enforced by Entra rather than by this YAML file.
    const yaml = await generate();
    const login = yaml.slice(yaml.indexOf('- name: Log in to Azure'));
    expect(login).toContain('ATEST_HISTORY_CLIENT_ID');
    expect(login).toContain('AZURE_CLIENT_ID');
  });

  it('given no configured storage account -> when the workflow is generated -> then it degrades to no history rather than emitting a broken store URL', { tags: ['@integration', '@cli'] }, async () => {
    // Everything else must still work on a repo that has not set this up.
    const yaml = await generate();
    expect(yaml).toContain("vars.ATEST_HISTORY_ACCOUNT != ''");
  });

  it('given a generated workflow -> when the job permissions are inspected -> then id-token is granted to analyze for OIDC and never to the test job', { tags: ['@integration', '@cli'] }, async () => {
    const yaml = await generate();
    expect(analyzeJob(yaml)).toContain('id-token: write');
    const test = yaml.slice(yaml.indexOf('  test:'), yaml.indexOf('  analyze:'));
    expect(test).not.toContain('id-token: write');
  });
});
