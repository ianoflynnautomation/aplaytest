# 14 — Integrating atest into the bjjeire pipeline

Written against two real runs and the three repos that produce them. Where a
claim was measured, it says so; where an earlier doc was wrong, it says that too.

| Repo | Role |
| --- | --- |
| `bjjeire-java` | Owns `ci-pr.yml` and `ci-main.yml`. Calls everything else. |
| `bjjeire-ci-templates` | Reusable workflows, SHA-pinned by the caller (`v1.6.2`). |
| `bjjeire-tests` | 114 acceptance tests, 9 Playwright projects. Checked out by the templates. |

---

## What the two runs actually say

| | [33251984798](https://github.com/ianoflynnautomation/bjjeire/actions/runs/33251984798) (PR) | [33253028409](https://github.com/ianoflynnautomation/bjjeire/actions/runs/33253028409) (main) |
| --- | --- | --- |
| Every shard | ✅ success | ✅ success |
| Failed tests | **0** | **0** |
| Flaky tests | 6 | **6** |
| Verdict | ❌ failure | ❌ failure |

Both pipelines went red with **zero failing tests**. The gate in
`playwright-report.yml` is three lines:

```bash
if [ "${FAIL_ON_FLAKY}" = "true" ] && [ "${FLAKY:-0}" -gt 0 ]; then
  echo "::error title=Gate failed::${FLAKY} flaky test(s) ... fix or quarantine them"
  exit 1
fi
```

On main that failure also skipped `promote_images`. Three images were built,
Trivy-scanned, and never promoted to `:main` — a 47-minute pipeline whose
delivery step was cancelled by six retries.

The six are not six problems. They are one, seen from four angles:

| Test | Projects | Attempts |
| --- | --- | --- |
| `…opens Competitions, then the competition list is displayed` | mobile-iphone | failed → passed |
| `…opens Events, then the event list is displayed` | mobile-iphone, webkit-desktop | failed → passed |
| `…opens Gyms, then the gym list is displayed` | mobile-iphone, webkit-desktop | failed → passed |
| `…opens the menu, then every section link is listed` | mobile-iphone | failed → passed |

Every one is a first-paint assertion, on WebKit or a mobile viewport, that
passed on the immediately following retry. Four specs, two engines, one
signature.

**The gate cannot see any of that.** It receives a single integer. It cannot
distinguish six symptoms of one root cause from six independent defects, nor
one bad night from a test that has flipped every week for a month, because
nothing in the pipeline remembers the previous run. `fail-on-flaky: true` is
the only instrument available, and it is a hair trigger wired to the delivery
path.

That gap — a count with no memory — is precisely what the flaky engine fills.
It is also, usefully, the cheapest part of atest to adopt.

---

## The seam: what fits through it, and what does not

atest's designed footprint is one reporter line in
`src/shared/config/playwright.ts`, which writes run records to `.atest/runs`
and evidence bundles to `.atest/evidence`. **Those directories cannot currently
escape the test job.**

- `playwright-tests.yml` (AKS acceptance) uploads `blob-report/` and, on
  failure only, `test-results/**/*.zip`.
- `playwright-docker-tests.yml` (compose smoke) bind-mounts exactly three
  directories into the runner container and uploads the same two paths.

> **Correction to docs 11 and 12.** Both state that evidence egress is
> unblocked because `extra-output-paths` was merged into the templates. It was
> not. `grep -r extra-output` returns nothing in the working tree, nothing on
> `origin/main`, and `git log --all -S extra-output-paths` finds no commit on
> any branch. The input does not exist. Any plan that starts by attaching the
> reporter is blocked on a three-repo change: add the input, cut a release,
> bump the SHA pin in `bjjeire-java`.

There is a way in that needs none of that.

`atest history ingest --playwright-json <file>` is a runner adapter: it reads a
merged Playwright JSON report and produces the same `AttemptRecord` rows the
reporter would, minus the evidence bundle and with a coarser failure kind.
And `playwright-report.yml` **already uploads that exact file** on both
pipelines — `playwright-json-results` on main, `playwright-docker-json-results`
on PRs.

So phase 1 needs:

- no change to `bjjeire-tests` — no reporter, no fixtures, no vendored deps
- no change to `bjjeire-ci-templates` — no new input, no release, no pin bump
- no `ANTHROPIC_API_KEY` — flake scoring is Tier 0 and fully deterministic

One new job in `bjjeire-java`, reading an artifact that already exists.

### The adapter was not fit for this, and has been rebuilt

Pointing the JSON adapter at the real `results.json` from run 33253028409
stored **nothing**:

```
history ingest
  +0 runs · +0 attempts · 0 total
warning 1 file(s) skipped:
  results.json — could not be stored: UNIQUE constraint failed:
    attempts.run_id, attempts.test_id, attempts.project, attempts.retry
```

Chasing that one warning found four more defects behind it. All of them shared
a cause: the adapter **invented** run and test identity instead of reading the
identity the report already carries.

| Defect | Consequence | Fix |
| --- | --- | --- |
| `testId` composed as `file::title` | A different id space from the reporter's `test.id`. Two distinct setup tests collided; `store.ingest` is one transaction, so all 120 attempts rolled back. | Use `spec.id` — Playwright's stable test id, present in the report. |
| `runId` from `Date.now()` | Broke the store's documented idempotency. Re-running the analyze job double-counted every attempt and corrupted every score. | Derive it from the CI build URL, else digest the attempts. |
| `startedAt` = ingest time | Recency decay weighted a replayed archive as heavily as this morning's run. | Take the window from `result.startTime`. |
| `commit` / `branch` / `ci` dropped | Same-commit variance — a "strong" signal in doc 06 — could never fire. | Read `config.metadata.ci`; fall back to the environment. |
| `failureKind` hard-coded `'unknown'` | No routing at all. Worse, doc 06 requires `infra` attempts to be excluded from flake statistics, so every browser crash counted as evidence of flakiness. | Classify from `result.errors` through the existing taxonomy. |

The `spec.id` line is the one that matters most, and not for the collision it
fixes. A composed id is a different id space from the reporter's, so history
gathered now would never join to history gathered after the reporter is
installed — every test would look new, every score would reset, and the old
rows would linger as phantoms. The adoption sequence that starts on JSON and
later adds the reporter is the normal one, so that migration cliff had to not
exist.

The duplicate collapse stays, but as a safety net rather than the fix: with
real ids nothing collapses, and when something does it is **reported**, because
silently discarding an attempt is the same class of bug one level down.

### And one defect in the classifier itself

Classifying real errors immediately produced a wrong verdict. A `locator.click`
timeout was routed `navigation_failure`, on this signal:

```
signals: ["page.goto"]
```

That string came from the **code frame** — the source snippet Playwright quotes
into `error.message`, with a few lines of context either side. The match was on
line 13, `await page.goto('/about')`, which had already succeeded. The failing
call was the `.click()` on line 15.

Every failing attempt in that run carried a code frame. In a UI suite, where
nearly every test navigates somewhere, that contamination is the norm — and the
cost is asymmetric, because `navigation_failure` is `heal: never`. A false match
silently withdraws a genuinely healable failure from the healing engine and
gives no sign it did so. This affects the reporter path identically; it was not
a JSON-path problem.

Fixed with `stripCodeFrame`, applied inside `classify()` rather than at each
call site — there are two call sites today, a caller who forgets gets silently
wrong verdicts, and "silently wrong" is the one failure mode a router must not
have. Evidence bundles keep the full message; only the matching input is
stripped.

### Verified against the real artifact

```
history ingest
  +1 runs · +121 attempts · 1 total       ← 121, not 120: the collapsed row was real

--- run row (all derived from the report, not the clock) ---
  runId       pwjson_a6f9fb6196d7
  startedAt   2026-08-29T13:01:10.343Z → 2026-08-29T13:24:43.766Z
  commit      7cbe7c37dee1685ddcbc7e1f37275e6eae9e210e
  ci: 1  workers: 44  playwright: 1.61.0

--- failure kinds ---
  locator_not_found        5
  locator_not_actionable   1
```

The run window matches the real job timings, the commit is the one under test,
and all six failures are routed. Ingesting the same file twice is a no-op.

Ten distinct runs — each with its own build id and shifted timestamps — clear
`minRuns` and produce the leaderboard the gate cannot:

```
score   n  verdict    class      test
 0.56  20  FLAKY      timing     …opens Competitions, then the competition list…
 0.56  20  FLAKY      timing     …opens Events, then the event list is displayed
 0.56  20  FLAKY      timing     …opens Gyms, then the gym list is displayed
 0.56  20  FLAKY      animation  …opens the menu, then every section link is listed
 0.00  10  not flaky             (109 others)
```

Before the rebuild those read `unclassified` and `environment`. Now five are
`timing` and the sixth is `animation` — which is exactly what its evidence says:
the element resolved, then never became stable. Drilling in:

```
  class         timing (medium confidence)
  prescription  web-first-assertion
  retry helps   yes
  evidence      · 100% of failures are waiting for something that never appeared
  evidence      · failing runs take 1.8× as long as passing ones — the test waits, then gives up
```

That is a triage list with a prescription. `FLAKY: 6` is not.

484 tests pass, typecheck clean, and the packed tarballs install and run in a
clean project exactly as the CI job invokes them.

*(The ten-run replay is a plumbing proof, not a verdict — it replays one run's
outcomes across ten synthetic days. Real scores need ten real runs.)*

---

## Phase 1 — shadow mode

`examples/ci/atest-analyze.yml` is the job, ready to paste into `ci-main.yml`
and `ci-pr.yml`. It is `continue-on-error: true` and gates nothing.

| Step | Notes |
| --- | --- |
| Install atest | `oras pull ghcr.io/<owner>/atest-packages:<tag>` then `npm i vendor/*.tgz`. Published by the atest repo's `oci-publish.yml`; needs only `packages: read`. This replaced 468 KB of tarballs vendored into git — binaries nobody could review, with no record of which commit produced them. Pulled as ONE bundle because each tarball declares `@atest/core@^0.1.0`: install any one alone against a registry that does not yet have that version and npm 404s. |
| Download JSON | `playwright-json-results` (main) / `playwright-docker-json-results` (PR). Already uploaded. |
| Restore history | *No such step.* The store IS the Azure container: one immutable object per run and shard, so there is no single file to download, merge and race on. |
| Ingest | `--playwright-json`. Identical on every branch — off main the URL carries `?readonly=1`, so the run is scored against trunk and leaves nothing behind. |
| Flake report | `--json`, rendered into `$GITHUB_STEP_SUMMARY`. |
| Trim history | `--keep-days 90`, main only. The account also carries a lifecycle policy at 120 days as a backstop. |

Two decisions worth defending:

**Only main writes history.** A flake baseline should describe trunk. A PR that
introduces an unstable test must not enter the baseline before anyone has
decided to merge it. Enforced by Entra, not by YAML: `gha_atest_history`
federates on `refs/heads/main` alone and is the only principal holding
Contributor, while the PR identity holds Reader. The blob naming scheme removes
the concurrent-write race independently, so this split is bought for its
semantics rather than for its locking.

**The Azure blob store, not `actions/cache`.** Cache was the zero-infrastructure
start, and its eviction (7 days idle, 10 GB) cost a rebuild of the rolling
window — scores returning to "insufficient data" for a while. That is exactly
the symptom a correctly working engine also produces, which makes it the worst
available failure. The terraform in doc 12 is applied on dev; the container is
cheap (~50 MB a quarter) and does not evict.

> **`atest history export --to-branch` does not exist,** and is no longer
> needed. Earlier drafts recommended an orphan branch holding a SQLite file.
> The CLI implements `history stats`, `ingest` and `prune`, and `--db` takes a
> URL — a path for a local file, `azblob://<account>/<container>` for Azure.
> There is nothing to export because there is no file to move.

### Then wait

`minRuns` is 10, and only main writes. Expect "insufficient data" for a week or
two. `atest history stats` says so explicitly, which is the point — tell the
team before someone reads it as broken.

**Do not turn on the PR comment before the wait is over.** A flake engine that
says "insufficient data" for a fortnight loses its credibility before it has
had a chance to be useful.

---

## Phase 2 — move the flake gate off the hair trigger

Only once the leaderboard has real data behind it.

Today `fail-on-flaky: true` blocks on a count. Replace it with a policy that
blocks on *hygiene*:

1. Set `fail-on-flaky: false` on `acceptance_ephemeral` and `compose_smoke`.
2. Quarantine what the leaderboard actually indicts, with an expiry and an
   owner: `atest flaky quarantine --test "…" --file … --reason … --expires 14d`.
   The suite already has `grepInvert: /@quarantine/` in
   `src/shared/config/playwright.ts`, so the tag takes effect with no config
   change.
3. Add `atest flaky expire --ci` as a **separate, blocking** job. It exits 4 on
   an expired waiver or a breached quarantine budget.

The blocking surface stays exactly one job, and what it blocks on changes from
"a test retried" to "somebody quarantined a test a fortnight ago and never came
back". The second is a real merge-worthy failure; the first is weather.

This is the step that turns two red pipelines green without lowering the bar —
and it is the reason to do phase 1 first, because quarantining a test you
cannot yet score is just deleting coverage.

---

## Phase 3 — evidence, and everything that needs it

Healing, the failure taxonomy, ARIA candidate ranking, and RCA all need the
evidence bundle, which needs the reporter, which needs egress. That is the
three-repo change:

1. **`bjjeire-ci-templates`** — add an `extra-output-paths` input to
   `playwright-tests.yml` (a second upload step; the job already runs in a
   `container:`, so the workspace is the mount) and to
   `playwright-docker-tests.yml` (an extra `-v` per path, because that one is
   `docker run --rm` and anything outside the three bind mounts is deleted with
   the container). Release `v1.7.0`.
2. **`bjjeire-java`** — bump the SHA pin, pass `.atest/runs` and
   `.atest/evidence`.
3. **`bjjeire-tests`** — vendor the two tarballs, add
   `reporters.push(['@atest/runner-playwright/reporter'])` to `activeReporters()`.

Two traps, both already measured, both worth restating because they are silent:

- **`upload-artifact` excludes dot-directories by default.** `.atest/` needs
  `include-hidden-files: true` or a non-hidden path. Without it the upload
  succeeds, uploads nothing, and the analyze job reports success on an empty
  directory.
- **The `api` project must use `atestApiFixtures`, not `atestFixtures`.** The
  UI fixture is `auto: true` and destructures `page`, so Playwright launches a
  browser for every test in the project — including the two API shards, which
  currently launch none.

Before any of it, verify the property that makes the rest arguable: run the
suite once with and once without the reporter line and compare exit codes. It
costs one run.

---

## Not recommended yet

- **`atest ci generate`** — emits a self-contained workflow that assumes it
  owns the pipeline. This one delegates execution to a SHA-pinned shared
  template. Read it for the analyze job's shape, not as a drop-in.
- **Impact analysis** — the acceptance suite is 28 minutes and the selection
  rules force a full run on `src/shared/**` changes, which is most of what
  moves. Revisit when the suite is the bottleneck; right now the flake gate is.
- **`heal --apply`, `agent author`** — both need a model key and phase 3's
  evidence. Neither belongs in the merge path.

Scale is still unproven: the largest run atest has processed before this one
was four tests, against 120 attempts here. Shadow mode is how that gets
answered — reporter or no reporter, nothing gating, and a look at whether the
verdicts match what you would have written down yourself.

---

## Related

| Doc | Covers |
| --- | --- |
| [08 — CI/CD](./08-cicd.md) | The execute/analyze credential split |
| [11 — Adoption runbook](./11-adoption-bjjeire.md) | The reporter path (phase 3 here) |
| [12 — Azure history](./12-azure-history.md) | The blob layout, the terraform, and why main writes while PRs read |
| [06 — Flaky](./06-flaky.md) | Scoring, `minRuns`, and what the classes mean |
