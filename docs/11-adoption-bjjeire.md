# 11 — Adoption plan for `bjjeire-tests`

How this lands on *this* repo, in order, with the actual files that change. Every phase is
independently valuable and independently revertible.

---

## Phase 0 — Attach (one PR, ~30 lines, no spec changes)

**Goal:** every failure gets captured. No model, no behaviour change, no risk.

### Files that change

```
+ atest.config.ts
+ .atest/.gitignore
~ .gitignore                          (+2 lines)
~ package.json                        (+1 devDependency, +4 scripts)
~ src/shared/config/playwright.ts     (+3 lines in activeReporters)
```

### The reporter hook

`activeReporters()` already has exactly the right shape for this — a conditional, env-gated
reporter list. `atest` slots in beside the OTel reporter using the same pattern:

```ts
// src/shared/config/playwright.ts
function activeReporters(): ReporterDescription[] {
  const reporters: ReporterDescription[] = IS_CI ? [...CI_REPORTERS] : [...LOCAL_REPORTERS];
  if (!IS_CI && process.env['ALLURE']) {
    reporters.push(['allure-playwright', { resultsDir: 'allure-results' }]);
  }
  if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
    reporters.push([join(REPO_ROOT, 'src', 'shared', 'otel', 'otel-reporter.ts')]);
  }
  // NEW — opt-in exactly like the OTel reporter above it.
  if (process.env['ATEST'] !== '0') {
    reporters.push(['@atest/runner-playwright/reporter']);
  }
  return reporters;
}
```

`ATEST=0` disables it completely, which is the escape hatch for "is atest causing this?"

### The trace-id bridge

The one integration worth doing properly on day one. `src/shared/otel/trace-context.ts` already
derives deterministic ids from `(runId, testId, retry)`; `atest` consumes that function rather
than minting its own, so history rows join to Tempo spans for free:

```ts
// atest.config.ts
import { testTraceContext } from './src/shared/otel/trace-context';
import { resolveRunId } from './src/shared/config/run-id';

export default defineAtestConfig({
  identity: {
    runId: resolveRunId,
    traceId: (test, retry) => testTraceContext(resolveRunId(), test.id, retry).traceId,
  },
  // …
});
```

Skip this and the flaky engine loses `appSpanLatencyOutlierRate` — one of its strongest
root-cause signals — for no good reason.

### Verification

```sh
npm run test:smoke                       # 28 tests, must be unchanged: same result, ±2% duration
ls .atest/evidence/                      # bundles for any failure
npx atest doctor                         # config, versions, stores, reachability
npx atest history query --last 5
```

**Exit criteria:** `atest run --grep @smoke` and `npm run test:smoke` produce identical exit codes
and test results across 10 runs. If they don't, stop and fix before Phase 1.

### New scripts

```jsonc
"atest": "atest run -c playwright.acceptance.config.ts",
"atest:smoke": "atest run -c playwright.acceptance.config.ts -g @smoke",
"atest:analyze": "atest analyze --run latest",
"atest:flaky": "atest flaky report"
```

---

## Phase 1 — Flaky engine (the phase that pays for the project)

**Goal:** turn the flake problem you already have documented into a measured, managed number.

You have one known flake recorded in `TODO.md`:

> **Pre-existing flake**: `footer.ui` "Stores" quick link on firefox-desktop occasionally fails to
> navigate under full-suite parallel load (passes in isolation).

That is the acceptance test for this phase. The engine must, with **no model involved**:

1. Score it (expect ~0.3 given "occasionally, under load, one browser").
2. Classify it `resource-contention` — **not** as a selector problem.
3. Prove it with `atest flaky bisect --workers-sweep`, showing failure probability rising
   monotonically with worker count and confined to `firefox-desktop`.
4. Prescribe the fix: await the navigation response before asserting the URL.

If it instead classifies as `timing` and suggests a retry, the rules need work before you trust
this on anything else.

### Seeding history

The engine needs ~10 runs per (test, project) before it will score anything. Two ways to get there:

```sh
# Fast: replay the last 30 days of CI blob reports into the history store
npx atest history import --from-artifacts ./downloaded-blob-reports

# Or: nightly full-suite runs for two weeks, which you may want anyway
```

The import path is worth building first — it turns two weeks of waiting into an afternoon.

### Quarantine hygiene, enforced

`CLAUDE.md` says *"Fix or delete promptly — never let the list grow."* Phase 1 makes that a CI gate
rather than a norm:

```yaml
- run: npx atest flaky expire --ci     # exit 4 on expired quarantine or budget breach
```

The codemod writes `@quarantine` into the existing tag array; `grepInvert: QUARANTINE_TAG` in
`src/shared/config/playwright.ts` already does the excluding. No new runtime machinery.

---

## Phase 2 — Healing, propose-only

**Goal:** selector drift stops costing an afternoon.

Your repo is close to ideal for this, for one specific reason: **every selector is a string constant
in `src/ui/pages/<feature>/<feature>.constants.ts`**. Five files, 71 test ids, no logic. A heal is a
one-line diff in a file a reviewer can read in ten seconds.

### Build the corpus first

Before writing a prompt, generate ground truth. Inject renames into a scratch worktree and capture
what happens:

```sh
npx atest dev inject-rename --testid gym-card-name --to gym-card-title --project chromium-desktop
```

Run that across ~40 real testids spanning all five features. Each produces an evidence bundle with a
known-correct answer. That corpus is:

