# Cutting-edge work

The architecture is the right bet for big-tech agentic testing: the LLM is never
in the pass/fail path, Playwright validates heals, and some failures are never
healed. This list is what turns that stance into a platform other suites can
attach to.

Reference suite: `~/Sources/bjjeire-tests` (constants files, page objects,
inline spec locators, `getByRole`, API + UI + snapshot projects).

---

## 1. Close the honesty gap — done

Live model call against real failures with a real API key. Tier-0 still stands
when the key is absent.

## 2. Become a platform, not a convention — done

Heal no longer requires `--constants`. It walks `heal.targets` (constants,
page objects, sections, specs) and prefers the most reviewable hit.
`heal.allowedStrategies` is the policy (`testid | role | label | text`);
nameless `getByRole` is still refused. Playwright JSON reports ingest into
history via `atest history ingest --playwright-json` so API-only projects
can score flakes without the atest reporter.

Playwright Component Tests and Cypress remain adapter seams, not
implementations — bjjeire does not use them.

## 3. Ship the eval as a product feature

`atest eval` over a versioned corpus: injected testid renames, flake vs
regression, `NEVER_HEAL` adversarial cases, vacuous generated tests the gate
must reject. Prompt changes become score deltas.

## 4. History a company can operate

Pluggable store (SQLite → Postgres), per-repo and org views, join to existing
traces, evidence retention and redaction at write.

## 5. Authoring: NL in, TypeScript out

Keep the artifact as TypeScript. Require a data-mutant kill. Add contract
mutants from seeded fixtures. Nightly missing-coverage *proposals*, never
auto-merge.

## 6. Meet the agent where it lives — without putting it in CI

Complement Playwright MCP. One-hop “explain this failure” resource (bundle +
classification + top candidates + “this is a bug, do not heal”). Do not add a
planner/generator/healer trio that mutates the running test.

## 7. Distribution and the attach story

Publish scoped packages. `atest init` that only adds a reporter line and
verifies evidence escapes the container. First-class Azure DevOps / template-repo
attach. Optional PR comment / heal PR.

## 8. Security posture that clears a platform review

Local/Ollama path for classify/rank. Data-flow doc. Signed heal records.
Prompt/cache prefix with no timestamps and stable JSON key order, enforced by
a test.

---

## Do not chase

- Runtime self-healing that lets CI go green without a diff
- Tests stored as natural language and regenerated each run
- A 30-tool MCP server
- Auto-apply in CI for assertions or flows
- Visual-AI as a merge gate before selector healing has a low revert rate
- Competing with Playwright MCP at driving the browser
