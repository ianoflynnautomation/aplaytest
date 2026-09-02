# 07 — MCP server

## Position

The MCP server is a **façade over the same engine functions the CLI calls**. It adds no
capability. Its value is a different interaction mode: an IDE agent (Claude Code, Cursor,
Windsurf) exploring a failure conversationally, rather than a human typing commands and
reading tables.

Consequences that follow from "façade, not a second product":

- **It is built in Phase 5, not Phase 1.** MCP's value depends on the evidence store,
  history, and heal ledger already existing. Building it first optimises for a demo.
- **CI never uses it.** CI uses the CLI. MCP has no place in a pipeline.
- **No engine logic lives in `@atest/mcp`.** Any `if` in a tool handler that is not
  input translation or output shaping is a bug.

```
Claude Code / Cursor
        │  stdio (local)  |  streamable-http (remote, authed)
        ▼
  @atest/mcp  ──────►  the same engine calls the CLI makes
        │
        └─ safety layer: write-gating · size caps · redaction · path allow-list
```

---

## Tools

Deliberately few — an MCP surface with forty tools makes the client agent worse at
choosing. **Seven are implemented**; the rest of this document describes the intended
surface, and unimplemented tools are marked.

| Tool | Status | Gate |
| --- | --- | --- |
| `atest_list_failures` | implemented | read |
| `atest_get_failure` | implemented | read |
| `atest_flaky_query` | implemented | read |
| `atest_impact` | implemented | read |
| `atest_ground_feature` | implemented | read |
| `atest_propose_heal` | implemented | read (proposes only) |
| `atest_gate_test` | implemented | **write** |
| `atest_run_tests` / `atest_run_status` | not yet | write |
| `atest_apply_heal`, `atest_quarantine` | not yet | write |

### Read tools (always available)

#### `atest_ground_feature`
```ts
input:  { feature: string }
output: { conventionsPath, pageObjectPath, pageObjectApi: string[],
          seededDataPath, exemplars: { path, reason }[], missing: string[] }
```
The same retrieval the author agent receives, so the answer is what the agent would
actually see rather than an approximation of it. Returns **signatures and paths, not
file bodies** — inlining two whole exemplar specs would spend the caller's context on
files it can read deliberately once it knows they exist.

#### `atest_gate_test`
```ts
input:  { specFile: string; testTitle: string; stabilityRuns?: number;
          apiPattern?: string; confirm: true }
output: { passed, summary, checks, mutants: { name, class, killed, kills }[], guidance }
```
Runs the falsifiability gate: the test must pass repeatedly **and** fail when the API
is mutated to return empty or unfiltered data. It answers the one question a passing
test cannot — whether it would notice if the feature broke — and it applies to
human-written tests just as much as generated ones.

**Write-gated**, despite leaving no net change. It rewrites the spec under test for the
duration of several Playwright runs, and a process killed mid-gate leaves a mutated
spec and a `.atest-gate-backup` beside it. That is a working-tree change whatever the
intent was, so it needs `ATEST_MCP_WRITE=1` and `confirm: true` like any other mutation.

#### `atest_list_failures`
```ts
input: { runId?: string; project?: string; kind?: FailureKind; limit?: number }
output: { runId, failures: [{ evidenceId, title, file, line, project, kind,
                              intent, flakeScore, hasHeal }] }
```
Entry point. Deliberately does not include the ARIA snapshot — the agent picks one
failure and fetches its detail. Returning full evidence for 40 failures would blow the
client's context in one call.

#### `atest_get_failure`
```ts
input:  { evidenceId: string; include?: ('aria'|'network'|'console'|'candidates'|'appSpans')[] }
output: { test, failure, intent, page: { url, ariaSnapshot, testIdsPresent },
          candidates?, network?, console?, appSpans?, history }
```
The workhorse. Defaults to `['aria','candidates']` — the two things that actually
explain a failure. ARIA is truncated to a configurable token budget with an explicit
`truncated: true` marker; never silently.