- The Tier-0 benchmark (target: ≥60% resolved with no model).
- The Tier-1 benchmark (target: +20 points, **measured**).
- The prompt regression suite — any prompt change runs against it before merging.

Prompt engineering without this corpus is guesswork, and you will not be able to tell whether the
model is earning its cost.

### Watch out for shared literals

`gyms.constants.ts` holds `'gym-card-name'` in **both** `TEST_IDS.cardName` and
`GYM_CARD_TEST_IDS.name`, used by `gyms.page.ts` and `gyms.card.page.ts` respectively. A text-level
patch fixes one and leaves the other, and the collateral check catches it as a failure rather than a
partial heal. This is exactly why patching goes through ts-morph and why `validateCollateral`
defaults on. Put a corpus case on it.

### Guards to verify adversarially

Prove these fail closed before enabling anything beyond propose-only:

| Guard | Test |
| --- | --- |
| `schema_violation` never heals | Break a Zod schema; confirm zero proposals |
| `app_error` never heals | Inject a console error; confirm zero proposals |
| Assertion heals never auto-apply | Set `apply: 'local'`; confirm assertion proposals still only propose |
| Flakes are not healed | Feed a bundle for a test above threshold; confirm it routes to flaky |

---

## Phase 3 — Impact analysis

Your import graph is unusually clean — path aliases, feature slices, one fixture per feature — so
this pays off immediately:

```
gyms.ui.acceptance.spec.ts
  → @ui/fixtures → gyms.fixture.ts → gyms.page.ts → gyms.constants.ts
                                                  → gyms.mock.ts → json-response.mock.ts
  → @ui/pages/gyms/gyms.card.mapper
  → tests/testdata/seeded/gyms.ts → @api/features/gyms/gyms.types
```

A change to `gyms.constants.ts` selects ~38 of 271 tests. `src/shared/config/**` correctly triggers
everything.

The runtime coverage map earns its keep on one specific file:
`tests/accessibility/routes.a11y.acceptance.spec.ts` iterates routes from an array and imports no
page objects — the import graph cannot see that it covers `/gyms`. Coverage recording catches it.
Without that, impact analysis would silently drop a11y coverage on UI changes. Make it a test case.

---

## Phase 4+ — Authoring and MCP

By now the author agent has what it needs: conventions in `CLAUDE.md`, exemplar specs in every
feature, seeded DTOs with `partialNameOf` guards, and a lint config that already errors on
`waitForTimeout` and floating promises.

Two repo-specific rules must be encoded as gates, not prose:

1. **Never assert a fixture card on page 1 of an unfiltered list.** Environments hold full datasets
   (61 gyms locally). Enforced by the "unfiltered dataset" mutant in the falsifiability gate — a
   test that passes against it is not testing filtering.
2. **Mocks only for empty / error / pagination / snapshot determinism**, always parsed through
   `parseMockBody`. Enforced by `check_conventions`.

Start authoring against `stores` or `competitions` — real features, currently thinner coverage than
gyms, and low blast radius.

---

## What to update as you go

Per `CLAUDE.md`'s maintenance rule, these change in the same PR as the code:

| Phase | Update |
| --- | --- |
| 0 | `CLAUDE.md` — reporter list, `.atest/` layout, new scripts |
| 1 | `CLAUDE.md` — quarantine now has expiry + budget, enforced in CI. `TODO.md` — close the footer flake item with the bisect verdict |
| 2 | `CLAUDE.md` — heal ledger in `.atest/heals/`, review expectations, the `NEVER_HEAL` guard |
| 3 | `CLAUDE.md` — impact selection on PRs, full suite on `main` |
| 4 | `tests/features/_template/README.md` — how `atest agent author` relates to `/add-feature` |

---

## Risks, honestly

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Reporter overhead slows runs | Low | Exit criteria measures it; ARIA capture is on failure only. `ATEST=0` kills it. |
| History branch write contention | Medium | Concurrency group with `cancel-in-progress: false`; only `main` writes |
| Heal proposals waste review time | Medium | Propose-only until acceptance rate > 80% on the corpus; revert rate is the kill switch |
| Impact analysis drops a test | Low | `main` runs everything; `@smoke` always runs; 60% threshold; validated against 50 replayed commits |
| Playwright version drift | Medium | Peer dependency + startup assertion; Renovate already groups `@playwright/test`, the Dockerfile, and the workflow image — **add the `atest` package to that group** |
| Model provider outage | Low | Analyze job is `continue-on-error`; every engine has a Tier-0 path |

The Renovate row is the one most likely to bite silently. Your `playwright` group already keeps
`@playwright/test`, the devcontainer base image, and the workflow default image in lockstep because
a mismatch changes snapshot rendering. `atest` declares a Playwright peer range and must move in
that same grouped PR.

---

## Sequencing summary

```
Week 1–2    Phase 0    Evidence + history                    no LLM   fully revertible
Week 3–5    Phase 1    Flaky engine + quarantine gates       no LLM   closes a known TODO item
Week 6–8    Phase 2    Healing, propose-only                 LLM opt-in
Week 9–10   Phase 3    Impact analysis                       no LLM   PR latency
Week 11–14  Phase 4    Author agent                          LLM
Week 15–16  Phase 5    MCP façade
```

Stop after any phase and keep everything before it. That is the property worth protecting —
if Phase 2 disappoints, Phases 0–1 remain a net win, and nothing needs unwinding.
