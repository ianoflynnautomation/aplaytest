# 11 — Adoption runbook for `bjjeire-tests`

Written against the real repository and the real pipeline, and revised after
every step below was actually run. Where something was measured rather than
reasoned about, it says so — several things that looked obviously fine were
not.

**Order matters here.** Each step is only useful once the previous one works,
and step 6 is a wait no amount of engineering shortens.

---

## The shape of the integration

atest's footprint inside your test job is **one reporter line**. Everything
else — flaky scoring, healing, reporting, the gate — runs afterwards, on
artifacts, on a different runner. Nothing needs the cluster, and deleting that
line removes the framework.

That matters for your pipeline specifically, because you do not own the job
that runs tests: `bjjeire-java`'s `ci-main.yml` calls
`bjjeire-ci-templates/playwright-docker-tests.yml`, which builds a runner image
from your `Dockerfile` and executes shards inside it. atest has to fit through
that seam rather than replace it.

> **`atest ci generate` does not fit this repo.** It emits a self-contained
> workflow that assumes it owns the pipeline. Yours delegates execution to a
> shared template. Use it as a reference for the analyze job's shape — the
> credential split, the history steps — not as a drop-in.

---

## Step 1 — Evidence has to escape the container

**Status: unblocked** (`extra-output-paths`, merged).

Tests run as `docker run --rm` with three bind mounts:
`playwright-report`, `test-results`, `blob-report`. Anything written elsewhere
is in the container's writable layer, which `--rm` deletes. Measured with a
real container: a run record written to `.atest/runs/` left **zero files** on
the host.

In the caller (`ci-main.yml`):

```yaml
extra-output-paths: |
  .atest/runs
  .atest/evidence
```

Without this, everything downstream reads an empty directory and reports
success on nothing.

---

## Step 2 — Install atest

It is not on any registry. `npm run pack` in the atest repo emits a tarball per
package. That is the path for testing UNRELEASED edits; for anything else
install from npm, where the packages carry real semver on each other:

```sh
# in bjjeire-tests
npm i -D @atest/runner-playwright
```

To pin a build that was never released, copy the tarballs and install them
**in one command** — each declares `@atest/core@^0.1.0`, and asking for one
alone resolves that against the registry, giving you the last released core
rather than the one you just built.

```sh
# in atest
npm run pack
cp dist-pack/*.tgz ~/Sources/bjjeire-tests/vendor/

# in bjjeire-tests
npm i ./vendor/*.tgz
```

`file:` specifiers survive `npm ci`, so the runner image needs no change beyond
copying `vendor/` before the install — which the existing `COPY . .` already
does.

**Verified inside your actual container**: the same base image
(`mcr.microsoft.com/playwright:v1.61.0-noble`), the same `pwuser`, the same
`--ignore-scripts` install. Node 24.16.0 there, `node:sqlite` present, and a
failing test produced a full evidence bundle — 704-char ARIA snapshot, 10 test
ids, a ranked candidate, the network ledger — which reached the host through
the `extra-output-paths` mount.

---

## Step 3 — Attach the reporter

Your reporter list is **computed**, not a literal:
`src/shared/config/playwright.ts` builds it conditionally and all five configs
share it. `atest init` deliberately declines to rewrite that — a regex that
half-understands a config produces a file that still parses and no longer does
what its author meant — and instead points at the file to edit.

```ts
// src/shared/config/playwright.ts, inside activeReporters()
reporters.push(['@atest/runner-playwright/reporter']);
```

Run `atest init --cwd . ` first to see what it would do; it also adds the
`.gitignore` block, and `--undo --apply` removes both.

**Verify the property that matters before anything else:** the reporter must
not change the verdict. Run the suite once with and once without the line and
compare exit codes. atest's own CI asserts this, but asserting it in your repo
costs one run and buys the argument for shadow mode.

---

## Step 4 — Capture fixtures, and the one that will bite you

Optional, and **project-specific**. This is the step most likely to go wrong
quietly:

