# `atest` — Agentic Test Framework

> Design specification. Target: a Playwright-native control plane that adds agentic
> authoring, auto-healing, flaky management, and test-impact analysis — without
> making a green test depend on a language model.

Grounded against a real Playwright suite (hundreds of acceptance tests, multiple
projects, sharded CI, OpenTelemetry tracing, a seeded-data oracle). Every design
choice below is checked against "does this survive contact with a suite like that?"

## Documents

| #   | Doc                                                | Covers                                                   |
| --- | -------------------------------------------------- | -------------------------------------------------------- |
| 00  | this file                                          | TL;DR, core decisions, degradation contract              |
| 01  | [Architecture](./01-architecture.md)               | Components, data flow, Evidence Bundle, failure taxonomy |
| 02  | [Project structure](./02-project-structure.md)     | Monorepo layout, packaging, key files                    |
| 03  | [CLI](./03-cli.md)                                 | Command surface, flags, output design                    |
| 04  | [Agent runtime](./04-agent-runtime.md)             | Repair agent, author agent, tools, prompting             |
| 05  | [Healing engine](./05-healing.md)                  | Candidate generation, validation, patch, ledger          |
| 06  | [Flaky engine](./06-flaky.md)                      | Scoring, classification, policy, quarantine hygiene      |
| 07  | [MCP server](./07-mcp.md)                          | Tools, resources, safety model                           |
| 08  | [CI/CD](./08-cicd.md)                              | GitHub Actions, GitLab, history storage, secret split    |
| 09  | [Roadmap](./09-roadmap.md)                         | Phase 0 → 6, with exit criteria                          |
| 10  | [Recommendations](./10-recommendations.md)         | Models, prompting, trade-offs, anti-recommendations      |
| 11  | [Adoption for this repo](./11-adoption-bjjeire.md) | Ordered runbook for `bjjeire-tests`, revised after running each step |
| 12  | [Azure history](./12-azure-history.md)            | Run history as an append-only blob log: layout, terraform, main-writes/PRs-read |
| 13  | [Local testing](./13-local-testing.md)            | Dev loop against a local app (`localhost:8080`), live example + `bjjeire-tests` |
| 14  | [bjjeire CI integration](./14-bjjeire-ci-integration.md) | Reviewed against two real runs: the flake gate, the zero-touch analyze job, phasing |

---

## TL;DR

`atest` is a **control plane around Playwright**, not a replacement for it. Playwright
still discovers, schedules, and executes tests. `atest` adds:

1. An **Evidence Bundle** — a normalized, LLM-ready record of every failure.
2. A **History Store** — every attempt, keyed by the trace id you already generate.
3. Engines that consume both: **heal**, **flaky**, **impact**, **agent**.
4. Two front-ends over one core: a **CLI** (the product) and an **MCP server** (a façade).

```
                    ┌──────────────┐        ┌──────────────┐
                    │  atest CLI   │        │  MCP server  │
                    └──────┬───────┘        └──────┬───────┘
                           └──────────┬────────────┘
                                      ▼
                            ┌──────────────────┐
                            │   Core Engine    │
                            └────────┬─────────┘
       ┌──────────┬──────────┬───────┼────────┬──────────┬──────────┐
       ▼          ▼          ▼       ▼        ▼          ▼          ▼
   Runner     Evidence   History   Heal    Flaky     Impact     Agent
  (Playwright) Store      Store   Engine   Engine    Engine    Runtime
```

---

## The seven core decisions

### D1 — The framework is a layer, not a rewrite

You have 271 tests, per-platform snapshot baselines, and a reusable CI workflow pinned
by SHA from the app repo. Any design that requires rewriting specs is dead on arrival.
`atest` attaches via a Playwright **reporter plugin** plus an optional **fixture wrapper**.
Removing `atest` leaves a working suite.

### D2 — The LLM is never in the pass/fail path of a green test

Three execution modes, and the default is the boring one:

| Mode       | LLM       | Behaviour                                                                          | Where           |
| ---------- | --------- | ---------------------------------------------------------------------------------- | --------------- |
| `strict`   | never     | Byte-identical to `playwright test` today. Evidence captured; nothing is adapted.  | **CI default**  |
| `assisted` | post-hoc  | Failures still fail. After the run, LLM produces heal proposals + RCA as artifacts. | CI analyze job  |
| `agentic`  | in-loop   | Agent may act, retry alternate paths, author tests.                                | Local / nightly |

