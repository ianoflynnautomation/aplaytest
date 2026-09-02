# 03 — CLI

The CLI is the product. MCP is a façade over it (07). CI drives it (08). Design
principles:

- **Playwright flags pass through unchanged.** `--project`, `--grep`, `--shard`,
  `--workers`, `--repeat-each`, `-g` all mean exactly what they mean today. Anyone who
  knows `playwright test` already knows `atest run`.
- **Every mutating command has a dry-run and prints a diff before acting.**
- **Exit codes are semantic.** CI branches on them without parsing text.
- **TTY output is rich; non-TTY output is plain and greppable.** Detected, not flagged.
- **`--json` on every read command.** The CLI is also an API.

## Command surface

```
atest <command> [options]

  BUILT
  init                      Attach the reporter; --undo removes it
  flaky <sub>               report | quarantine | release | bisect | expire
  heal [list|revert]        Propose selector heals from captured evidence
  impact                    Which specs a diff could affect
  history <sub>             stats | ingest | prune
  report                    Merge shards; HTML report + PR comment
  gate                      Does a test actually assert anything?
  agent author              Generate a test, then prove it asserts something
  ci generate               Emit a CI workflow with the execute/analyze split
  doctor                    Verify configuration, history, and versions
  (atest-mcp)               MCP server — the `@atest/mcp` binary, not an
                            `atest` subcommand

  DESIGN ONLY — described in this document, not implemented
  run                       Dropped deliberately; see the section below
  analyze                   Split into `report` and `flaky report`
  agent repair              The engine exists; `atest heal` drives it
  agent explore | chat      Roadmap phase 6
  history export | import   Covered by `history ingest` and `--json` output
  ci validate               Not built
  mcp serve                 The server exists, but as the `atest-mcp` binary
```

> Kept as one list rather than two documents so the gap between what was
> designed and what exists stays visible. Anything under DESIGN ONLY will error
> if you type it.


### Global flags

```
  -c, --config <path>       atest.config.ts            [default: ./atest.config.ts]
      --pw-config <path>    Playwright config to drive [default: from atest.config]
      --mode <mode>         strict | assisted | agentic [default: strict]
      --model <id>          Override the model for this invocation
      --no-llm              Force Tier-0 everywhere. Never fails for lack of a model.
      --budget <usd>        Hard cost cap for this invocation [default: from config]
      --json                Machine-readable output on stdout, logs on stderr
      --quiet / --verbose
      --dry-run             Compute and print; change nothing
      --yes                 Skip interactive confirmation (for CI)
```

### Exit codes

```
0  success / all passed
1  test failures (unchanged from Playwright — CI keeps working)
2  configuration or usage error
3  llm_unavailable (only from `agent` commands; never from run/heal/flaky)
4  policy violation (quarantine budget exceeded, expired quarantine, heal blocked)
5  internal error
```

---

## `atest init`

Interactive, idempotent, and honest about what it changes.

```
$ atest init

  atest — project setup

  ✔ Detected Playwright 1.61.0 (pinned)
  ✔ Found 4 Playwright configs
      playwright.acceptance.config.ts   ← 11 projects  (default)
      playwright.ui.config.ts           ← 10 projects
      playwright.api.config.ts          ←  1 project
      playwright.base.config.ts
  ✔ Detected 271 tests across 31 spec files
  ✔ Detected page-object pattern: function-modules bound via bindPage()
  ✔ Detected selector constants: src/ui/pages/*/*.constants.ts  (5 files, 71 test ids)
  ✔ Detected existing OTel reporter — will reuse its trace ids for history keys
  ✔ Detected quarantine convention: @quarantine + grepInvert

  ? History store              › sqlite (.atest/history.sqlite)
                                 or azblob://<account>/atest-history
  ? Model provider             › anthropic   (ANTHROPIC_API_KEY found in env)
  ? Healing aggressiveness     › balanced — propose selector + role heals, open a PR
  ? Heal targets               › src/ui/pages/**/*.constants.ts

  Will write:
    + atest.config.ts
    + .atest/.gitignore
    ~ .gitignore                          (2 lines)
    ~ src/shared/config/playwright.ts     (1 line in activeReporters)

  ? Apply? › yes

  ✔ Done.  Next:  atest run --grep @smoke
```