| Project | Import | Why |
| --- | --- | --- |
| `chromium-desktop`, `firefox-desktop`, `webkit-desktop`, `chromium-wide`, `mobile-*`, `snapshots`, `a11y` | `atestFixtures` | Needs a page |
| **`api`** | **`atestApiFixtures`** | **Must not mention one** |

`atestFixtures` is registered `auto: true` and declares `{ page }`. Playwright
reads fixture dependencies from that destructuring pattern, so an auto fixture
naming `page` **launches a browser for every test in the project** — including
API tests that only touch `request`.

Measured: an API-only spec given the UI fixtures still *passed*, and against an
uninstalled browser failed with `browserType.launch: Executable doesn't exist`.
Under `atestApiFixtures` it passed in 24ms. Across your three API shards the
wrong choice is pure cost, and it is a behaviour change to a pipeline that
previously launched nothing.

The API variant is not a stub: it wraps `request` and records the HTTP calls
the test made, which is usually the whole question on an API failure.

---

## Step 5 — Persist history

See [12 — Persisting run history on Azure](./12-azure-history.md).

**Main writes, pull requests read.** Not only concurrency control (though it
removes the race for free): a flake baseline should describe trunk, and a PR
that introduces an unstable test must not enter the baseline before anyone has
decided to merge it. Your `gha_pr_env` identity already federates separately
for `pull_request` and `refs/heads/main`, so the split falls out of
infrastructure you have.

Sharding is worth calling out here, because it was broken in a way that would
have quietly discarded most of your data. Every shard shares one run id so they
can be merged — which meant every shard wrote the same filename, and an empty
shard's record overwrote a full one. Three fixes later a 3-shard run stores all
four attempts and re-ingests idempotently, and atest's CI asserts it. Your
matrix is up to 6 shards × 9 projects; the failure mode was keeping one file in
fifty-four.

---

## Step 6 — Wait

`minRuns: 10`. Until ten main-branch runs have accumulated, every flake verdict
reads "insufficient data". `atest history stats` says so explicitly rather than
returning an empty report.

**Do not turn on the PR comment before this.** A flake engine that says
"insufficient data" for a fortnight is how a tool loses credibility before it
has had a chance to be useful.

---

## Step 7 — Then, in order of risk

1. **PR comment** — read-only, informative, `continue-on-error`.
2. **`atest gate`** on request, against a spec you are already suspicious of.
   It answers "does this test assert anything?", and it applies to
   human-written tests as readily as generated ones.
3. **`atest heal --dry-run`** — proposals only. Never in the merge path.
4. **`atest agent author`** — needs `ANTHROPIC_API_KEY`, and produces a
   candidate that must pass the gate before it is kept.

`atest flaky expire` is the only command intended to block a merge, and only on
quarantine hygiene: a waiver that has outlived its expiry.

---

## What is still unproven

Honesty about scope, because the defect rate on new surface has not flattened:

- **Your project matrix.** `snapshots`, `a11y`, and both mobile projects have
  never run with the reporter attached. Sharding is now tested; those are not.
- ~~The runner image.~~ **Now proven.** Built against the same base image,
  same `pwuser`, same `--ignore-scripts` install; a failing test produced a
  complete evidence bundle that reached the host through the mount.
- **Scale.** The largest run atest has processed is four tests. Yours is a full
  acceptance suite across nine projects.
- **`@atest/llm` at volume.** Live calls work — repair and authoring both
  produced correct output against the real app — but only a handful of them.

None of these are reasons not to start. They are reasons to start in shadow
mode: reporter attached, nothing gating, and a look at whether the evidence
matches what you would have written down yourself.

---

## Related

| Doc | Covers |
| --- | --- |
| [08 — CI/CD](./08-cicd.md) | The credential split and why analyze holds the key |
| [12 — Azure history](./12-azure-history.md) | The blob store, terraform, and the main/PR split |
| [06 — Flaky](./06-flaky.md) | What the scores mean and why `minRuns` exists |
