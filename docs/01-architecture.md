# 01 — Architecture

## Component map

```
┌─────────────────────────────────────────────────────────────────────────┐
│  FRONT-ENDS                                                             │
│    atest CLI  (commander + clack)      MCP server (stdio | http)        │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │  same in-process API — no HTTP between them
┌───────────────────────────▼─────────────────────────────────────────────┐
│  CORE ENGINE  @atest/core                                               │
│    config resolution · run orchestration · policy evaluation · audit    │
└──┬──────────┬───────────┬───────────┬──────────┬──────────┬─────────────┘
   │          │           │           │          │          │
┌──▼───────┐┌─▼─────────┐┌▼─────────┐┌▼────────┐┌▼────────┐┌▼───────────┐
│ RUNNER   ││ EVIDENCE  ││ HISTORY  ││ HEAL    ││ FLAKY   ││ IMPACT     │
│ ADAPTER  ││ STORE     ││ STORE    ││ ENGINE  ││ ENGINE  ││ ENGINE     │
│          ││           ││          ││         ││         ││            │
│ spawn pw ││ bundles   ││ sqlite / ││ cand.   ││ scoring ││ import     │
│ ingest   ││ artifacts ││ postgres ││ gen +   ││ classify││ graph +    │
│ blob/json││ aria/dom  ││ trace-id ││ validate││ policy  ││ coverage   │
│ parse    ││ shots/net ││ keyed    ││ patch   ││ quaran. ││ map        │
│ traces   ││           ││          ││         ││         ││            │
└──────────┘└───────────┘└──────────┘└────┬────┘└────┬────┘└────────────┘
                                          │          │
                              ┌───────────▼──────────▼──────────┐
                              │  AGENT RUNTIME  @atest/agent    │
                              │  repair agent · author agent    │
                              │  tool registry · budget guard   │
                              └───────────────┬─────────────────┘
                                              │
                              ┌───────────────▼─────────────────┐
                              │  LLM ABSTRACTION  @atest/llm    │
                              │  anthropic · openai · ollama    │
                              │  structured output · caching    │
                              └─────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  OUTPUTS   report (HTML + insights) · OTel spans · GitHub/Slack/Jira    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** arrows point down only. `@atest/heal` may import `@atest/core`;
`core` never imports an engine. Engines never import each other — `flaky` needing
impact data receives it through `core`. This keeps each engine independently testable
with a fake history store.

---

## How it attaches to Playwright

Three attachment points, in increasing order of intrusiveness. Phase 0 needs only the
first.

### 1. Reporter plugin (required)

```ts
// atest.config.ts consumers add one line to their reporter list
reporter: [['list'], ['@atest/runner-playwright/reporter']];
```

In this repo that means one entry in `activeReporters()` in
`src/shared/config/playwright.ts`, next to the existing conditional OTel reporter. The
reporter receives `onTestEnd(test, result)` with attachments (screenshot, video, trace
zip), errors, timings, and annotations — enough to build an Evidence Bundle without
touching a single spec.

**Packaging constraint:** this repo is `"type": "commonjs"` and loads reporters by
path. The reporter entry point must ship a CJS build. Everything else can be ESM-only.

### 2. Fixture wrapper (optional — enables richer evidence)

```ts
// src/ui/fixtures/index.ts
export const test = base.extend(atestFixtures);
```

Adds: ARIA snapshot capture at failure time, network request ledger, console ledger,
and per-page-object-call step annotation. `bindPage()` is the ideal hook — wrapping
each bound function records `{ pageObject, method, args }` as a Playwright step, which
turns a stack trace into *"failed inside `gymsPage.expectCardData('Blackwater Valley BJJ')`"*.

```ts
// @atest/runner-playwright/bind — a drop-in for src/ui/fixtures/bind-page.ts
export function bindPage<T extends object>(mod: T, page: Page, meta: BindMeta): BoundPageObject<T> {
  const bound: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mod)) {
    bound[key] =
      typeof value !== 'function'
        ? value
        : (...args: unknown[]) =>
            test.step(`${meta.name}.${key}(${previewArgs(args)})`, () => {
              atestTrace.enter(meta.name, key, args); // records intent for the evidence bundle
              return (value as (...r: unknown[]) => unknown)(page, ...args);
            });
  }
  return bound as BoundPageObject<T>;
}
```

This is the highest-leverage 20 lines in the design. It gives every failure a
**semantic intent** — the page-object method and its domain arguments — which is what
the healing agent actually needs. Raw `locator('[data-testid=gym-card-name]')` says
where it looked; `gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' })` says what
it wanted.