Screenshots are **not** returned by default and never inline. When the failure kind is
visual, the response carries a `resourceUri` the client may fetch deliberately.

#### `atest_flaky_query`
```ts
input:  { testId?: string; project?: string; minScore?: number; window?: number }
output: { tests: [{ testId, title, project, score, confidence, rootCause,
                    features, quarantine, recentOutcomes }] }
```

#### `atest_impact`
```ts
input:  { changedPaths?: string[]; fromRef?: string }
output: { affected: [{ file, testIds, reason }], alwaysRun, grepExpression, estimatedMs }
```
`grepExpression` is directly usable: the client agent can hand it to `atest_run_tests`.

#### `atest_get_conventions`
```ts
input:  { feature?: string }
output: { conventions, pageObjectApi, seededFixtures, exemplarSpecs, forbiddenPaths }
```
Underrated. This is what lets an IDE agent write a *conventional* test instead of a
generic Playwright one. For `feature: 'gyms'` it returns the 20 exported functions of
`gyms.page.ts` with signatures, the `TEST_IDS` map, the seeded DTOs with their partial
names, and two exemplar specs. An agent given that writes code that passes review.

### Action tools (gated)

#### `atest_run_tests`
```ts
input:  { grep?: string; project?: string; file?: string; mode?: 'strict'|'assisted';
          workers?: number; timeoutMs?: number }
output: { handle: string; status: 'running' }        // ← returns immediately
```
Plus `atest_run_status({ handle })` → `{ status, progress, summary?, failures? }`.

**Never block.** A full suite run takes minutes; MCP clients time out and the agent
retries, spawning a second run. Handle-plus-poll is the only workable shape. The server
enforces one concurrent run per workspace.

#### `atest_propose_heal`
```ts
input:  { evidenceId: string; aggressiveness?: Aggressiveness; validate?: number }
output: { healId, diagnosis, patch: { file, before, after, unifiedDiff },
          stabilityDelta, validation, confidence, isRealBug, reasoning }
```
Computes and validates but **does not write**. Safe to expose read-only, because the
patch is data until someone applies it.

#### `atest_apply_heal`
```ts
input:  { healId: string; confirm: true }
output: { applied: boolean, files: string[], revertWith: string }
```
Requires `ATEST_MCP_WRITE=1` **and** the literal `confirm: true`. Two independent gates,
because "the agent applied a patch I did not see" is the failure mode people rightly
fear.

#### `atest_quarantine`
```ts
input:  { testId, project?, reason, expiresDays?: number, confirm: true }
output: { patch, expiresAt, budgetRemaining }
```
Refuses when the quarantine budget is exhausted, returning the budget state so the agent
can explain why rather than retrying.

#### `atest_generate_test`
```ts
input:  { goal: string; feature: string; project?: string; apply?: false }
output: { spec, pageObjectDelta, gate: { stability, mutantsKilled, typecheck, lint },
          transcriptUri }
```
Runs the full author agent including the falsifiability gate. Long-running → same
handle/poll shape as `run_tests`. `apply` defaults to `false`: it returns code for the
client agent to review and write itself, which is the right division of labour when the
client is already a coding agent with its own diff review.

---

## Resources

Read-only, URI-addressed, for content an agent should pull rather than be pushed.

| URI | Content |
| --- | --- |
| `atest://runs` | Recent runs with summaries |
| `atest://runs/{runId}` | Run detail: counts, duration, failures, shard map |
| `atest://failures/{evidenceId}` | Full evidence bundle (JSON) |
| `atest://failures/{evidenceId}/aria` | ARIA snapshot as text |
| `atest://failures/{evidenceId}/screenshot` | PNG — fetched deliberately, never inlined |
| `atest://failures/{evidenceId}/trace` | Playwright trace zip |
| `atest://flaky/leaderboard` | Current leaderboard |
| `atest://flaky/{testId}` | Per-test history + bisect records |
| `atest://heals` | Heal ledger |
| `atest://heals/{healId}` | Single heal with unified diff and validation record |
| `atest://conventions` | Repo conventions bundle |
| `atest://agent/transcripts/{id}` | Full agent transcript — the audit trail |