A test that passes because a model repaired it at runtime is not a test — it is a
model's opinion with a green tick. `strict` is what gates merges.

### D3 — Heals target source code, not a runtime override cache

A heal produces a **git patch** against `src/ui/pages/<feature>/<feature>.constants.ts`
(or the page object), reviewed like any other change. There is no runtime selector
substitution table, because that makes the repo lie about what it tests.

Your constants files make this tractable: a selector heal is a one-line diff in a
30-line file with no logic in it.

### D4 — History is keyed by the trace id you already mint

`src/shared/otel/trace-context.ts` derives a deterministic trace id from
`(runId, testId, retry)`. `atest` reuses it verbatim as the history primary key. The
payoff: a flaky-test row joins directly to the app's server spans in Tempo, so
"this test is flaky" becomes "this test fails when the `GetGyms` span exceeds 4s,
which happened in 9 of 11 failures" — measured, not guessed.

### D5 — Every engine has a zero-LLM tier

| Engine | Tier 0 (no model)                                          | Tier 1 (model)                          |
| ------ | ---------------------------------------------------------- | --------------------------------------- |
| Heal   | Candidate locators from ARIA tree + testid edit distance   | Rank candidates by *intent*, explain    |
| Flaky  | Wilson-bounded score, transition density, signal features  | Narrative root-cause + fix suggestion   |
| Impact | Static import graph + runtime coverage map                 | Cross-repo (app diff → test) mapping    |
| Agent  | n/a — reports "LLM required" and exits 3                   | The whole thing                         |

The model is a **ranker and an explainer**. It is never the source of truth. This is
what makes graceful degradation structural rather than a fallback branch.

### D6 — A heal is accepted by Playwright, never by model confidence

Every proposal is validated by *re-running the failing test with the candidate applied*,
N times, in the same project, plus the rest of the file to catch collateral damage.
Confidence scores order the queue; they never authorize a change.

### D7 — Assertion heals are propose-only, forever

Selector healing recovers a lost address. Assertion healing changes what the test
*proves* — and an assertion heal that turns red green is indistinguishable from
deleting the test. The canonical case is a mapper that still emits `'EVENT'` because
the deployed build lags the fixed app. Resolving that
correctly required knowing a deploy was pending. No model has that context; a human
does. Assertion heals may be proposed with evidence, never auto-applied.

---

## Degradation contract

What every command does with `ANTHROPIC_API_KEY` unset, the provider down, or
`--no-llm` passed. This is a contract, not best-effort:

| Command                | Without a model                                                          |
| ---------------------- | ------------------------------------------------------------------------ |
| `aplaytest run`            | Full function. Evidence + history recorded.                              |
| `aplaytest report`         | Full function, minus the "insights" section.                             |
| `aplaytest flaky analyze`  | Scores + deterministic classification. No narrative.                     |
| `aplaytest flaky report`   | Full function.                                                           |
| `aplaytest quarantine`     | Full function.                                                           |
| `aplaytest impact`         | Full function (in-repo). Cross-repo mapping degrades to "run everything". |
| `aplaytest heal`           | Tier-0 candidates, validated. Typically resolves ~60% of selector drift. |
| `aplaytest agent`          | Exits 3 with `llm_unavailable`. Never silently no-ops.                   |
| `aplaytest mcp serve`      | Serves; agent/authoring tools return a typed `unavailable` error.        |

Rule: **no command silently changes behaviour when the model is missing.** It either
works, works with a reduced-scope banner, or exits non-zero with a named reason.

---

## What this explicitly is not

- Not a natural-language test suite. Specs stay TypeScript: reviewable, diffable,
  greppable, deterministic. NL is an *input* to authoring, never the stored artifact.
- Not a self-modifying CI. Nothing merges itself.
- Not an agent-framework adoption. The loops are ~200 lines each; LangChain-class
  dependencies are churn liability in a tool whose job is stability.
- Not a vector database. This repo is ~150 source files. `ripgrep` plus a TypeScript
  import graph beats embeddings on both accuracy and latency at this scale.
