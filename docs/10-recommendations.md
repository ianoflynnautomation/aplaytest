# 10 — Opinionated recommendations

Positions, not a survey. Where a trade-off is genuinely close, that is said explicitly.

---

## Model selection

Three roles, three models. The split is by **job shape**, not by a vague "quality" axis.

| Role | Model | ID | Price /MTok (in / out) | Why |
| --- | --- | --- | --- | --- |
| `classify` | Haiku 4.5 | `claude-haiku-4-5` | $1 / $5 | Taxonomy tie-breaks, dedupe, narrative phrasing. High volume, low stakes, deterministic tier already did the real work. |
| `heal` | Sonnet 5 | `claude-sonnet-5` | $3 / $15 | Ranking pre-verified candidates by *intent*. Medium volume, medium stakes. |
| `author` | Opus 5 | `claude-opus-5` | $5 / $25 | Planning, browser exploration, code synthesis. Low volume, high stakes. |

Notes that matter for implementation:

- **Sonnet 5 is at introductory pricing ($2 / $10) through 2026-08-31**, after which it goes to
  $3 / $15. Budget against the standard rate; the intro period is a discount, not a baseline.
- **Haiku 4.5 has a 200K context window** (the others are 1M) and a 64K output cap. An evidence
  bundle never approaches that, but a *batch* classification call over 40 bundles can — chunk it.
- Use the **bare aliases** (`claude-opus-5`, not a date-suffixed variant). They are complete IDs.

### The parameters that changed, and will bite you

Three reflexes that were correct on older models are now **400 errors** on Opus 5 and Sonnet 5:

| Old reflex | Status now | Do this instead |
| --- | --- | --- |
| `temperature: 0` for determinism | **400** — sampling params removed | `output_config: { effort }`. It never guaranteed identical outputs anyway. |
| `thinking: { type: 'enabled', budget_tokens: N }` | **400** | `thinking: { type: 'adaptive' }` + `effort` |
| Assistant-turn prefill to force JSON | **400** | `output_config.format` (structured outputs) — which is what the design already uses |

And one silent change worth budgeting for: **on Opus 5, thinking is on by default.** Omitting the
`thinking` field runs adaptive thinking, and `max_tokens` caps thinking *plus* response text
together. An author-agent call sized tightly around its expected output will truncate mid-answer.
Give it room — 32K+ `max_tokens` on synthesis calls.

Effort settings for this system:

| Agent | Effort | Rationale |
| --- | --- | --- |
| classify | `low` | Rule-based tier already decided; the model is phrasing, not deciding. |
| repair / heal rank | `medium` | Candidates are pre-verified and unique. This is a judgement call between 4 options, not a research task. |
| author — plan & synthesize | `xhigh` | The documented setting for coding and agentic work. |
| author — exploration | `medium` | Driving a browser with a fixed tool set; depth buys little. |

Do not reflexively reach for `max`. It is prone to overthinking on scoped tasks, and heal ranking
is a scoped task.

### Vision, gated

Screenshots are the expensive input and are usually redundant against the ARIA snapshot. Send
images **only** for `visual_diff` (what changed?) and `locator_not_actionable` (what is covering
it?). Everything else — renames, missing elements, ambiguity, assertions — is answerable from ARIA
at a small fraction of the tokens.

---

## Prompt caching — where the real savings are

Cache economics: **reads cost ~0.1× base input; writes cost 1.25× (5-minute TTL) or 2× (1-hour
TTL)**. With the 5-minute TTL, two requests break even. An analyze job processing 5–40 failures
sequentially is far past break-even on the first two.

Structure every prompt cache-prefix-first:

```
[ system prompt ][ repo conventions ][ page-object API surface ][ exemplar specs ]  ← cacheable, identical all run
                                                            ↑ cache_control breakpoint
[ this failure's evidence bundle ]                                                  ← varies every call
```

**The gotcha that will silently cost you money:** the minimum cacheable prefix is
*model-dependent and not monotonic across generations*.

| Model | Minimum cacheable prefix |
| --- | --- |
| Opus 5 | **512 tokens** |
| Sonnet 5 | 1024 tokens |
| Haiku 4.5 | **4096 tokens** |

The classify role runs on Haiku 4.5, so its shared prefix must exceed **4096 tokens** or nothing
caches — no error, just `cache_creation_input_tokens: 0` forever. A trimmed-down conventions block
that comfortably caches on the heal path can silently fail to cache on the classify path. Assert it
in the LLM client:

```ts
// packages/llm/src/cache.ts
const MIN_CACHEABLE_PREFIX: Record<string, number> = {
  'claude-opus-5': 512,
  'claude-sonnet-5': 1024,
  'claude-haiku-4-5': 4096,
};

export function assertCacheable(model: string, prefixTokens: number): void {
  const min = MIN_CACHEABLE_PREFIX[model];
  if (min !== undefined && prefixTokens < min) {
    log.warn(
      `prefix ${prefixTokens}t is below the ${min}t minimum for ${model} — ` +
        `cache_control will be silently ignored`,
    );
  }
}
```

Then verify it is actually working: if `usage.cache_read_input_tokens` is zero across repeated
calls in one run, something is invalidating the prefix. In this system the likely culprits are a
timestamp in the system prompt, non-deterministic JSON key ordering when serialising the
page-object API surface, or a tool list that varies per failure kind. Sort your keys, freeze your
tool list per agent, and keep every varying value after the breakpoint.

---

## What this actually costs

Assumptions: an evidence bundle with a 6k-token ARIA snapshot plus conventions ≈ 8k input tokens,
~400 output tokens. Standard (non-intro) rates.

