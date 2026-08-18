# 08 — CI/CD

> **`atest run` does not exist, and deliberately.** Tests are invoked with
> `playwright test` exactly as before; atest attaches through the reporter.
> A wrapper would contradict the design's own claim that removing the reporter
> line removes the framework, and would owe permanent exit-code parity for no
> capability. Earlier drafts of this document showed `atest run`; those have
> been corrected.
>
> Persisting history across runs needs a durable store — see
> [12 — Azure history](./12-azure-history.md). `--db :memory:` (the default)
> reports "insufficient data" forever. & observability

## The central constraint: split execute from analyze

The test job executes application code and, on `pull_request`, code from a fork. The
analyze job holds a model API key. **These must not be the same job.**

```
┌─────────────────────────────────────────────────────────────────────┐
│  plan            no secrets · computes impact + shard plan          │
├─────────────────────────────────────────────────────────────────────┤
│  test  (matrix)  no model key · APP_ENV creds only                  │
│                  playwright test                                    │
│                  ↳ uploads blob-report + .atest/evidence            │
├─────────────────────────────────────────────────────────────────────┤
│  analyze         model key · runs NO application code               │
│                  downloads artifacts · heal --propose · flaky       │
│                  ↳ PR comment · heal branch · history commit        │
└─────────────────────────────────────────────────────────────────────┘
```

Why this matters concretely, and not as generic hygiene:

1. **Secret exposure.** A PR that modifies a spec, a fixture, or `playwright.config.ts`
   runs arbitrary code in the test job. If `ANTHROPIC_API_KEY` were in that job's env, a
   one-line change exfiltrates it. Your repo already runs zizmor with a SHA-pinning
   policy; this is the same class of concern one level up.
2. **Determinism.** The merge gate must be reproducible. If the job that decides
   pass/fail can call a model, it is not.
3. **Cost control.** Analyze runs once per workflow, not once per shard. With a 9-shard
   matrix that is a 9× difference.
4. **Failure isolation.** A model provider outage must not turn a red build into an
   infrastructure incident. Analyze is `continue-on-error: true`.

---

## GitHub Actions — `atest.yml`

Fits alongside your existing `ci.yml` (lint + typecheck) and the reusable
`playwright-docker.yml`.

```yaml
name: Acceptance (atest)

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  # ── 1. PLAN ────────────────────────────────────────────────────────────────
  plan:
    name: Plan
    runs-on: ubuntu-latest
    outputs:
      shards: ${{ steps.plan.outputs.shards }}
      grep: ${{ steps.plan.outputs.grep }}
      skip: ${{ steps.plan.outputs.skip }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0          # impact analysis needs history
          persist-credentials: false
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci --ignore-scripts

      # Impact analysis is deterministic (import graph + coverage map). On main it
      # is skipped entirely — main always runs everything.
      - id: plan
        run: |
          if [ "${{ github.ref }}" = "refs/heads/main" ]; then
            npx atest ci plan --all --shards 4 >> "$GITHUB_OUTPUT"
          else
            npx atest ci plan --impact-from origin/main --shards auto --max-shards 4 \
              >> "$GITHUB_OUTPUT"
          fi

  # ── 2. TEST ────────────────────────────────────────────────────────────────
  test:
    name: ${{ matrix.project }} ${{ matrix.shard }}
    needs: plan
    if: needs.plan.outputs.skip != 'true'
    runs-on: ubuntu-latest
    container: mcr.microsoft.com/playwright:v1.61.0-noble    # Renovate-grouped pin
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.plan.outputs.shards) }}
    env:
      APP_ENV: docker
      CI: 'true'
      # NOTE: no ANTHROPIC_API_KEY here. Deliberate.
    steps:
      - uses: actions/checkout@v6
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci

      - name: Run acceptance tests
        run: |
          npx playwright test \
            --project ${{ matrix.project }} \
            --shard ${{ matrix.shard }} \
            --grep '${{ needs.plan.outputs.grep }}' \
            --record-coverage

      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: atest-${{ matrix.project }}-${{ strategy.job-index }}
          path: |
            blob-report/
            .atest/evidence/
            .atest/run.json
          retention-days: 7

  # ── 3. ANALYZE ─────────────────────────────────────────────────────────────
  analyze:
    name: Analyze
    needs: [plan, test]
    if: ${{ !cancelled() && needs.plan.outputs.skip != 'true' }}
    runs-on: ubuntu-latest
    continue-on-error: true          # analysis must never change the merge verdict
    permissions:
      contents: write                # heal branch + history branch
      pull-requests: write           # PR comment
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci --ignore-scripts

      - uses: actions/download-artifact@v4
        with: { pattern: atest-*, path: artifacts, merge-multiple: true }

      - name: Restore history
        run: npx atest history ingest --db .atest/history.sqlite --runs .atest-artifacts/runs

      - name: Merge run data
        run: npx atest analyze ingest --from artifacts

      # Flaky analysis is fully deterministic — runs even with no model key.
      - name: Flaky analysis
        run: |
          npx atest flaky analyze --ci
          npx atest flaky expire --ci || echo "EXPIRED_QUARANTINE=1" >> "$GITHUB_ENV"

      # Heals need a browser to validate candidates against the live page.
      - name: Propose heals
        if: env.ANTHROPIC_API_KEY != ''
        run: npx atest heal --run latest --aggressiveness balanced --validate 3 --json > heals.json
        continue-on-error: true

      - name: PR comment
        if: github.event_name == 'pull_request'
        run: npx atest report --format markdown --ci | npx atest ci comment --update

      - name: Open heal PR
        if: github.ref == 'refs/heads/main' && hashFiles('heals.json') != ''
        run: npx atest heal pr --all --branch-prefix atest/heal/

      - name: Persist history
        if: github.ref == 'refs/heads/main'
        run: npx atest history export --to-branch atest-history --push

      - uses: actions/upload-artifact@v4
        with: { name: atest-report, path: playwright-report/ }

  # ── 4. POLICY GATE ─────────────────────────────────────────────────────────
  # Separate, non-continue-on-error job so quarantine hygiene can actually block.
  policy:
    name: Policy
    needs: analyze
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci --ignore-scripts
      - run: npx atest history ingest --db .atest/history.sqlite --runs .atest-artifacts/runs
      - run: npx atest flaky expire --ci     # exit 4 on expired quarantine or budget breach
```

