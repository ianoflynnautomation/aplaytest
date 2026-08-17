# 06 — Flaky detection & management

## Definition

A test is flaky when, **holding commit, environment, and project fixed**, its outcome is
non-deterministic. Anything else is a bug, an environment problem, or a real regression —
and calling those "flaky" is how suites rot.

The engine therefore separates three questions and answers them in order:

1. **Is it non-deterministic?** — statistics over history. No model.
2. **Why?** — feature extraction over evidence bundles + app spans. No model.
3. **What should we do?** — policy. No model. (A model only writes the narrative.)

---

## Signals

Three independent sources, each with different strength:

| Signal | Strength | Source |
| --- | --- | --- |
| **Retry flip** — failed then passed on retry, same run, same commit | Strongest | You already run `retries: 1` in CI. Free. |
| **Same-commit variance** — different outcomes across runs at one SHA | Strong | Nightly / re-runs / `--repeat-flaky` |
| **Stable-impact variance** — different outcomes across commits where the test's impact set did not change | Moderate | Joins the impact engine (`atest impact`) |

The third is the interesting one. Most tools compare outcomes across commits blindly and
so misread a genuine regression as flake. Using the import graph to ask *"did anything
this test depends on actually change?"* removes that confusion: if nothing changed and
the outcome flipped, it is flake; if `gyms.page.ts` changed, it is a regression.

Attempts with `failure_kind = 'infra'` are excluded from all statistics. A browser crash
or a dropped port-forward is not evidence about the test.

---

## Scoring

Raw flip rate is a bad metric: it is unstable at low `n` and treats a 6-month-old
failure the same as this morning's. Use a recency-weighted Wilson lower bound plus a
transition-density term.

```ts
// packages/flaky/src/score.ts

export interface FlakeScore {
  readonly score: number;        // 0..1
  readonly wilsonLower: number;
  readonly transitionDensity: number;
  readonly weightedN: number;
  readonly rawN: number;
  readonly confidence: 'low' | 'medium' | 'high';
}

const Z = 1.96; // 95%

export function scoreTest(attempts: readonly Attempt[], cfg: FlakyConfig, now = Date.now()): FlakeScore {
  const usable = attempts.filter(a => a.failureKind !== 'infra' && a.outcome !== 'skipped');
  if (usable.length < cfg.minRuns) {
    return { score: 0, wilsonLower: 0, transitionDensity: 0,
             weightedN: 0, rawN: usable.length, confidence: 'low' };
  }

  // Exponential recency decay: a failure 7 days ago counts half of one today.
  const halfLifeMs = cfg.halfLifeDays * 86_400_000;
  const w = (a: Attempt) => Math.pow(0.5, (now - Date.parse(a.startedAt)) / halfLifeMs);

  const weightedN = sum(usable, w);
  const weightedFail = sum(usable.filter(isFailure), w);
  const p = weightedFail / weightedN;

  // Wilson LOWER bound: with few observations the score stays conservative, so a
  // single failure in 12 runs does not immediately brand a test flaky.
  const denom = 1 + (Z * Z) / weightedN;
  const centre = p + (Z * Z) / (2 * weightedN);
  const margin = Z * Math.sqrt((p * (1 - p) + (Z * Z) / (4 * weightedN)) / weightedN);
  const wilsonLower = Math.max(0, (centre - margin) / denom);

  // Transition density: 10 failures then 40 passes (a fixed regression) has low
  // density; alternating pass/fail has high density. This is what distinguishes
  // "was broken, got fixed" from "genuinely non-deterministic".
  const ordered = [...usable].sort(byTime);
  const flips = ordered.reduce((n, a, i) =>
    i > 0 && isFailure(a) !== isFailure(ordered[i - 1]!) ? n + 1 : n, 0);
  const transitionDensity = ordered.length > 1 ? flips / (ordered.length - 1) : 0;

  return {
    score: 0.6 * wilsonLower + 0.4 * transitionDensity,
    wilsonLower, transitionDensity, weightedN, rawN: usable.length,
    confidence: usable.length >= 30 ? 'high' : usable.length >= 15 ? 'medium' : 'low',
  };
}
```

Worked comparison of why both terms are needed:

| Pattern (last 50) | Raw fail rate | Wilson lower | Transition density | Score | Correct reading |
| --- | --- | --- | --- | --- | --- |
| `P×40 F×10` (broken, then fixed) | 0.20 | 0.11 | 0.04 | 0.08 | not flaky — a regression, since fixed |
| `PFPFPFPF…` alternating | 0.50 | 0.36 | 0.98 | 0.61 | very flaky |
| `P×49 F×1` | 0.02 | 0.00 | 0.04 | 0.02 | not flaky — noise |
| `P×39 F×11` scattered | 0.22 | 0.13 | 0.43 | 0.25 | flaky ← the footer case |

