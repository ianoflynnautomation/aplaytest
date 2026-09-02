# Future work

Suggested GitHub issues for work that is not in this tree yet. The stance
does not change: the LLM is never in the pass/fail path, Playwright validates
heals, and some failures are never healed.

## Suggested issues

### Eval as a product feature

`atest eval` over a versioned corpus: injected testid renames, flake vs
regression, `NEVER_HEAL` adversarial cases, vacuous generated tests the gate
must reject. Prompt changes become score deltas.

### History a company can operate

Pluggable store (SQLite → Postgres), per-repo and org views, join to existing
traces, evidence retention and redaction at write.

### Authoring: NL in, TypeScript out

Keep the artifact as TypeScript. Require a data-mutant kill. Add contract
mutants from seeded fixtures. Nightly missing-coverage *proposals*, never
auto-merge.

### Meet the agent where it lives — without putting it in CI

Complement Playwright MCP. One-hop “explain this failure” resource (bundle +
classification + top candidates + “this is a bug, do not heal”). Do not add a
planner/generator/healer trio that mutates the running test.

### Signed heal records and a local model path

Local/Ollama path for classify/rank. Data-flow documentation. Signed heal
records. Prompt/cache prefix with no timestamps and stable JSON key order,
enforced by a test.

## Do not chase

- Runtime self-healing that lets CI go green without a diff
- Tests stored as natural language and regenerated each run
- A 30-tool MCP server
- Auto-apply in CI for assertions or flows
- Visual-AI as a merge gate before selector healing has a low revert rate
- Competing with Playwright MCP at driving the browser