The four-job shape maps cleanly onto the properties you want: `plan` is cheap and
secret-free, `test` is the merge gate and is unchanged in character from today,
`analyze` is best-effort intelligence, and `policy` is the only place new rules can
block a merge — so the blocking surface stays small and explicit.

---

## History storage in CI

The history store must survive between runs. Three options; start with the first.

### Option A — orphan branch (recommended to start)

```bash
atest history export --to-branch atest-history --push
```

An orphan branch `atest-history` holding `history.sqlite` (plus a JSONL fallback for
mergeability). Zero infrastructure, works on any GitHub plan, versioned by construction,
and `git log` on that branch is a free audit trail.

Concurrency is handled by a dedicated GitHub concurrency group with
`cancel-in-progress: false`, so exports serialise. Only `main` writes; PRs read.

Practical limit: roughly 100k attempts / ~50 MB. For this suite — 271 tests × 11 projects
× ~20 runs/week ≈ 60k attempts/quarter — with a 90-day prune that is comfortable for a
long time.

### Option B — Postgres

Same schema, `history.driver = 'postgres'`. Switch when you want cross-repo dashboards,
sub-second leaderboard queries over years of data, or writes from multiple repos.

### Option C — S3/blob + DuckDB

Parquet partitioned by date, queried with DuckDB. Best analytics story, most operational
work. Only worth it at large scale.

**Do not** store history in the Playwright HTML report or in artifacts alone — artifacts
expire, and a history store with a 7-day memory cannot detect flake.

---

## GitLab CI

```yaml
stages: [plan, test, analyze]

variables:
  APP_ENV: docker

plan:
  stage: plan
  image: node:22
  script:
    - npm ci --ignore-scripts
    - npx atest ci plan --impact-from origin/$CI_DEFAULT_BRANCH --shards auto > plan.env
  artifacts: { reports: { dotenv: plan.env } }

test:
  stage: test
  image: mcr.microsoft.com/playwright:v1.61.0-noble
  parallel: 4
  script:
    - npm ci
    - npx playwright test --shard $CI_NODE_INDEX/$CI_NODE_TOTAL --grep "$ATEST_GREP"
  artifacts:
    when: always
    paths: [blob-report/, .atest/evidence/]
    reports: { junit: test-results/junit.xml }

analyze:
  stage: analyze
  image: node:22
  when: always
  allow_failure: true
  variables:
    ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY     # masked, protected, this job only
  script:
    - npm ci --ignore-scripts
    - npx atest analyze ingest --from .
    - npx atest flaky analyze --ci
    - npx atest heal --run latest --json > heals.json || true
    - npx atest report --format markdown --ci | npx atest ci comment --provider gitlab
```

`atest ci generate --provider gitlab` emits this, adapted to the detected project list.

---

## Test impact analysis

Deterministic, two-source, with an explicit escape hatch. No model in the common path.

### Source 1 — static import graph

`ts-morph` builds the closure from each spec through its imports. In this repo the edges
are unusually clean because of the path aliases and the feature-slice layout:

```
gyms.ui.acceptance.spec.ts
  → @ui/fixtures            → gyms.fixture.ts → gyms.page.ts → gyms.constants.ts
                                              → gyms.mock.ts → json-response.mock.ts
  → @ui/pages/gyms/gyms.card.mapper
  → tests/testdata/seeded/gyms.ts → @api/features/gyms/gyms.types
```