The `~` edits are shown as a real diff under `--verbose` and skipped entirely under
`--no-write`. `init` never touches a spec file.

---

## `atest run` — NOT BUILT, and dropped from the roadmap

> Everything in this section is design, not documentation. There is no
> `atest run`, and there will not be: a wrapper owes permanent exit-code and
> behaviour parity with `playwright test` for no capability, and it contradicts
> the principle the rest of the design rests on — that removing the reporter
> line removes the framework. Invoke `playwright test` exactly as before.
>
> The features sketched below live elsewhere: `--analyze` is `atest report` and
> `atest flaky report`, `--impact` is `atest impact`, `--heal` is `atest heal`.
> The section is kept because the footer design it describes is still the
> intended shape of the reporter's output.

Wraps `playwright test`. In `strict` mode the child process is invoked with identical
arguments to what you would have run — the only addition is the reporter.

```
atest run [pw-args...]

  --mode strict|assisted|agentic       [default: strict]
  --project <name>                     (repeatable, passthrough)
  --grep <pattern> / -g                (passthrough)
  --shard <i/n>                        (passthrough)
  --workers <n>                        (passthrough)

  --heal                               shorthand for --mode assisted --then heal
  --analyze                            run `atest analyze` on completion
  --impact                             select tests via impact analysis
  --impact-from <ref>                  diff base                 [default: origin/main]
  --repeat-flaky <n>                   re-run only known-flaky tests n× to refresh stats
  --record-coverage                    harvest route/testid coverage map from traces
  --tag-run <label>                    label this run in history (e.g. nightly)
```

Live output in a TTY: Playwright's own reporter is preserved (you keep `list`), with an
atest footer appended after the run.

```
$ atest run --grep @smoke --analyze

  Running 28 tests using 6 workers  … [playwright's own output] …

  27 passed  1 failed  (18.4s)

  ─── atest ────────────────────────────────────────────────────────────────────

  1 failure captured

  ✗ gyms.ui.acceptance.spec.ts:47  chromium-desktop
    Given a gym name, when a visitor searches, then only that gym is displayed

    kind        locator_not_found
    intent      gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' })
    selector    getByTestId('gym-card-name')          ← gyms.constants.ts:20  TEST_IDS.cardName
    page        /gyms  ·  46 test ids present  ·  'gym-card-name' NOT among them
    history     47 runs · 46 passed · first failure at this commit
    verdict     not flaky — likely a real selector change   (confidence: high, no model used)

    evidence    .atest/evidence/2026-08-16T14-02-11Z/ev_9f3a21
    next        atest heal --failure ev_9f3a21

  ─── flaky ────────────────────────────────────────────────────────────────────
  no new flake signals · 2 tests above threshold (atest flaky report)
```

Note what that block does with **no model at all**: it names the failing intent, points
at the exact source line of the selector constant, proves the testid is absent from the
page, and separates "new regression" from "known flake" using history. That is the
majority of debugging value, delivered deterministically.

---

## `atest heal`

```
atest heal                              propose heals for the latest run's failures
atest heal --failure <evidenceId>       one failure
atest heal --run <runId>
atest heal list                         open proposals
atest heal show <healId>                full diff + validation record + reasoning
atest heal apply <healId|--all>         write to the working tree
atest heal revert <healId>              restore the prior source
atest heal pr [--all]                   open a PR on atest/heal/<runId>

  --aggressiveness off|conservative|balanced|aggressive   [default: config]
  --strategies selector,assertion,flow                    [default: selector]
  --validate <n>          validation re-runs required to accept   [default: 3]
  --no-collateral         skip re-running the rest of the file (faster, riskier)
  --min-stability <rank>  reject heals below this locator class   [default: 4]
```

