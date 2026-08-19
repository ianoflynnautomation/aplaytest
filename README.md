# atest

A control plane around Playwright: failure evidence, flaky-test management, auto-healing,
test impact analysis, and agentic test authoring — designed so that **a green test never
depends on a language model**.

> **Status: Phase 4 (model tier unverified).** `@atest/core`, `@atest/runner-playwright`, `@atest/flaky`, `@atest/heal`,
> `@atest/impact` and the `atest` CLI are real,
> tested, and verified end-to-end against a live application. `@atest/llm` and `@atest/agent`
> are built and fully unit-tested against a scripted client, but **no live model call has ever
> been made** — see "What is unproven" below. The remaining packages are
> declared skeletons. See [docs/09-roadmap.md](./docs/09-roadmap.md) for what lands when, and
> [docs/README.md](./docs/README.md) for the full design.

## Why this exists

Most "AI test automation" swaps a selector at runtime and lets the test go green. That trades
a loud, cheap failure for a silent, expensive one — the repo now claims to test something it
does not, and nobody finds out until a real bug ships.

`atest` inverts it:

- **The LLM is never in the pass/fail path.** CI runs in `strict` mode: no model, byte-identical
  to `playwright test`. Heals are proposed offline, as reviewable git patches.
- **Playwright validates heals, not model confidence.** Every proposal is re-run N times plus
  the rest of its spec file before it is shown to anyone.
- **Every engine has a zero-LLM tier.** The model ranks and explains; it is never the source
  of truth. Missing API key degrades scope, never correctness.
- **Some failures are never healed.** Schema violations and uncaught app errors are the bug —
  repairing them would destroy the most valuable signal a suite produces. That is a guard in
  code, not a policy setting.

## Layout

```
packages/
  core/               @atest/core       ✅ types, taxonomy, locator ranking, evidence, config
  runner-playwright/  @atest/runner-…   ✅ reporter, error parsing, step extraction, assembly
  llm/                @atest/llm        ◐ provider abstraction, caching, budget
  agent/              @atest/agent      ◐ repair agent (ranks pre-verified options)
  heal/               @atest/heal       ✅ candidates, validation, constants patching
  flaky/              @atest/flaky      ✅ scoring, classification, bisect, quarantine
  impact/             @atest/impact     ✅ import graph, hub detection, selection
  report/             @atest/report     ⬜ HTML report and dashboards
  mcp/                @atest/mcp        ✅ MCP façade over the same engines
  cli/                atest             ✅ flaky, bisect, heal, quarantine lifecycle, doctor
docs/                                   ✅ full design specification
```

**Dependency rule:** arrows point down only. Engines may import `@atest/core`; they never
import one another. `core` imports nothing internal — it must stay unit-testable with no
Playwright, no network, and no model.

## Development

```sh
npm install
npm run build        # dual ESM + CJS across the workspace
npm test             # vitest
npm run typecheck
npm run flaky:report # ingest run records and print a flake leaderboard
```

Against a locally running app (`http://localhost:8080`), use
[docs/13-local-testing.md](./docs/13-local-testing.md): `examples/bjjeire-live`
for changing atest, `bjjeire-tests` for proving attach.

## Using it

```sh
atest doctor                     # config, history, versions
atest flaky report               # score and classify every test from run history
atest flaky quarantine --test "<title>" --file <spec> --dry-run
atest flaky expire --ci          # exits 4 on an expired quarantine or a breached budget
atest flaky release --test "<title>" --file <spec>
atest flaky bisect --test "<title>" --file <spec> --repeat 10 --workers 1,4,8
atest heal --constants <constants-file> --spec <spec>   # propose; --apply to write
atest heal list                  # the audit trail
atest heal revert <heal-id>      # restore the file exactly
atest impact --from origin/main  # which specs a diff could affect
atest ci generate --shards 4     # emit a workflow with the execute/analyze split
```

### CI

`atest ci generate` emits a workflow built around one constraint: **the job that runs tests
and the job that holds model credentials are different jobs.** On a pull request the test job
executes specs, fixtures and the Playwright config from the branch — a key in that environment
is one commit away from exfiltration. The analyze job holds the key and runs no application
code at all.

