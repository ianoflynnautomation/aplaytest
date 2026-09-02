/**
 * `aplaytest ci generate` — emit a workflow for a consumer repository.
 *
 * The whole shape exists to serve one constraint: THE JOB THAT RUNS TESTS AND
 * THE JOB THAT HOLDS MODEL CREDENTIALS MUST BE DIFFERENT JOBS.
 *
 * On a pull request the test job executes code from the branch — specs,
 * fixtures, the Playwright config. If a model API key were in that job's
 * environment, a one-line change to any of those files exfiltrates it. The
 * analyze job holds the key and executes no application code at all; it only
 * reads artifacts.
 *
 * Three smaller properties follow from the same reasoning:
 *   · the merge gate is deterministic, because the job deciding pass/fail
 *     cannot call a model
 *   · analyze runs once per workflow rather than once per shard
 *   · a provider outage cannot turn a red build into an incident, because
 *     analyze is continue-on-error
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { EXIT, UsageError, type ExitCode } from '../exit.js';
import { heading, line, style } from '../ui/output.js';

export interface CiFlags {
  readonly provider?: string | undefined;
  readonly out?: string | undefined;
  readonly shards?: string | undefined;
  readonly projects?: string | undefined;
  readonly nodeVersion?: string | undefined;
  readonly playwrightImage?: string | undefined;
  readonly dryRun: boolean;
}

interface TemplateOptions {
  readonly shards: number;
  readonly projects: readonly string[];
  readonly nodeVersion: string;
  readonly playwrightImage: string;
}

function githubWorkflow(options: TemplateOptions): string {
  const matrix =
    options.projects.length > 0
      ? `\n        project: [${options.projects.map(p => `'${p}'`).join(', ')}]`
      : '';

  // Artifact names must vary with EVERY matrix axis. With a project matrix,
  // `atest-<shard>` collides across projects: two jobs upload the same name,
  // and the download step merges them into one directory where identical run
  // records overwrite each other.
  const artifactSuffix =
    options.projects.length > 0
      ? `\${{ matrix.project }}-\${{ matrix.shard }}`
      : `\${{ matrix.shard }}`;

  return `name: Acceptance (atest)

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  # ── EXECUTE ────────────────────────────────────────────────────────────────
  # Runs branch code. Deliberately has NO model credentials: on a pull request
  # this job executes specs, fixtures and the Playwright config from the branch,
  # so a key here would be one commit away from exfiltration.
  test:
    name: test (shard \${{ matrix.shard }})
    runs-on: ubuntu-latest
    timeout-minutes: 30
    container: ${options.playwrightImage}
    strategy:
      fail-fast: false
      matrix:
        shard: [${Array.from({ length: options.shards }, (_, i) => i + 1).join(', ')}]${matrix}
    env:
      CI: 'true'
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: '${options.nodeVersion}'
          cache: 'npm'

      - run: npm ci

      # Every shard shares one run id, so the analyze job can merge them.
      # Only the runtime knows it — a value in playwright.config.ts cannot vary
      # per invocation, which is why the reporter lets the environment win.
      - name: Run acceptance tests
        env:
          ATEST_RUN_ID: \${{ github.run_id }}-\${{ github.run_attempt }}
        run: npx playwright test --shard=\${{ matrix.shard }}/${options.shards}

      - uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: atest-${artifactSuffix}
          path: |
            .atest/runs/
            .atest/evidence/
          retention-days: 7

  # ── ANALYZE ────────────────────────────────────────────────────────────────
  # Holds credentials, executes no application code. Best-effort by design: a
  # provider outage must not turn a red build into an infrastructure incident.
  analyze:
    name: Analyze
    needs: test
    if: \${{ !cancelled() }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    continue-on-error: true
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    env:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: '${options.nodeVersion}'
          cache: 'npm'

      - run: npm ci --ignore-scripts

      - uses: actions/download-artifact@v4
        with:
          pattern: atest-*
          path: .atest-artifacts
          merge-multiple: true

      # ── HISTORY ────────────────────────────────────────────────────────
      # Flake statistics need many runs. With the default in-memory store each
      # run sees one attempt per test and reports "insufficient data" forever —
      # the engine looks like it works and never says anything.
      #
      # There is no download and no upload step: the store IS the container.
      # Records are written as one immutable object per run and shard, so two
      # shards and two overlapping main-branch runs never collide and nothing
      # needs an ETag precondition. See docs/12-azure-history.md.
      #
      # MAIN WRITES, PULL REQUESTS READ. That is not only concurrency control
      # (which the naming scheme gives for free): a flake baseline should
      # describe trunk. A pull request that introduces an unstable test must
      # not enter the baseline before anyone has decided to merge it. The PR
      # identity holds Storage Blob Data Reader, and \`?readonly=1\` says so up
      # front rather than discovering it as a 403 per shard file.
      - name: Log in to Azure
        if: \${{ vars.ATEST_HISTORY_ACCOUNT != '' }}
        # SHA-pinned. The zizmor policy lets actions/* float on a tag and
        # requires a hash for everything else.
        uses: azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5 # v2.3.0
        with:
          client-id: \${{ github.ref == 'refs/heads/main' && vars.ATEST_HISTORY_CLIENT_ID != '' && vars.ATEST_HISTORY_CLIENT_ID || vars.AZURE_CLIENT_ID }}
          tenant-id: \${{ vars.AZURE_TENANT_ID }}
          subscription-id: \${{ vars.AZURE_SUBSCRIPTION_ID }}

      # Deterministic: runs with or without a model key. Unset
      # ATEST_HISTORY_ACCOUNT and everything still works, scored against this
      # run alone — persistence is the feature that degrades, not the job.
      #
      # \`?readonly=1\` is selected by the POSITIVE condition, never by
      # \`on-main && '' || '?readonly=1'\`. That reads as a ternary and is not:
      # an empty string is falsy, so the \`||\` always fires and main would open
      # the store read-only too. History would silently never be written, and
      # the only symptom is "insufficient data" forever — which is also what a
      # correctly working new store says.
      - name: Flaky analysis
        env:
          ATEST_HISTORY_URL: \${{ vars.ATEST_HISTORY_ACCOUNT != '' && format('azblob://{0}/atest-history{1}', vars.ATEST_HISTORY_ACCOUNT, (github.ref != 'refs/heads/main' || github.event_name == 'pull_request') && '?readonly=1' || '') || '' }}
        run: npx aplaytest flaky report --runs .atest-artifacts/runs

      - name: Propose heals
        run: npx aplaytest heal --evidence .atest-artifacts/evidence --dry-run || true

      # Merges every shard into one view. Writes the comment to a file rather
      # than stdout so the human summary on stderr cannot end up inside it.
      - name: Build report
        run: |
          npx aplaytest report \\
            --runs .atest-artifacts/runs \\
            --evidence .atest-artifacts/evidence \\
            --comment .atest-artifacts/comment.md \\
            --out .atest-artifacts/report.html

      - uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: atest-report
          path: .atest-artifacts/report.html
          retention-days: 14

      # Retention. The account also carries a lifecycle-management policy doing
      # the same thing on a schedule, so this is a convenience, not the only
      # guard — and it is main-only because a read-only store refuses to prune
      # rather than deleting nothing and reporting success.
      - name: Trim history
        if: \${{ vars.ATEST_HISTORY_ACCOUNT != '' && github.ref == 'refs/heads/main' && github.event_name != 'pull_request' }}
        env:
          ATEST_HISTORY_URL: azblob://\${{ vars.ATEST_HISTORY_ACCOUNT }}/atest-history
        run: |
          npx aplaytest history prune --keep-days 90
          npx aplaytest history stats

      # Edit the existing comment when there is one, so a busy PR gets a single
      # updating comment instead of one per push. \`--edit-last\` fails when none
      # exists yet; the fallback covers that without depending on a gh version
      # new enough for --create-if-none.
      - name: Comment on the pull request
        if: \${{ github.event_name == 'pull_request' }}
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ github.event.number }}
        run: |
          gh pr comment "$PR" --body-file .atest-artifacts/comment.md --edit-last \\
            || gh pr comment "$PR" --body-file .atest-artifacts/comment.md

  # ── POLICY ─────────────────────────────────────────────────────────────────
  # The ONLY place new rules may block a merge, so the blocking surface stays
  # small and explicit. Not continue-on-error: quarantine hygiene has to bite.
  policy:
    name: Policy
    needs: analyze
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: '${options.nodeVersion}'
          cache: 'npm'

      - run: npm ci --ignore-scripts

      # Exits 4 on an expired quarantine or a breached budget. Quarantines
      # expire so they get fixed rather than accumulating.
      - name: Quarantine hygiene
        run: npx aplaytest flaky expire --ci
`;
}

function gitlabWorkflow(options: TemplateOptions): string {
  return `# Generated by \`aplaytest ci generate --provider gitlab\`.
#
# Same constraint as the GitHub template: the job that runs tests and the job
# that holds model credentials are different jobs. On a merge request the test
# job executes branch code, so a key there would be one commit from exposure.

stages: [test, analyze, policy]

variables:
  ATEST_RUN_ID: "\${CI_PIPELINE_ID}"

test:
  stage: test
  image: ${options.playwrightImage}
  parallel: ${options.shards}
  script:
    - npm ci
    - npx playwright test --shard=\$CI_NODE_INDEX/\$CI_NODE_TOTAL
  artifacts:
    when: always
    paths:
      - .atest/runs/
      - .atest/evidence/
    expire_in: 7 days

analyze:
  stage: analyze
  image: node:${options.nodeVersion}
  when: always
  allow_failure: true
  variables:
    ANTHROPIC_API_KEY: \$ANTHROPIC_API_KEY   # masked, protected, this job only
  script:
    - npm ci --ignore-scripts
    - npx aplaytest flaky report --runs .atest/runs
    - npx aplaytest heal --evidence .atest/evidence --dry-run || true
    - npx aplaytest report --runs .atest/runs --evidence .atest/evidence --out report.html
  artifacts:
    when: always
    paths:
      - report.html
    expire_in: 14 days

policy:
  stage: policy
  image: node:${options.nodeVersion}
  script:
    - npm ci --ignore-scripts
    - npx aplaytest flaky expire --ci
`;
}

const DEFAULT_OUT: Readonly<Record<string, string>> = {
  github: '.github/workflows/atest.yml',
  gitlab: '.gitlab-ci.atest.yml',
};

export async function ciGenerate(flags: CiFlags): Promise<ExitCode> {
  const provider = flags.provider ?? 'github';
  if (provider !== 'github' && provider !== 'gitlab') {
    throw new UsageError(`Unknown provider "${provider}". Supported: github, gitlab.`);
  }

  const shards = Number.parseInt(flags.shards ?? '4', 10);
  if (!Number.isInteger(shards) || shards < 1) {
    throw new UsageError('--shards must be a positive integer.');
  }

  const options: TemplateOptions = {
    shards,
    projects:
      flags.projects === undefined
        ? []
        : flags.projects.split(',').map(p => p.trim()).filter(Boolean),
    nodeVersion: flags.nodeVersion ?? '22',
    // Kept in step with the version this repo pins (package.json) and the
    // base of the `playwright` Docker target. A generated workflow whose
    // image predates the reporter's Playwright fails at browser launch with
    // "Executable doesn't exist", naming a tag the reader did not choose.
    playwrightImage: flags.playwrightImage ?? 'mcr.microsoft.com/playwright:v1.61.0-noble',
  };

  const content = provider === 'github' ? githubWorkflow(options) : gitlabWorkflow(options);
  const outPath = flags.out ?? DEFAULT_OUT[provider] ?? 'atest-ci.yml';

  if (flags.dryRun) {
    // Written raw, not through `line()`. The template already ends with a
    // newline, and appending another produces a trailing blank line that
    // fails yamllint — in a repo whose CI lints its own workflows, that means
    // the generated file breaks the build it was generated for.
    process.stdout.write(content);
    return EXIT.OK;
  }

  await mkdir(dirname(join('.', outPath)), { recursive: true });
  await writeFile(outPath, content, 'utf8');

  heading(`wrote ${outPath}`);
  line(`  ${shards} shards · node ${options.nodeVersion} · ${options.playwrightImage}`);
  line();
  line(style.dim('  The test job holds NO model credentials on purpose: on a pull request it'));
  line(style.dim('  runs branch code, so a key there would be one commit from exfiltration.'));
  line(style.dim('  The analyze job holds the key and runs no application code.'));
  line();
  line(style.cyan('  Pin the Playwright image to the version your suite uses, and keep the two'));
  line(style.cyan('  in lockstep — a mismatch changes screenshot rendering.'));
  return EXIT.OK;
}
