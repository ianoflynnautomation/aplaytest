# 02 — Project structure

`atest` lives in its own repository as a pnpm workspace monorepo. It is **not** vendored
into `bjjeire-tests`; that repo consumes it as a devDependency. This keeps the test
suite's dependency surface honest and lets the framework be reused by the app repo's
component tests later.

## Monorepo layout

```
atest/
├── package.json                      # private root, pnpm workspaces
├── pnpm-workspace.yaml
├── turbo.json                        # build/test pipeline caching
├── tsconfig.base.json                # strict; mirrors bjjeire-tests' strictness
├── .changeset/                       # release management
│
├── packages/
│   ├── core/                         # @atest/core       — no LLM, no Playwright
│   │   └── src/
│   │       ├── config/               #   defineAtestConfig, zod schema, resolution
│   │       ├── evidence/             #   EvidenceBundle types, store, redaction
│   │       ├── history/              #   HistoryStore iface + sqlite/postgres drivers
│   │       ├── taxonomy/             #   FailureKind, classify(), routing tables
│   │       ├── locator/              #   stability ranking, candidate scoring, parsing
│   │       ├── policy/               #   heal/quarantine policy evaluation
│   │       ├── patch/                #   ts-morph codemods, git patch generation
│   │       ├── audit/                #   append-only ledger, provenance
│   │       └── index.ts
│   │
│   ├── runner-playwright/            # @atest/runner-playwright
│   │   └── src/
│   │       ├── reporter.ts           #   ⚠ CJS build required (see below)
│   │       ├── fixtures.ts           #   aria/network/console capture, bindPage wrapper
│   │       ├── spawn.ts              #   child-process control of `playwright test`
│   │       ├── trace-reader.ts       #   parse trace.zip → actions, network, snapshots
│   │       └── replay.ts             #   re-run a single test with locator overrides
│   │
│   ├── llm/                          # @atest/llm
│   │   └── src/
│   │       ├── client.ts             #   LlmClient interface
│   │       ├── providers/            #   anthropic.ts | openai.ts | ollama.ts
│   │       ├── structured.ts         #   zod → tool schema, validated decode + repair
│   │       ├── cache.ts              #   prompt caching + on-disk response cache
│   │       └── budget.ts             #   token/cost accounting, hard stops
│   │
│   ├── agent/                        # @atest/agent
│   │   └── src/
│   │       ├── runtime/              #   loop, budget guard, transcript, tracing
│   │       ├── tools/                #   browser/ network/ repo/ verify/
│   │       ├── agents/               #   repair.ts | author.ts | explore.ts
│   │       ├── prompts/              #   *.md templates, versioned
│   │       └── conventions.ts        #   repo-convention retrieval (exemplar selection)
│   │
│   ├── heal/                         # @atest/heal
│   │   └── src/
│   │       ├── candidates.ts         #   Tier-0 deterministic generation
│   │       ├── rank.ts               #   Tier-1 LLM ranking (optional)
│   │       ├── validate.ts           #   replay N× + collateral check
│   │       ├── strategies/           #   selector.ts | assertion.ts | flow.ts
│   │       └── ledger.ts
│   │
│   ├── flaky/                        # @atest/flaky
│   │   └── src/
│   │       ├── score.ts              #   Wilson bound, recency decay, transitions
│   │       ├── features.ts           #   deterministic signal extraction
│   │       ├── classify.ts           #   rules → class; LLM only for narrative
│   │       ├── bisect.ts             #   co-scheduling / worker-count bisection
│   │       └── quarantine.ts         #   tag codemod, expiry enforcement, budget
│   │
│   ├── impact/                       # @atest/impact
│   │   └── src/
│   │       ├── graph.ts              #   ts-morph import graph, spec → deps closure
│   │       ├── coverage.ts           #   runtime route/testid/api map from traces
│   │       ├── select.ts             #   changed paths → test set + shard plan
│   │       └── crossrepo.ts          #   app-repo diff → test set (LLM-assisted)
│   │
│   ├── report/                       # @atest/report
│   │   └── src/
│   │       ├── html/                 #   self-contained SPA build
│   │       ├── insights.ts           #   run narrative generation (LLM optional)
│   │       └── merge.ts              #   shard/blob merge → single report
│   │
│   ├── mcp/                          # @atest/mcp
│   │   └── src/
│   │       ├── server.ts             #   stdio + streamable-http transports
│   │       ├── tools/                #   one file per tool, zod-schema'd
│   │       ├── resources/            #   atest:// URI handlers
│   │       └── safety.ts             #   write-gating, redaction, size caps
│   │
│   └── cli/                          # atest  (the published bin)
│       └── src/
│           ├── bin.ts
│           ├── commands/             #   one file per command, thin over engines
│           ├── ui/                   #   spinners, tables, diffs, TTY vs CI output
│           └── ci/                   #   workflow generators (templates/)
│
├── examples/
│   ├── playwright-basic/
│   └── bjjeire-style/                # function-based page objects + constants
│
└── docs/
```