Three properties follow: the merge gate stays deterministic (the job deciding pass/fail cannot
call a model), analyze runs once per workflow rather than once per shard, and a provider outage
cannot turn a red build into an incident. A separate `policy` job is the only place new rules
may block a merge, so the blocking surface stays small and explicit.

Generated output is verified against `actionlint`, `yamllint`, and a zizmor-style pinning
policy — a workflow that fails the consumer's own lint would break the build it was generated
for.

For an IDE agent, add the MCP server. Read-only unless you opt in:

```jsonc
// .mcp.json
{ "mcpServers": { "atest": { "command": "npx", "args": ["atest-mcp"],
                             "env": { "ATEST_MCP_WRITE": "0" } } } }
```

Quarantine has two sources of truth, each authoritative over a different thing: the
`@quarantine` **tag** in the spec decides what runs (a suite that already greps that tag
needs no new machinery, and deleting the test deletes the quarantine), while the git-tracked
**ledger** carries why, since when, and until when. The budget is checked *before* writing —
the point of a cap is to refuse the addition, not to report it next CI run.
```

Everything here is TypeScript, including the build scripts — Node runs them directly.

Requires Node 22+.

## Wiring it into a suite

One entry in the Playwright reporter list. No spec changes, no fixture changes.

```ts
// playwright.config.ts
reporter: [
  ['list'],
  ['@atest/runner-playwright/reporter', {
    // Optional: reuse ids you already mint, so history joins to existing app spans
    // instead of inventing a parallel id space.
    traceId: (test, retry) => testTraceContext(resolveRunId(), test.id, retry).traceId,
  }],
],
```

`ATEST=0` disables it completely. Removing the line removes the framework.

### Richer evidence (optional)

The reporter alone cannot reach into the browser. Adding the capture fixtures gives the
bundle a real accessibility tree, the test ids the app actually renders, and the network
and console ledgers — still with no spec changes, because the fixture is `auto: true`:

```ts
export const test = base.extend({
  ...atestFixtures,
  gymsPage: async ({ page }, use) => {
    await use(bindPage(GymsPageMod, page, 'gymsPage'));
  },
});
```

`bindPage` is a drop-in for the usual binding helper; the extra `name` argument is what
turns *"a selector did not resolve"* into *"`gymsPage.expectCardData({ name: '…' })` failed"*.

### Examples

- [examples/smoke](./examples/smoke) — reporter integration, no server needed.
- [examples/bjjeire-live](./examples/bjjeire-live) — capture fixtures against a real app.

## What is unproven

`@atest/llm` and `@atest/agent` have never made a live model call — there was no API key in
the environment they were written in. Everything around the network boundary is exercised by
a scripted `FakeLlmClient`, so the agent loop, structured-output decoding, the one-shot repair
round, budget enforcement, refusal handling, and every safety guard are genuinely tested. What
is **not** verified is the provider adapter itself: whether the exact request shape is accepted,
and whether real `usage` fields map as expected.

Set `ANTHROPIC_API_KEY` and run `atest heal` against a failing test to close that gap. Until
then the deterministic tier stands on its own, and `atest heal` says so.

## What's actually implemented

90 passing unit tests, plus two live integration checks.

`@atest/runner-playwright`:

- **Reporter** — collects synchronously in `onTestEnd` (two object references), flushes
  asynchronously in `onEnd`. Playwright cannot await `onTestEnd`, and per-test file I/O
  inside a parallel run is exactly the overhead that makes people switch a tool off.
  Reports no status and swallows its own errors to stderr: **a reporting failure must never
  become a test failure.**
- **Error parsing** — recovers matcher, locator, expected/received, and timeout from
  Playwright's prose, which carries none of it as structured data. Strips the ANSI escapes
  Playwright embeds even when stdout is not a TTY.
- **Step extraction** — turns the `test.step` tree into the page-object call trail, and
  finds the *deepest* failing step. Playwright marks every ancestor of a failure as failed,
  so the outermost one is the whole test body and tells you nothing.
- **Capture fixtures** — collect the ARIA tree, the rendered test-id index, and the network
  and console ledgers in the worker, and hand them to the reporter as attachments. Every
  capture is wrapped: a diagnostic that can fail a test is worse than no diagnostic. The
  expensive work runs only on failure, so green tests pay nothing.
- **Sidecar contract** — Zod-validated on read, so a drifted fixture fails loudly with a
  named error rather than silently yielding an empty bundle.
- **Candidate seeding** — ranks the page's test ids against the intended one by
  prefix-weighted distance. On a real page (36 ids) the correct rename scores 0.10 against
  0.30 for sibling fields — the right answer first, with no model involved.
- **Dual ESM/CJS build** — Playwright resolves reporters with `require.resolve`, so the
  reporter entry must load from CommonJS regardless of whether the consumer is ESM and
  regardless of Node version.

`atest` (CLI) — `parseArgs` from Node, no framework dependency. Colour only on a TTY,
detected rather than flagged. Semantic exit codes so CI branches without parsing text; a
mistyped flag exits 2 (usage), never 5 (internal), because reporting a typo as a crash pages
somebody.

`@atest/heal` — Tier 0 only, and entirely deterministic. A model tier would RANK these
candidates by intent; it is never what decides.

- **Two hard gates before anything else.** `NEVER_HEAL` kinds are refused outright — a schema
  violation or an uncaught app error IS the bug, and repairing it deletes the signal. Known
  flaky tests are refused too: healing a flake is a permanent code change made to chase noise,
  and afterwards you have the noise *and* a wrong selector.
- **Finds the missing id, not the first one.** Real page objects build composite locators
  (`getByTestId('gyms-list-item').filter({ has: getByTestId('gym-card-name') })`). Taking the
  first id finds the container, which usually still exists, and concludes there is nothing to
  heal. The page's own test-id index says which one actually went missing.
- **Patches the constants file with ts-morph**, updating *every* constant bound to the literal
  and preserving the file's quote style — a patch that fights the formatter is a patch that
  gets rejected on sight.
- **Playwright decides, not the score.** The target must pass every run, and the collateral
  check compares against a **baseline taken before the patch**: only tests that passed before
  and fail after count as damage. Without that, one pre-existing failure in a file would make
  every heal in that file unproposable.

`@atest/mcp` — a façade, not a second product. It adds no capability the CLI lacks; its value
is a different interaction mode. Five tools, deliberately few — a server with forty makes the
client agent worse at choosing.

- **Read-only by default**, with two independent gates on anything mutating: `ATEST_MCP_WRITE=1`
  *and* an explicit `confirm: true`. A model exploring a failure must not be able to change the
  working tree as a side effect of asking questions.
- **`list_failures` omits the accessibility tree.** Returning full evidence for forty failures
  would blow the client's context in one call; the agent picks one, then fetches its detail.
- **Truncation is always marked.** A silently shortened ARIA snapshot would lead a model to
  conclude an element is absent when it was merely cut off — the wrong answer for healing.
- Screenshots are never inlined, only offered as a URI to fetch deliberately.

`@atest/llm` + `@atest/agent` — the model tier, and the only packages that talk to a model:

- **Injected, never reached for.** Engines take an `LlmClient`, which keeps a model SDK out of
  the reporter (it runs in every test worker, where a credential should never be) and lets the
  agent loop be tested without a key.
- **No sampling parameters.** `temperature`, `top_p` and `top_k` are rejected with a 400 by
  current Opus and Sonnet models — the reflex "temperature 0 for determinism" is now a runtime
  error. Depth is `output_config.effort`.
- **The cache prefix is the system prompt**, and the minimum cacheable length is *not monotonic*
  across models: 512 tokens on Opus 5, 1024 on Sonnet 5, **4096 on Haiku 4.5**. The same
  conventions block therefore caches on the heal path and silently does not on the high-volume
  classify path — no error, just a bill. There is a check for it.
- **Tier 1 ranks; it never invents.** The repair agent is handed candidates Tier 0 already
  verified against the live page, and a choice outside that set is rejected. It cannot be
  consulted at all for a `NEVER_HEAL` kind or a known flaky test, and its pick is validated by
  the same re-run as Tier 0's. The worst a wrong answer costs is a rejected proposal.
- **"This is a real bug" is a first-class outcome**, not an exception path — that is what stops
  an agent rationalising a patch for a genuine application defect.
- **Degradation is a contract.** No key, a bad key, a refusal, or an exhausted budget all
  produce a named reason and fall back to Tier 0. Verified live: with an invalid key the heal
  still completes and reports `tier 1  not used · unavailable`.

`@atest/impact` — static import graph, no model:

- **Explains every selection.** Each spec comes with the import chain that selected it, because
  a selection nobody can explain is a coverage hole waiting to happen.
- **Never drops what it cannot attribute.** A spec that reads its routes from an array has no
  import edge to the page objects it exercises; those are always run.
- **Detects hubs and says so.** Run against a real suite, a page-object change reached 19 of 24
  specs — not through a bug, but because every spec transitively imports the shared Playwright
  config. Reporting "19/24 selected" would be a number that looks like discrimination and is
  not, so it runs everything and names the hub.
- **Route coverage narrows past the hub.** Two independent facts do what the import graph
  cannot: *ownership* (which file calls `page.goto('/gyms')`, scanned statically) and
  *coverage* (which routes each test actually visited, recorded by the fixtures on every run,
  passing or failing). Neither passes through the barrel, so neither is washed out by it. A
  spec with no recorded coverage is always run — nothing is known about it, and dropping it
  would be a guess dressed as a decision.

`@atest/flaky` — entirely deterministic; no model is called anywhere in the package:

- **Scoring** (`score.ts`) — recency-weighted Wilson bound on the **minority outcome**, plus
  transition density. Scoring on the failure rate instead labelled a 12-of-12 failure "FLAKY"
  at 0.45; always-fail is deterministic, and belongs to whoever broke it rather than to the
  quarantine list.
- **Features** (`features.ts`) — project concentration, worker-load delta, co-scheduling lift,
  commit-boundary detection, retry flips, duration ratio. Every value is measured.
- **Classification** (`classify.ts`) — priority-ordered rules, each verdict carrying the
  measurements that produced it. `genuine-regression` and `consistently-failing` outrank every
  flake class, because misfiling a broken test as flaky gets it retried and quarantined
  instead of fixed.
- **Retry policy** — per class, not blanket. Retrying a polluted, data-dependent, or regressed
  test converts a red build into a slow red build, or a false green.
- **Quarantine policy** (`quarantine.ts`) — expiry and budget enforcement, so "fix or delete
  promptly" is mechanical rather than aspirational.
- **Bisect** (`bisect.ts`) — re-runs under controlled perturbations (worker sweep, isolation)
  and reads the result by rule. Probes count only the *target* spec: aggregate stats would
  charge a neighbour's failures to the test under examination and manufacture a
  test-pollution verdict. Reports `not-reproduced` honestly rather than reaching for a cause.
- **Codemod** (`codemod.ts`) — ts-morph, handling all three tag shapes found in real suites.
  Refuses on an ambiguous title rather than tagging the first match, never tags a `describe`
  (which would silence a whole suite), and detects **loop-generated tests**: their titles do
  not exist as literals in source, and one `test()` call there produces every case — so
  tagging it would quarantine all of them. That case gets its own status and says so, instead
  of a bogus "not found" that reads as "your title is wrong".

`@atest/core`:

- **History store** (`history/`) — `node:sqlite`, so there is no native dependency to compile
  on a developer machine or a CI image. Ingestion is idempotent: CI re-runs and shard merges
  replay the same run id, and double-counting would corrupt every derived score.
- **Failure taxonomy** (`taxonomy/kinds.ts`) — 14 kinds, each with heal eligibility and flake
  relevance. `NEVER_HEAL` is a `Set`, checked in code, not a config flag.
- **Deterministic classifier** (`taxonomy/classify.ts`) — ordered rules over real Playwright
  error text. Records which rule fired and which signals it saw, so a wrong verdict is
  debuggable. No model.
- **Locator stability** (`locator/stability.ts`) — strategy ranking (testid → xpath), stability
  deltas, and a prefix-weighted test-id distance for candidate generation.
- **Evidence store** (`evidence/`) — deterministic ids that survive re-analysis on another
  machine, deep redaction applied on the write path so exactly one place can forget it, and
  plain-JSON persistence with schema-version checks.
- **Configuration** (`config/schema.ts`) — Zod-validated, every field defaulted such that an
  empty config yields the *safe* system.

Two ordering decisions in the classifier are load-bearing and covered by tests: `infra` is
checked first (a crashed browser must never reach the healing engine), and contract
violations are checked before any locator rule (if the app threw and an element consequently
never rendered, the exception is the root cause — healing the selector would hide a real bug).