| Operation | Model | Cost | Notes |
| --- | --- | --- | --- |
| Classify one failure | Haiku 4.5 | **~$0.01** | Only for kinds the rule tier could not resolve |
| Rank heal candidates | Sonnet 5 | **~$0.03** | Falls to ~$0.01 once the conventions prefix is cached |
| Author one test | Opus 5 | **~$0.40–1.00** | ~15 calls; dominated by exploration + synthesis output |
| Explain a run | Haiku 4.5 | ~$0.02 | One call over the run summary |

For this suite — 271 tests, a typical run with 3–5 failures of which 2–3 are healable — a full
`aplaytest analyze` pass lands around **$0.05–0.15 per run**. Even a bad day with 20 failures stays
under $0.50. Test authoring is the only line item worth watching, and it is human-initiated and
low-volume.

Set `llm.budget.perRunUsd` anyway. Runaway agent loops are a real failure mode, and a hard cap
that aborts with a typed error beats discovering it on an invoice.

---

## MCP vs pure CLI

**Build the CLI first. Build MCP in Phase 5. Never use MCP in CI.**

| | CLI | MCP |
| --- | --- | --- |
| Who drives it | Humans, CI, scripts | An IDE coding agent |
| Best at | Reproducible operations, pipelines, gating | Conversational failure exploration |
| Composability | Pipes, exit codes, `--json` | Tool calls |
| Works in CI | Yes — this is its home | No, and it shouldn't |
| Value without the other | Complete product | Nothing to expose |

The argument for CLI-first is not conservatism, it is dependency order: MCP's entire value is
letting an agent explore evidence, history, and heal proposals conversationally. All three must
exist first. Build MCP in Phase 1 and you have a tool surface with nothing behind it — a good demo
and a bad product.

The counter-argument, honestly stated: if your team lives in Claude Code or Cursor all day, MCP is
the interface they will actually touch, and shipping it earlier drives adoption. That is a real
consideration. It still does not change the order, because the MCP tools are ~200 lines of adapter
over engines that must exist regardless. The façade is cheap *because* it is last.

---

## Healing aggressiveness

**Default `balanced`. Propose-only in CI. `aggressive` never in CI.**

| Setting | Use it when |
| --- | --- |
| `off` | You do not trust the tool yet, or the suite gates a regulated release |
| `conservative` | High-stakes suites; testid/role heals only, 5 validation runs, propose-only |
| `balanced` ★ | Default. testid/role/label/text, 3 validation runs, auto-PR |
| `aggressive` | Developer inner loop only — adds flow healing and local auto-apply |

The reasoning: healing's failure mode is **not** "proposes a bad patch." Validation catches those.
The failure mode is **a plausible patch that passes validation while quietly changing what the test
proves** — retargeting a selector to a container element, or healing an assertion into agreement
with a regression. That failure is invisible to every automated check and only a human catches it.
So the aggressiveness dial is really a dial on *how much reviewer attention you are willing to
spend*, and `balanced` is the setting where the proposals are good enough to be worth reading.

Track **heal revert rate** as the governing metric. Above 5%, lower aggressiveness before touching
prompts — a tool that confidently proposes wrong patches is worse than one that proposes nothing,
because it spends the scarcest resource in the system.

---

## Other calls, briefly

**Flaky threshold at 0.15 with `n ≥ 10`.** Lower and you chase noise; higher and real flakes hide
for weeks. Revisit after a month of real data — this is the one number that genuinely needs
calibration against your suite rather than reasoning.

**Quarantine expiry at 14 days, budget at `max(5, 2%)`.** Both enforced in CI. Without them
`@quarantine` becomes the default response to any red build, which is exactly what `CLAUDE.md`
already warns against. The mechanism should enforce the policy, not document it.

**SQLite before Postgres.** An orphan `atest-history` branch holding a SQLite file needs no
infrastructure, versions itself, and comfortably handles this suite's ~60k attempts per quarter.
Move to Postgres when you want cross-repo dashboards or multi-repo writes — not before.

**Impact analysis on PRs only.** `main` always runs everything. The wall-clock saving is real but
it is not worth a coverage hole on the branch you ship from.

**One provider abstraction, thin.** `LlmClient` with `complete()` and `completeStructured<T>(zodSchema)`,
Anthropic first. Add OpenAI/Ollama when someone actually needs them — a provider interface designed
against one real implementation and one hypothetical one is designed against the hypothetical one.

---

## Anti-recommendations

Things that will be proposed, and should be refused.

**Do not store tests as natural language.** NL specs cannot be reviewed in a diff, cannot be
grepped, and re-generate differently each run. NL belongs at the *input* to authoring; the artifact
is TypeScript.

**Do not let any agent write to `tests/testdata/seeded/`.** It is the oracle. An agent that can
edit the expected values can make any test pass, and the suite stops proving anything. Enforced in
the tool layer, not the prompt.

**Do not heal in the same process as the run.** It makes the run non-deterministic, puts model
credentials in the job that executes PR code, and turns a model outage into a test failure.

**Do not adopt an agent framework.** The two loops here are ~200 lines each. LangChain-class
dependencies bring churn to a tool whose entire value proposition is stability.

**Do not add a vector database.** ~150 source files with a clean import graph. `ripgrep` plus
ts-morph beats embeddings on accuracy, latency, and explainability at this scale, and it never
returns a confidently wrong neighbour.

**Do not auto-merge heals.** Not even "trivially safe" testid renames. The moment merges happen
without a human, the ledger stops being an audit trail and starts being a changelog nobody reads.

**Do not let the model set the flake threshold.** Statistics are statistics. Reserve the model for
explaining *why* something is flaky, never for deciding *whether* it is.