Resources return `text/plain`, `application/json`, or `image/png` with accurate MIME
types and `Content-Length`, so clients can budget before fetching.

---

## Safety model

The server runs with the user's filesystem permissions and is driven by a model. Three
layers:

### 1. Write gating

```ts
const WRITE_TOOLS = new Set(['atest_apply_heal', 'atest_quarantine', 'atest_generate_test']);

export function gate(toolName: string, input: unknown, cfg: McpConfig): GateResult {
  if (!WRITE_TOOLS.has(toolName)) return { ok: true };
  if (!cfg.writeEnabled) {
    return { ok: false, error: 'write_disabled',
             message: 'Set ATEST_MCP_WRITE=1 to enable mutating tools.' };
  }
  if ((input as { confirm?: boolean }).confirm !== true) {
    return { ok: false, error: 'confirmation_required',
             message: 'Pass confirm: true. Show the diff to the user first.' };
  }
  return { ok: true };
}
```

Default is read-only. A fresh install can inspect everything and change nothing.

### 2. Path confinement

Every write goes through `@atest/core`'s patch layer, which enforces the same
`REPO_DENY` list the agent tools use (04): no writes to `tests/testdata/seeded/**`,
`__screenshots__/**`, `__aria__/**`, `.env*`, `.github/workflows/**`, or
`atest.config.ts`. Enforced at the filesystem boundary, not in a prompt.

### 3. Response hygiene

- **Size caps.** Every tool response is capped (default 40k tokens). Over-cap responses
  are truncated with an explicit marker and a resource URI for the full content.
- **Redaction.** `config.evidence.redact` patterns are stripped from headers, request
  bodies, and console output before anything leaves the process. Evidence bundles from a
  suite with MSAL auth will contain bearer tokens; they must never reach a model.
- **No secrets in conventions.** `atest://conventions` reads `.env.*.example`, never
  `.env`.

---

## Configuration

```jsonc
// .mcp.json
{
  "mcpServers": {
    "atest": {
      "command": "npx",
      "args": ["-y", "@atest/mcp"],
      "env": { "ATEST_MCP_WRITE": "0" }
    }
  }
}
```

Remote (streamable-http) is available for hosted setups but requires a bearer token and
binds to loopback by default. Most teams should use stdio.

---

## Example session

What a well-designed MCP surface makes possible — each step is one tool call:

> **Dev:** the gyms tests are failing on CI, have a look
>
> `atest_list_failures({ runId: 'latest' })` → 3 failures, all `locator_not_found`,
> all in `gyms.ui.acceptance.spec.ts`
>
> `atest_get_failure({ evidenceId: 'ev_9f3a21' })` → intent was
> `gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' })`; `gym-card-name` is absent
> from the page; `gym-card-title` is present with matching text; flake score 0.02
>
> `atest_propose_heal({ evidenceId: 'ev_9f3a21' })` → one-line change in
> `gyms.constants.ts`, touches two constants, validated 3/3 plus 9 collateral tests
>
> **Agent:** All three failures are one cause — `gym-card-name` was renamed to
> `gym-card-title` in the app. The heal is a two-constant change in
> `src/ui/pages/gyms/gyms.constants.ts:20`, validated against the live app. Not flake —
> this test has passed 46 of 47 recent runs. Here is the diff — apply it?

The agent reached a correct, evidence-backed conclusion in three calls and roughly 8k
tokens, because the evidence bundle was designed for that and the ARIA snapshot is cheap.
Handing the same agent a raw Playwright HTML report would cost an order of magnitude more
and produce a worse answer.