```
$ atest heal --failure ev_9f3a21

  Analyzing 1 failure …

  ✔ Tier 0 — 4 candidates from the ARIA tree and testid index
  ✔ Tier 1 — ranked by claude-sonnet-5 (1 call, 4.1k in / 210 out, $0.014)
  ✔ Validation — 3/3 passes, 9/9 collateral tests in gyms.ui.acceptance.spec.ts

  heal_2f81c0   selector   confidence 0.94   stability +0 (testid → testid)

    src/ui/pages/gyms/gyms.constants.ts
    ────────────────────────────────────────────────
    @@ -18,7 +18,7 @@ export const TEST_IDS = {
       cardAddressLink: 'gym-card-address-link',
    -  cardName: 'gym-card-name',
    +  cardName: 'gym-card-title',
       cardWebsiteLink: 'gym-card-website-link',

    why   'gym-card-name' is absent from /gyms. 'gym-card-title' is present, appears
          once per list item, and its text matches the seeded gym names. The app diff
          at HEAD renames GymCard's name element. Semantic role unchanged (heading).

    also  GYM_CARD_TEST_IDS.name (line 5) holds the same literal and is used by
          gyms.card.page.ts — included in the patch.

  Apply?  atest heal apply heal_2f81c0        Open PR?  atest heal pr heal_2f81c0
```

The "also" line matters: a codemod that understands the constants file catches the
second occurrence. A regex-replace on the spec would not have.

---

## `atest flaky`

```
atest flaky analyze [--window 50] [--since 14d] [--project <p>]
atest flaky report  [--format table|html|json|markdown] [--ci]
atest flaky bisect  --test <id> [--with-suite] [--workers-sweep] [--repeat 30]
atest flaky quarantine --test <id> --reason <text> [--expires 14d] [--issue]
atest flaky expire  [--ci]        fail if any quarantine is past its expiry
atest flaky release --test <id>   remove @quarantine, run 30× to confirm
```

```
$ atest flaky report

  Flaky leaderboard — last 50 runs, 14 days

  score  test                                                  proj      n   fail  class
  ─────  ────────────────────────────────────────────────────  ────────  ──  ────  ──────────────────
  0.34   footer.ui  “…Stores quick link navigates”             firefox   48    11  resource-contention
  0.19   events.ui  “…filtering by county narrows the list”    webkit    50     6  timing
  0.04   gyms.ui    “…county reset restores other counties”    chromium  50     1  below threshold

  ⚠ 1 test above threshold 0.15 without a quarantine
  ✔ quarantine budget 1/5 used · 0 expired

  footer.ui “…Stores quick link navigates”  ─────────────────────────────────────

    evidence for resource-contention
      · 11/11 failures at workers ≥ 6; 0/30 failures at --workers 1
      · 11/11 on firefox-desktop; 0 on chromium/webkit
      · failing matcher: toHaveURL (navigation did not commit within 5s)
      · app spans (trace join): no server-side latency outlier — client-side stall
      · co-scheduled with snapshot project in 9/11 failures

    suggested next step
      atest flaky bisect --test footer-stores-link --workers-sweep

    (all of the above is deterministic — no model was called)
```

`bisect` is the differentiator. It re-runs the target under controlled perturbations to
turn a hunch into a fact:

```
$ atest flaky bisect --test footer-stores-link --workers-sweep --repeat 20

  workers=1   20/20 pass
  workers=2   20/20 pass
  workers=4   19/20 pass
  workers=6   14/20 pass
  workers=8   11/20 pass

  verdict  load-dependent · failure probability rises monotonically with worker count
  class    resource-contention (confidence: high)
  note     not a selector problem. Healing is not applicable. Options: harden the
           assertion (click → expect(page).toHaveURL with an explicit wait for the
           navigation response), or reduce firefox worker share.
```

---

## `atest agent`

The only command family that requires a model. Exits 3 without one.

```
atest agent author  --goal "<natural language>" [--feature <name>] [--out <path>]
                    [--plan-only] [--keep-rejected] [--dry-run] [--force]

# Not yet implemented — see docs/09-roadmap.md:
#   atest agent repair  --failure <evidenceId>   (the engine exists; `atest heal` drives it)
#   atest agent explore --route /gyms
#   atest agent chat
```

`--dry-run` prints the grounding and exits without spending anything. It is the
first thing to reach for when a generation comes out wrong: it shows exactly which
conventions file, page object, seeded fixtures and exemplars the agent was handed.

`--plan-only` stops after the plan, so a human can reject an approach for the price
of one call rather than reviewing plausible-looking code.