### 3. Executor mode (agentic only)

For `atest agent` runs, `atest` drives Playwright's API directly rather than the test
runner. Separate code path; does not affect normal runs.

---

## The Evidence Bundle

The central data structure. Everything downstream — healing, flaky classification,
MCP resources, report insights — consumes this and only this. Engines never re-open a
browser to "go look"; if a field is missing, the fix is to capture it, not to re-run.

```ts
// @atest/core/src/evidence/types.ts

export interface EvidenceBundle {
  readonly schemaVersion: 1;
  readonly id: EvidenceId;            // sha256(runId, testId, project, retry)
  readonly runId: string;
  readonly traceId: string;           // === src/shared/otel/trace-context.ts output
  readonly capturedAt: string;

  readonly test: {
    readonly id: string;              // Playwright testId — stable across runs
    readonly title: string;
    readonly titlePath: readonly string[];
    readonly file: string;            // repo-relative
    readonly line: number;
    readonly project: string;         // 'chromium-desktop' | 'api' | ...
    readonly tags: readonly string[];
    readonly retry: number;
    readonly workerIndex: number;
    readonly shard: { readonly current: number; readonly total: number } | null;
  };

  readonly failure: {
    readonly kind: FailureKind;       // deterministic classification — see below
    readonly message: string;
    readonly stack: string;
    readonly matcher: string | null;  // 'toBeVisible' | 'toHaveText' | ...
    readonly expected: string | null;
    readonly actual: string | null;
    readonly timedOut: boolean;
  };

  /** What the test was trying to do, in domain terms. From the bindPage wrapper. */
  readonly intent: {
    readonly steps: readonly StepRecord[];       // full page-object call trail
    readonly failingStep: StepRecord | null;     // e.g. gymsPage.expectCardData(...)
    readonly selector: string | null;            // resolved Playwright selector, if any
    readonly selectorSource: SelectorSource | null; // file+line+constant name if traceable
  };

  /** Primary LLM page representation. ARIA first — cheap and semantic. */
  readonly page: {
    readonly url: string;
    readonly title: string;
    readonly ariaSnapshot: string;               // page.locator('body').ariaSnapshot()
    readonly candidates: readonly LocatorCandidate[];
    readonly htmlDigest: string | null;          // structural digest, not full DOM
    readonly testIdsPresent: readonly string[];  // every data-testid on the page
  };

  readonly visual: {
    readonly screenshotPath: string | null;
    readonly diffPath: string | null;
    readonly diffPixelRatio: number | null;
  };

  readonly network: {
    readonly failed: readonly RequestRecord[];
    readonly slow: readonly RequestRecord[];     // > p95 baseline for this route
    readonly statusCounts: Readonly<Record<string, number>>;
  };

  readonly console: {
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  };

  readonly timing: {
    readonly testMs: number;
    readonly failingActionMs: number | null;
    readonly navigationMs: number | null;
    readonly budgetUsedRatio: number;            // testMs / configured timeout
  };

  readonly env: {
    readonly appEnv: string;                     // local | docker | dev | staging
    readonly baseUrl: string;
    readonly browser: string;
    readonly platform: string;
    readonly workers: number;
    readonly commit: string;
    readonly changedPaths: readonly string[];
  };

  /** Populated when an OTel backend is reachable; joined on traceId. */
  readonly appSpans: readonly AppSpanRecord[] | null;

  readonly artifacts: {
    readonly tracePath: string | null;
    readonly videoPath: string | null;
  };
}

export interface LocatorCandidate {
  readonly strategy: 'testid' | 'role' | 'label' | 'placeholder' | 'text' | 'css' | 'xpath';
  readonly expression: string;        // e.g. "getByRole('option', { name: 'Cork' })"
  readonly matchCount: number;        // 1 is required for a heal candidate
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly accessibleName: string | null;
  readonly boundingBox: Rect | null;
  readonly semanticDistance: number;  // 0..1 vs the intended target — Tier 0 heuristic
  readonly stabilityRank: number;     // 0 = most stable (testid) .. 6 (xpath)
}
```