Default flag threshold: `score > 0.15 && rawN >= 10`. Scored **per (test, project)** —
the footer link fails on `firefox-desktop` only, and aggregating across projects would
dilute a 0.34 into a 0.11 and hide it.

---

## Root-cause classification

Deterministic rules over extracted features. The model is invited only to write prose
after the class is already decided.

```ts
export interface FlakeFeatures {
  readonly projectConcentration: number;      // 0..1 — share of failures in one project
  readonly workerCorrelation: number;         // failure rate vs worker count (Spearman)
  readonly coScheduleLift: number;            // P(fail | test X co-scheduled) / P(fail)
  readonly coScheduleSuspects: readonly string[];
  readonly timeoutProximity: number;          // failing duration / configured timeout
  readonly matcherHistogram: Readonly<Record<string, number>>;
  readonly networkFailureRate: number;
  readonly appSpanLatencyOutlierRate: number; // via traceId join to Tempo
  readonly consoleErrorRate: number;
  readonly datasetSizeVariance: number;       // did the seeded dataset shift?
  readonly commitBoundary: boolean;           // failures start sharply at one SHA
  readonly positionInstability: number;       // element bbox moved between polls
}

const RULES: readonly ClassificationRule[] = [
  { class: 'genuine-regression',
    when: f => f.commitBoundary && f.transitionDensity < 0.1,
    action: 'not-flaky', priority: 100 },

  { class: 'test-pollution',
    when: f => f.coScheduleLift > 2.5 && f.coScheduleSuspects.length > 0,
    action: 'isolate', priority: 90 },

  { class: 'resource-contention',
    when: f => f.workerCorrelation > 0.6 && f.projectConcentration > 0.8,
    action: 'reduce-parallelism-or-harden', priority: 80 },

  { class: 'network',
    when: f => f.networkFailureRate > 0.3 || f.appSpanLatencyOutlierRate > 0.5,
    action: 'harden-wait-or-fix-app', priority: 70 },

  { class: 'animation',
    when: f => f.positionInstability > 0.5 && f.matcherHistogram['not-actionable'] > 0,
    action: 'disable-animation-or-wait-stable', priority: 60 },

  { class: 'timing',
    when: f => f.timeoutProximity > 0.85 && dominatedByVisibility(f.matcherHistogram),
    action: 'web-first-assertion-or-raise-budget', priority: 50 },

  { class: 'data-dependency',
    when: f => f.datasetSizeVariance > 0.2,
    action: 'narrow-the-view', priority: 40 },

  { class: 'environment',
    when: f => f.projectConcentration > 0.95,
    action: 'browser-specific-investigation', priority: 30 },
];
```

`data-dependency` encodes a rule from your own `CLAUDE.md`: environments hold full
datasets (61 gyms locally), so a test asserting a fixture card on page 1 of an
unfiltered list passes or fails depending on how many rows the seeder produced that day.
The engine detects that pattern and prescribes the documented fix — narrow the view
first — rather than suggesting a retry.

---

## `atest flaky bisect`

Classification produces a hypothesis. Bisect turns it into a fact by re-running under
controlled perturbations. This is the command that earns the tool its keep.

```ts
export const BISECT_DIMENSIONS = {
  workers:    { values: [1, 2, 4, 6, 8],  tests: 'workerCorrelation' },
  isolation:  { values: ['alone', 'file', 'project', 'suite'], tests: 'coScheduleLift' },
  project:    { values: 'all-configured', tests: 'projectConcentration' },
  colorScheme:{ values: ['dark', 'light'], tests: 'themeSensitivity' },
  network:    { values: ['normal', 'slow-3g'], tests: 'timingSensitivity' },
  animation:  { values: ['reduce', 'no-preference'], tests: 'animationSensitivity' },
} as const;
```

Applied to your real, documented flake:

```
$ atest flaky bisect --test "footer …Stores quick link" --repeat 20

  isolation
    alone      20/20 pass
    file       20/20 pass
    project    18/20 pass
    suite      13/20 pass          ← degrades with co-scheduling

  workers
    1          20/20 pass
    4          19/20 pass
    8          11/20 pass          ← monotonic with load

  project
    chromium   20/20 pass
    webkit     20/20 pass
    firefox    13/20 pass          ← firefox only

  verdict      resource-contention, firefox-specific  (confidence: high)
  mechanism    the click fires before firefox commits the SPA route under load;
               the subsequent toHaveURL assertion polls a stale URL for 5s.
  healable     no — the selector is correct

  recommended
    1. harden: await the navigation response, then assert the URL
         await Promise.all([page.waitForURL('**/stores'), storesLink.click()]);
    2. or quarantine for 14 days:
         atest flaky quarantine --test footer-stores-link \
           --reason "firefox nav race under parallel load" --expires 14d --issue
```

