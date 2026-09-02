# 09 — Roadmap

## The ordering principle

**Every subsystem ships its deterministic tier first and its model tier second.**

That is not caution for its own sake. It is how you find out whether the model is adding
anything: if Tier 0 resolves 60% of selector drift, then Tier 1 has to beat 60% to
justify its cost and its risk. Teams that build the model layer first never learn this,
because they have no baseline — and so they cannot tell a good prompt from a lucky one.

A secondary consequence: the tool is useful from week two. Phase 0 delivers a failure
archive and run history with no API key, no prompt engineering, and no trust question.

---

## Phase 0 — Foundation (2 weeks) · no LLM

**Deliver:** every failure is captured, structured, and queryable.

| Component | Scope |
| --- | --- |
| `@aplaytest/core` | `EvidenceBundle` types, evidence store, `HistoryStore` iface + SQLite driver, deterministic `classify()`, config loading |
| `@aplaytest/runner-playwright` | Reporter plugin (CJS + ESM), trace reader, fixture capture for ARIA/network/console |
| `aplaytest` CLI | `init`, `doctor`, `history stats\|ingest\|prune`, `report` |

> `run` and `history query` were dropped rather than built. `aplaytest run` would be
> a wrapper owing permanent exit-code parity with `playwright test`, for no
> capability — and it contradicts the principle that removing the reporter line
> removes the framework. `history query` is covered by `flaky report --json`
> and `history stats --json`.

**Exit criteria**
- `aplaytest run` is byte-identical in behaviour to `playwright test` — same exit code, same
  duration ±2%, same report.
- Every failure produces a bundle with a non-null `ariaSnapshot`, `testIdsPresent`, and
  `intent.failingStep`.
- Removing the reporter line fully removes the framework.
- ≥ 95% of failures classify to something other than `unknown` on a corpus of injected
  breakages.

**Value even if the project stopped here:** the run footer in [03](./03-cli.md) — naming
the failing intent, pointing at the exact constants line, proving the testid is absent,
and separating regression from known flake — is delivered in Phase 0 with no model.

---

## Phase 1 — Flaky engine (3 weeks) · no LLM

**Deliver:** the suite's flakiness becomes a measured, managed number.

- Scoring (Wilson + recency + transition density), per (test, project).
- Deterministic feature extraction and rule-based classification.
- `flaky analyze | report | bisect | quarantine | expire | release`.
- Quarantine codemod against the existing `@quarantine` convention, with expiry and
  budget enforcement.
- HTML dashboard; markdown PR comment.
- CI history persistence via the `atest-history` orphan branch.

**Exit criteria**
- Correctly classifies the known `footer.ui` firefox flake as `resource-contention`,
  with bisect evidence, and does **not** classify it as a selector problem.
- Quarantine budget and expiry can fail a build (exit 4).
- Zero false "flaky" verdicts on a deliberately introduced real regression across a
  10-run corpus.

**Why second:** flake is the pain a mature suite already has, it needs no
model, and it produces the history that healing later depends on for its
"is this flaky or broken?" gate.

---

## Phase 2 — Healing, propose-only (3 weeks) · LLM optional

- Tier-0 candidate generation and live verification.
- Validation harness (scratch worktree, N× re-run, collateral check, typecheck, lint).
- ts-morph selector patching against `*.constants.ts`.
- Heal ledger, `heal list | show | apply | revert`, `heal pr`.
- Tier-1 repair agent behind `--llm`, plus `@aplaytest/llm` with the Anthropic provider.
- Prompt regression corpus (~40 real bundles with known-correct outcomes).

**Exit criteria**
- Tier 0 alone resolves ≥ 60% of injected testid renames end-to-end.
- Tier 1 adds ≥ 20 percentage points on the same corpus, measured — not asserted.
- Zero heals accepted without full validation; zero heals applied for `NEVER_HEAL` kinds
  in adversarial testing.
- Assertion heals are structurally incapable of auto-applying (test the guard, not the
  policy).

**Deliberately not in this phase:** flow healing and auto-apply. Earn trust with the
easy, safe case first.

---

## Phase 3 — Impact analysis (2 weeks) · no LLM

- ts-morph import graph with transitive closure.
- Runtime coverage map harvested during `--record-coverage`.
- `aplaytest impact`, `aplaytest ci plan`, shard planning.
- Full-suite triggers, `@smoke` always-run, 60% threshold guard.