### Why ARIA is the primary representation

`page.locator('body').ariaSnapshot()` on your gyms page yields a few hundred tokens of
semantic structure. The equivalent DOM is tens of thousands of tokens of Tailwind class
soup. Concretely:

```yaml
- heading "Gyms" [level=1]
- textbox "Search gyms"
- combobox "County": All counties
- list:
    - listitem:
        - heading "Blackwater Valley BJJ" [level=2]
        - text: Cork
        - link "Website"
        - link "Directions"
```

That is enough to locate any element by role+name, is stable under styling changes, is
already a first-class concept in your suite (`__aria__/*.aria.yml`), and costs ~2% of
the DOM's tokens. Rules:

- **ARIA snapshot** — always captured, always sent.
- **`testIdsPresent`** — always captured; it is the cheapest possible answer to "did the
  testid get renamed?"
- **HTML digest** — structural skeleton only (tag + testid + role + text, depth-capped),
  sent only when ARIA is insufficient (e.g. failure inside a non-semantic wrapper).
- **Screenshot** — sent to a vision model *only* for `visual_diff` and
  `locator_not_actionable`. Everything else is answerable from ARIA at a fraction of
  the cost.

---

## Failure taxonomy

Classification is **deterministic** — string/structure matching on the Playwright error,
plus bundle features. No model. The taxonomy drives routing: healing, flaky analysis,
or straight to "this is a real bug, stop."

```ts
export type FailureKind =
  | 'locator_not_found'          // strict mode: 0 matches
  | 'locator_ambiguous'          // strict mode violation: >1 match
  | 'locator_not_actionable'     // found, but intercepted / disabled / unstable
  | 'assertion_value_mismatch'   // toHaveText / toMatchObject etc.
  | 'assertion_visibility'       // toBeVisible timed out
  | 'visual_diff'                // toHaveScreenshot
  | 'aria_diff'                  // toMatchAriaSnapshot
  | 'navigation_failure'
  | 'network_error'              // request failed / connection refused
  | 'http_status'                // unexpected status in an API spec
  | 'schema_violation'           // Zod parse failed — wire contract broke
  | 'app_error'                  // console error / error boundary rendered
  | 'infra'                      // browser crash, OOM, port-forward down
  | 'unknown';
```

### Routing table

| Kind                       | Healable          | Flaky candidate | Notes                                          |
| -------------------------- | ----------------- | --------------- | ---------------------------------------------- |
| `locator_not_found`        | ✅ full            | ✅               | The bread-and-butter heal                      |
| `locator_ambiguous`        | ✅ full            | ⚠️              | Often a genuine app duplication — flag it      |
| `locator_not_actionable`   | ⚠️ propose-only   | ✅✅              | Usually timing/animation, not a wrong selector |
| `assertion_value_mismatch` | ⚠️ propose-only   | ✅               | **Never auto-apply** (D7)                      |
| `assertion_visibility`     | ⚠️ propose-only   | ✅✅              | Most common genuine flake                      |
| `visual_diff`              | ⚠️ propose-only   | ✅               | Route to snapshot workflow, not selector heal  |
| `aria_diff`                | ⚠️ propose-only   | ⚠️              | Semantic change — near-always a real change    |
| `navigation_failure`       | ❌                 | ✅✅              | Env or app                                     |
| `network_error`            | ❌                 | ✅✅              | Env or app                                     |
| `http_status`              | ❌                 | ✅               | Real API behaviour change                      |
| `schema_violation`         | ❌ **never**       | ❌               | **Wire contract broke. This is the bug.**      |
| `app_error`                | ❌ **never**       | ⚠️              | Console error — this is the bug                |
| `infra`                    | ❌                 | ❌ excluded      | Excluded from flake stats entirely             |
| `unknown`                  | ❌                 | ⚠️              | Every occurrence is a taxonomy bug — alert     |