Every line there is measured. The model contributed nothing; it would only be asked to
phrase the "mechanism" sentence.

---

## Quarantine — with an expiry, because your convention demands it

`CLAUDE.md` says: *"Fix or delete promptly — never let the list grow."* The engine
enforces that rather than trusting it.

### Applying a quarantine

A ts-morph codemod adds the tag to the test's existing tag array. The existing
`grepInvert: QUARANTINE_TAG` in `src/shared/config/playwright.ts` does the rest — no new
runtime machinery.

```ts
export async function quarantine(req: QuarantineRequest, ctx: FlakyContext): Promise<Patch> {
  const test = await locateTest(req.testId, ctx);
  const tagArg = test.getTagArgument();               // { tag: ['@acceptance'] }

  if (tagArg.includes(QUARANTINE_TAG)) return Patch.noop();
  tagArg.push(QUARANTINE_TAG);

  // A quarantine without an expiry is a deletion with extra steps.
  test.addLeadingComment([
    `@quarantine ${req.reason}`,
    `flakeScore ${req.flakeScore.toFixed(2)} · class ${req.rootCause}`,
    `expires ${req.expiresAt}  ·  ${req.issueUrl ?? 'no issue linked'}`,
    `added by atest ${ctx.version}`,
  ]);

  await ctx.history.recordQuarantine(req);
  if (ctx.config.integrations.github?.autoIssue) await ctx.github.openIssue(req);
  return test.toPatch();
}
```

Result in the spec — self-documenting, greppable, and it deletes cleanly:

```ts
  /**
   * @quarantine firefox nav race under parallel load
   * flakeScore 0.34 · class resource-contention
   * expires 2026-08-30  ·  https://github.com/…/issues/214
   * added by atest 0.4.1
   */
  test(
    'Given the footer, when a visitor clicks the Stores quick link, then the stores page opens',
    { tag: ['@acceptance', '@quarantine'] },
    async ({ footer, page }) => { … },
  );
```

### Enforcement — the part that keeps the list from growing

```
$ atest flaky expire --ci

  quarantine budget   2 / 5 tests  (0.7% of suite, cap 2.0%)   ✔

  test                                   expires       status
  ─────────────────────────────────────  ────────────  ───────────────
  footer …Stores quick link              2026-08-30    12 days left  ✔
  competitions …results table sorts      2026-08-10    6 days EXPIRED ✗

  ✗ 1 expired quarantine

    Quarantines expire so they get fixed. Choose one:
      atest flaky release --test competitions-results-sort    # verify + un-quarantine
      atest flaky quarantine --test … --expires 14d --justify "waiting on APP-441"
      delete the test

  exit 4 (policy violation)
```

Three enforcement mechanisms, all deterministic:

1. **Expiry** — default 14 days. Extension requires `--justify`, which is recorded.
2. **Budget** — hard cap (default `max(5 tests, 2% of suite)`). Exceeding it fails CI.
   This is the pressure valve that stops quarantine becoming the default response to
   any red build.
3. **Release verification** — `atest flaky release` runs the test 30× under the
   conditions that made it flake (from the bisect record, e.g. `--workers 8` on
   firefox). Passing 29/30 is not passing.

### Smart retry — retry the classified, not everything

Blanket `retries: 2` hides real bugs. Retry policy driven by class:

| Class | Retry? |
| --- | --- |
| `timing`, `network`, `resource-contention` | ✅ retry — the mechanism is genuinely transient |
| `test-pollution` | ❌ retry does not help; the pollution is still there |
| `data-dependency` | ❌ deterministic given the dataset |
| `genuine-regression` | ❌ **never** — this is the failure you want |
| unclassified | ✅ once (current behaviour) |

Emitted as a Playwright-compatible retry predicate so it stays inside the runner rather
than becoming a second scheduler.

---

## Reporting

`atest flaky report --format html` produces a dashboard with:

- **Leaderboard** — score, n, class, trend sparkline, quarantine state.
- **Suite health** — aggregate flake rate over time. This is the number to put on a wall.
- **Per-test drilldown** — outcome timeline coloured by project, feature table, bisect
  history, linked evidence bundles, linked Grafana trace for each failure.
- **Quarantine ledger** — with a days-to-expiry column, sorted ascending.
- **Cost of flake** — CI minutes burned on retries and re-runs attributable to flaky
  tests. The number that funds the fix.

`--format markdown --ci` emits a PR comment. `--format json` feeds anything else.