**Exit criteria**
- Never omits a test that the full suite would have failed, across 50 historical
  commits replayed.
- Median PR wall-clock reduced ≥ 50% on feature-scoped changes.
- Every selection is explainable per-test.

---

## Phase 4 — Author agent (4 weeks) · LLM required

- Ground → Plan → Explore → Synthesize → Verify → Reflect.
- Full browser tool set with capability gating and the `REPO_DENY` list.
- Falsifiability gate with mutation generation.
- `aplaytest agent author | repair | explore`.
- Convention retrieval and exemplar selection.

**Exit criteria**
- Generated specs pass typecheck, lint, and convention checks at ≥ 90% first attempt.
- 100% of generated specs kill at least one **data** mutant, or are rejected.
  (Measured refinement: "at least one mutant of any kind" is too weak — `http-500`
  kills almost any test that loads a page, so a vacuous test passed that rule.)
- On a 20-goal benchmark, ≥ 70% of generated tests are merged with no edits or trivial
  edits by a reviewer who did not write the goal.
- Cost per generated test under $1.

The falsifiability gate is the phase's real deliverable. Anyone can get a model to emit
a Playwright file; the hard part is knowing whether it tests anything.

---

## Phase 5 — MCP (2 weeks)

- stdio + streamable-http server, nine tools, resource handlers.
- Safety layer: write gating, `confirm: true`, path confinement, redaction, size caps.
- Handle-and-poll for long operations.

**Exit criteria**
- Every MCP tool calls the identical engine function as its CLI counterpart (asserted by
  a shared test suite that runs both adapters against the same fixtures).
- Read-only by default; mutating tools blocked without `ATEST_MCP_WRITE=1`.
- No response exceeds the token cap without an explicit truncation marker.

---

## Phase 6 — Advanced (ongoing)

Ordered by expected value, not by novelty.

| Capability | Notes |
| --- | --- |
| **Cross-repo impact** | App-repo diff → affected tests. Testid extraction first (deterministic), model-assisted route mapping second, and never narrows below the deterministic set. |
| **Flow healing** | Alternative paths. Human-gated forever. Enable only after selector healing has a low revert rate over months. |
| **Visual AI diffing** | Semantic screenshot comparison: "the button moved 3px" vs "the button is gone". Directly attacks per-platform baseline churn (`-darwin.png` / `-linux.png`). |
| **Self-tuning retry** | Per-class retry policy learned from history rather than configured. |
| **Agentic exploration** | Nightly goal-free crawl of the app, diffing observed behaviour against the coverage map to propose missing tests. Produces proposals, never merges. |
| **Component-test adapter** | Extend the runner adapter to Playwright CT in the app repo, sharing history and healing. |
| **API contract drift** | Watch Zod parse failures across runs to detect wire changes before they break a spec. Pairs naturally with your existing `parseMockBody` guard. |
| **Local model support** | Ollama provider for classification and ranking. Authoring stays frontier-model. |

---

## Timeline

```
        w1  w2  w3  w4  w5  w6  w7  w8  w9  w10 w11 w12 w13 w14
P0 ████████
P1         ████████████
P2                 ████████████
P3                             ████████
P4                                     ████████████████
P5                                                     ████████
P6                                                             ───►
```

~14 weeks to feature-complete with one to two engineers. Phases 0–1 are useful alone,
0–3 covers most of the day-to-day value, and 4–5 are the differentiators.

---

## Metrics — how you know it is working

Track from Phase 0. Every one of these is measurable without a model.

| Metric | Target | Reads on |
| --- | --- | --- |
| Failure classification accuracy | > 95% non-`unknown` | Evidence quality |
| Mean time to diagnose a failure | −60% | The core value proposition |
| Tier-0 heal resolution rate | > 60% | Whether the model is needed |
| Heal acceptance rate | > 80% of proposals | Proposal quality |
| **Heal revert rate** | **< 5%** | **Trust — the number that matters most** |
| Flake rate (attempts) | trending down | Suite health |
| Quarantine count / days-to-expiry | ≤ budget, decreasing | Hygiene |
| PR wall-clock | −50% on scoped changes | Impact analysis |
| Model cost per run | < $0.50 | Economics |
| Generated tests merged unedited | > 70% | Author agent quality |

If heal revert rate climbs above 5%, lower aggressiveness before touching prompts. A
tool that proposes confident wrong patches is worse than one that proposes nothing,
because it spends the reviewer's attention — the scarcest resource in the system.