The two `never` rows matter most. Your `parseMockBody` / Zod-schema discipline exists
precisely so drift **fails loudly**. An "AI test framework" that helpfully repairs a
`schema_violation` would destroy the most valuable signal in the suite. It is a hard
guard in code, not a policy setting:

```ts
const NEVER_HEAL: ReadonlySet<FailureKind> = new Set([
  'schema_violation', 'app_error', 'http_status', 'network_error',
  'navigation_failure', 'infra',
]);
```

---

## Data flow: one failing test, end to end

```
 1. playwright test  ──► test fails
 2. atest reporter   ──► onTestEnd: assemble EvidenceBundle
                          - read attachments (screenshot, trace zip, video)
                          - read fixture-captured aria/network/console ledgers
                          - classify(failure) → FailureKind          [deterministic]
                          - resolve intent from step trail            [bindPage]
 3. evidence store   ──► .atest/evidence/<runId>/<evidenceId>.json + artifacts
 4. history store    ──► INSERT attempt(test_id, project, outcome, kind, trace_id, ...)
 5. run ends         ──► onEnd: run summary, exit code UNCHANGED from Playwright's

    ── everything above is synchronous, deterministic, and LLM-free ──

 6. atest analyze    ──► (separate process / separate CI job / local command)
      ├─ flaky engine: query history → score → classify → policy proposal
      ├─ heal engine:  healable bundles → Tier-0 candidates
      │                 → [optional LLM rank] → validate by re-run → patch
      ├─ impact engine: changed paths → affected specs (for the next run)
      └─ report:       HTML + insight cards + flaky dashboard
 7. integrations     ──► PR comment, Slack, Jira, heal/* branch
```

The line after step 5 is the architecture's most important boundary. Everything above
it runs in the job that executes application code and needs no model credentials.
Everything below runs in a job that has model credentials and executes no application
code. See [08-cicd.md](./08-cicd.md) for why that separation is also a security
property.

---

## History store schema

SQLite locally; Azure Blob in CI, where history has to outlive the runner. Same
query semantics either way — both drivers answer through one `HistoryIndex`, so a
score cannot differ between a laptop and the pipeline. Same interface,
same queries — `@atest/core` speaks a narrow `HistoryStore` interface with two drivers.