## Package boundaries and why

| Package               | May import                            | Rationale                                                                                 |
| --------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `core`                | nothing internal                      | Must be testable with zero Playwright and zero network. Holds all types.                   |
| `runner-playwright`   | `core`                                | The only package that knows Playwright exists. Swappable for a Cypress/WebDriver adapter.  |
| `llm`                 | `core`                                | The only package that makes model calls. Everything else takes an `LlmClient` injected.    |
| `heal`/`flaky`/`impact` | `core`, `runner-playwright`, `llm`  | Never each other.                                                                          |
| `agent`               | `core`, `runner-playwright`, `llm`    | Tools are the only way it touches the world.                                               |
| `report`              | `core`                                | Renders from history + evidence. Never re-runs anything.                                   |
| `mcp` / `cli`         | everything                            | Both are thin adapters over identical engine calls — see below.                             |

**The CLI/MCP parity rule:** every CLI command body is ≤ 30 lines and does exactly
three things — parse flags, call one engine function, format output. Every MCP tool
calls *the same engine function*. If a capability exists in one and not the other, that
is a bug in the adapter, not a missing feature.

```ts
// packages/cli/src/commands/heal.ts
export async function healCommand(flags: HealFlags): Promise<number> {
  const ctx = await loadContext(flags);
  const result = await healEngine.proposeAll(ctx, {
    runId: flags.run ?? 'latest',
    aggressiveness: flags.aggressiveness,
    validationRuns: flags.validate,
  });
  renderHealTable(result);
  return result.proposals.length > 0 ? 0 : EXIT.NOTHING_TO_DO;
}

// packages/mcp/src/tools/propose-heal.ts — same engine call, different envelope
export const proposeHeal = defineTool({
  name: 'atest_propose_heal',
  inputSchema: z.object({ failureId: z.string(), aggressiveness: AggressivenessSchema.optional() }),
  handler: async (input, ctx) => healEngine.proposeOne(ctx, input),
});
```

## Packaging constraints (real ones, from this repo)

1. **CJS reporter entry.** `bjjeire-tests` is `"type": "commonjs"` and its
   `activeReporters()` loads reporters by absolute path. `@atest/runner-playwright`
   must publish `reporter.cjs` alongside ESM. Everything else can be ESM-only —
   the CLI is a bin, and the fixtures are imported by TS that compiles to CJS.
   Build with `tsup --format cjs,esm --dts`.

2. **Playwright as a peer dependency**, never a direct one. Version drift between the
   framework's Playwright and the suite's pinned `1.61.0` would silently change
   snapshot rendering. Declare `"peerDependencies": { "@playwright/test": ">=1.55" }`
   and fail fast at startup on mismatch:

   ```ts
   assertPeerVersion('@playwright/test', { min: '1.55.0', warnIfBelow: '1.61.0' });
   ```

3. **No transitive LLM SDK in the run path.** `@atest/runner-playwright` must not
   depend on `@atest/llm`. The reporter runs inside the test process; pulling an HTTP
   client and 40MB of SDK into every worker is unacceptable, and it would make a
   credential available where it should not be.

4. **Zero-install evidence reading.** The evidence format is plain JSON with a
   `schemaVersion`. A human with `jq` can read it. Never a binary format.

## What lands in the consumer repo

Deliberately small. In `bjjeire-tests`:

```
bjjeire-tests/
├── atest.config.ts              # NEW — the only required file
├── .atest/                      # NEW — gitignored, except heals/ and history export
│   ├── history.sqlite
│   ├── evidence/<runId>/
│   └── heals/*.json             # tracked: the audit ledger belongs in git
├── .gitignore                   # + .atest/history.sqlite, .atest/evidence/
├── package.json                 # + devDependency: atest
└── src/shared/config/playwright.ts   # + one reporter entry in activeReporters()
```

That is the entire Phase-0 footprint. No spec changes, no fixture changes, no project
changes. `git revert` on that single commit fully removes the framework.