A change to `src/ui/pages/gyms/gyms.constants.ts` therefore selects exactly the specs
that transitively import it. `src/shared/config/**` reaches everything, and is correctly
treated as a full-suite trigger.

### Source 2 — runtime coverage map

Harvested from Playwright traces during `--record-coverage`: which routes each test
visited, which testids it resolved, which API paths it called. This catches edges the
import graph cannot see — `routes.a11y.acceptance.spec.ts` iterates routes from an array
and never imports `gyms.page.ts`, but its coverage map records `/gyms`.

### Selection rules

```ts
export function selectTests(changed: string[], graph: ImportGraph, cov: CoverageMap): Selection {
  // Any of these means: run everything. Cheap insurance against a clever-but-wrong
  // selection silently reducing coverage.
  const FULL_SUITE_TRIGGERS = [
    'package.json', 'package-lock.json', 'playwright*.config.ts',
    'src/shared/**', 'atest.config.ts', '.github/workflows/**', 'Dockerfile',
  ];
  if (changed.some(p => matchesAny(p, FULL_SUITE_TRIGGERS))) return Selection.full('trigger');

  const byImport   = graph.dependentsOf(changed);
  const byCoverage = cov.testsTouching(routesFor(changed));
  const alwaysRun  = graph.testsTagged('@smoke');   // smoke is never skipped

  const selected = union(byImport, byCoverage, alwaysRun);

  // If we would run most of it anyway, the bookkeeping is not worth the risk.
  if (selected.size > graph.allTests.size * 0.6) return Selection.full('threshold');

  return Selection.of(selected, { reasons: explain(byImport, byCoverage) });
}
```

Non-negotiable guards:

- **`main` always runs everything.** Impact analysis is a PR-latency optimisation only.
- **`@smoke` always runs.** 28 tests, ~18s. It is the floor.
- **Above 60% selection, run everything.** The savings do not justify the risk.
- **Every selection is explained.** `atest impact --format list` prints, per test, the
  edge that selected it. A selection nobody can explain is a coverage hole waiting to
  happen.

### Cross-repo (the interesting hard case)

A change in `~/Sources/BjjEire` (`GymCard.tsx`) has no import edge into this repo. Two
mechanisms, in order:

1. **Testid diff (deterministic).** Extract `data-testid` literals from the app diff,
   look them up in the coverage map and in `*.constants.ts`. A renamed testid selects
   exactly the affected tests. This handles most real cases with no model.
2. **Route/component mapping (model-assisted).** If the app diff touches files with no
   testid signal, ask a model to map changed component paths to app routes, then select
   by route from the coverage map. Result is cached per app-commit and **never narrows
   below the deterministic selection** — the model may only add tests, never remove them.

That last rule is the safety property: a model error costs CI minutes, never coverage.

---

## Observability

Your OTel reporter already makes every test the root span of its own trace. `atest`
extends the same spans rather than introducing a second telemetry system.

```
test.run (per shard)
└── test.case  ← existing, trace id from src/shared/otel/trace-context.ts
    ├── app spans (existing — the app's own server spans nest here)
    └── atest.analysis                       ← NEW, added by the analyze job
        ├── atest.classify        kind, confidence
        ├── atest.candidates      count, best_score, tier
        ├── atest.agent.repair    model, steps, tokens, usd
        └── atest.validate        runs, passed, collateral
```

Attributes follow the existing `test.*` namespace. **Do not rename existing `test.*`
attributes** — your `TODO.md` notes the Grafana dashboard depends on them. New
attributes go under `atest.*`:

```ts
'atest.failure.kind'        'atest.heal.strategy'     'atest.heal.confidence'
'atest.heal.stability_delta''atest.flake.score'       'atest.flake.class'
'atest.llm.model'           'atest.llm.tokens'        'atest.llm.usd'
'atest.tier'                'atest.impact.selected'
```

The payoff of sharing the trace id: one Grafana query answers *"show me every failure of
this test, with the app's server spans from the same moment."* That is how
`appSpanLatencyOutlierRate` in the flaky classifier gets its data, and it is only
possible because the ids were already deterministic.

Structured logs are JSON lines to stderr with `runId`, `traceId`, `testId`, `component`,
so a log line can always be joined back to a trace.

---

## Notifications

Thin integrations over `atest report --format <x>`; no bespoke logic.

| Target | Trigger | Content |
| --- | --- | --- |
| GitHub PR comment | every PR run | Failure summary, flake verdict per failure, heal proposals with diffs, impact selection. Updated in place, never appended. |
| Slack / Teams | `main` failures, new flake above threshold, expiring quarantine | Compact card with links to report and trace |
| Jira / Linear | quarantine created, `isRealBug: true` | Ticket with evidence bundle, ARIA snapshot, trace link, suggested owner from `git blame` |

One rule that keeps these useful: **notify on state change, not on state.** A test that
has been quarantined for three days generates no messages. It generates one when it is
created, one at three days to expiry, and one when it expires.