```sql
CREATE TABLE runs (
  run_id        TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  commit_sha    TEXT NOT NULL,
  branch        TEXT,
  app_env       TEXT NOT NULL,
  ci            INTEGER NOT NULL,
  workers       INTEGER,
  shard_total   INTEGER,
  atest_version TEXT NOT NULL
);

CREATE TABLE attempts (
  attempt_id   TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(run_id),
  test_id      TEXT NOT NULL,          -- Playwright testId: stable across renames of *title*
  test_title   TEXT NOT NULL,          -- denormalised for reporting
  file         TEXT NOT NULL,
  project      TEXT NOT NULL,
  tags         TEXT NOT NULL,          -- json array
  retry        INTEGER NOT NULL,
  outcome      TEXT NOT NULL,          -- passed | failed | timedOut | skipped | interrupted
  failure_kind TEXT,
  duration_ms  INTEGER NOT NULL,
  worker_index INTEGER,
  shard        INTEGER,
  trace_id     TEXT,                   -- → OTel / Tempo join key
  evidence_id  TEXT,                   -- → evidence store
  co_scheduled TEXT                    -- json array of test_ids on the same worker
);

CREATE INDEX idx_attempts_test    ON attempts(test_id, project, run_id);
CREATE INDEX idx_attempts_outcome ON attempts(outcome, failure_kind);

CREATE TABLE heals (
  heal_id      TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  evidence_id  TEXT NOT NULL,
  test_id      TEXT NOT NULL,
  strategy     TEXT NOT NULL,          -- selector | assertion | flow
  target_file  TEXT NOT NULL,
  before       TEXT NOT NULL,
  after        TEXT NOT NULL,
  stability_delta INTEGER NOT NULL,    -- negative = weaker locator, requires review
  validation   TEXT NOT NULL,          -- json: {runs, passed, collateralPassed}
  model        TEXT,                   -- null when Tier-0 resolved it
  confidence   REAL,
  status       TEXT NOT NULL,          -- proposed | applied | rejected | reverted
  reviewed_by  TEXT
);

CREATE TABLE quarantines (
  test_id     TEXT NOT NULL,
  project     TEXT,                    -- null = all projects
  reason      TEXT NOT NULL,
  flake_score REAL NOT NULL,
  root_cause  TEXT,
  issue_url   TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,           -- enforced: expiry fails CI (see 06)
  PRIMARY KEY (test_id, project)
);

-- Which routes / testids / API calls each test touched. Harvested from traces.
-- Powers impact analysis without any model.
CREATE TABLE coverage_map (
  test_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- route | testid | api_path | page_object
  value      TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (test_id, kind, value)
);
```

`test_id` is Playwright's stable id, not the title — so renaming a test title (which
your Given/When/Then convention invites) does not reset its flake history. Titles are
denormalised for display only.

---

## Configuration

One file, fully typed, Zod-validated at load, with every field optional.

```ts
// atest.config.ts
import { defineAtestConfig } from '@atest/core';

export default defineAtestConfig({
  playwright: {
    configs: {
      ui: 'playwright.ui.config.ts',
      api: 'playwright.api.config.ts',
      acceptance: 'playwright.acceptance.config.ts',
    },
    defaultConfig: 'acceptance',
  },

  history: { driver: 'sqlite', url: '.atest/history.sqlite' }, // or azblob://<account>/<container>
  evidence: { dir: '.atest/evidence', retainRuns: 50, redact: ['password', 'token', 'authorization'] },

  llm: {
    provider: 'anthropic',
    models: {
      classify: 'claude-haiku-4-5-20251001',
      heal: 'claude-sonnet-5',
      author: 'claude-opus-5',
      vision: 'claude-sonnet-5',
    },
    budget: { perFailureUsd: 0.05, perRunUsd: 2.0 },
  },

  heal: {
    aggressiveness: 'balanced',        // off | conservative | balanced | aggressive
    validationRuns: 3,
    validateCollateral: true,
    minStabilityRank: 4,               // reject css-structural and xpath heals
    apply: 'propose',                  // propose | pr | local
    targets: ['src/ui/pages/**/*.constants.ts', 'src/ui/pages/**/*.page.ts'],
  },

  flaky: {
    window: { runs: 50, days: 14 },
    halfLifeDays: 7,
    threshold: 0.15,
    minRuns: 10,
    quarantine: { policy: 'propose', expiryDays: 14, maxTests: 5, maxRatio: 0.02 },
  },

  conventions: {
    // Machine-checkable repo rules handed to the author agent AND enforced post-hoc.
    // See 04-agent-runtime.md — constraints are tools, not prose.
    titlePattern: '^Given .+, when .+, then .+$',
    requiredTags: ['@acceptance'],
    seededDataDir: 'tests/testdata/seeded',
    forbidWriteTo: ['tests/testdata/seeded/**'],
    pageObjectDir: 'src/ui/pages',
    verifyCommands: ['npm run typecheck', 'npm run lint'],
  },

  integrations: {
    github: { autoComment: true, healBranchPrefix: 'atest/heal/' },
    otel: { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT, queryUrl: process.env.TEMPO_URL },
  },
});
```