```
$ atest agent author \
    --goal "a visitor filtering events by county sees only that county's events" \
    --feature events

  ground     read CLAUDE.md conventions, events.page.ts (18 exports),
             seeded/events.ts, and two exemplar specs                       [no model]
  plan       4 steps · expects to die from: unfiltered                      [opus-5]
  synthesize spec, constrained to the 18 listed page-object methods

  wrote tests/events-county-filter.spec.ts
  running the falsifiability gate…

  pass  stability       passed 3/3
  pass  falsifiability  killed 1 data mutant(s): unfiltered

  mutants
  SURVIVED     empty-page   tests that assert content is present
  killed       unfiltered   tests that assert a filter or search narrows results
  killed       http-500     tests that touch the app at all — weak evidence on its own

  stable 3/3 · killed 2/3 mutants (unfiltered, http-500) · note: survived empty-page
  spent $0.3100

  tests/events-county-filter.spec.ts is ready for review.
```

The **falsifiability gate** is what makes a generated test trustworthy: a test that
cannot be made to fail is rejected automatically, killing the most common failure mode
of LLM-authored tests — assertions that assert nothing.

**A rejected candidate is deleted, not left for review.** It is green and worthless,
which is the combination most likely to be committed by someone who trusts the tool.
Pass `--keep-rejected` to inspect one.

Run the gate on its own — including on a human-written test — with
`atest gate --spec <file> --test "<title>"`. "Does this test actually assert anything?"
is not a question that only applies to generated code.

---

## `atest impact`

```
atest impact [--from origin/main] [--to HEAD] [--format list|grep|shard-plan|json]
             [--app-repo <path>]   # cross-repo: map an app diff to affected tests
```

```
$ atest impact --from origin/main --format shard-plan

  changed  3 files
    src/ui/pages/gyms/gyms.constants.ts
    src/ui/pages/gyms/gyms.page.ts
    tests/testdata/seeded/gyms.ts

  affected  38 / 271 tests  (14%)   via static import graph      [no model]
    gyms.ui.acceptance.spec.ts       22
    gyms.api.acceptance.spec.ts       9
    gyms.snapshot.acceptance.spec.ts  4
    routes.a11y.acceptance.spec.ts    3   (coverage map: touches /gyms)

  always-run  12 tests   (@smoke, tagged run-always)

  shard plan  2 shards × ~25s
    --shard 1/2 --grep-invert "…"
    --shard 2/2 …

  estimated saving  4m10s → 55s
```

Always-run guards prevent impact analysis from becoming a hole in coverage: `@smoke`
always runs, and any run on `main` ignores impact entirely.

---

## `atest ci generate`

Emits workflows wired to your existing conventions (sharded matrix, blob reports, the
analyze/execute secret split from 08).

```
atest ci generate --provider github --shards 4 --projects api,chromium-desktop,...
atest ci generate --provider gitlab
atest ci validate                  # lints generated workflows: actionlint + policy
```

---

## `atest doctor`

The first thing anyone runs when something is odd.

```
$ atest doctor

  ✔ atest 0.4.1
  ✔ atest.config.ts valid
  ✔ @playwright/test 1.61.0 (peer range >=1.55 ✓, matches CI image ✓)
  ✔ history store  .atest/history.sqlite  · 4,182 attempts · 87 runs · schema v1
  ✔ evidence store 12 runs retained · 214 MB
  ✔ reporter registered in src/shared/config/playwright.ts:38
  ⚠ BASE_URL http://127.0.0.1:8080 unreachable
      → kubectl port-forward -n bjjeire-app service/bjj-frontend 8080:80
  ✔ ANTHROPIC_API_KEY present · claude-sonnet-5 reachable (412ms)
  ⚠ OTEL_EXPORTER_OTLP_ENDPOINT unset — app-span join disabled in flaky RCA
  ✔ quarantine  1 test · 0 expired · budget 1/5

  1 error, 2 warnings
```

## Output design rules

- Colour and box-drawing only when `process.stdout.isTTY`. CI logs stay plain.
- Diffs are unified diffs — pipeable into `git apply`.
- Every failure block ends with a **copy-pasteable next command**. Never "consider
  investigating".
- Model usage is always disclosed inline: which model, how many calls, what it cost.
  A user must never wonder whether a number came from a model or a measurement.
- When a model was *not* used, say so. `(no model used)` is a feature.
