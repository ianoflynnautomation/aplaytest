# 02 — Project structure

`atest` is its own repository. `bjjeire-tests` consumes the published packages as
devDependencies. The root is an npm workspace (`"workspaces": ["packages/*", "examples/*"]`),
Node `>=22`, version `0.1.1`. Build is `tsc --build` plus `scripts/finalize-cjs.ts`
for the CommonJS reporter. There is no pnpm workspace file and no Turborepo config.

## Monorepo layout

```
atest/
├── package.json                      # private root, npm workspaces
├── tsconfig.json                     # project references, tsc --build
├── tsconfig.cjs.json                 # CJS build for the reporter
├── Dockerfile                        # cli image and playwright image
│
├── packages/
│   ├── core/                         # @aplaytest/core — no Playwright, no LLM
│   │   └── src/
│   │       ├── config/               #   defaults, zod schema
│   │       ├── evidence/             #   EvidenceBundle, store, redaction
│   │       ├── history/              #   HistoryStore, sqlite, memory index, ingest
│   │       ├── taxonomy/             #   FailureKind, classify, routing
│   │       ├── locator/              #   stability ranking, locator parsing
│   │       └── version.ts
│   │
│   ├── store-azure/                  # @aplaytest/store-azure — optional peer of the CLI
│   │   └── src/
│   │       ├── layout.ts             #   one immutable blob per run and shard
│   │       ├── blob-store.ts         #   HistoryStore; readonly indexes and does not PUT
│   │       ├── backend.ts            #   seam the unit tests fake
│   │       └── azure-backend.ts      #   the only file that imports an Azure SDK
│   │
│   ├── runner-playwright/            # @aplaytest/runner-playwright
│   │   └── src/
│   │       ├── reporter.ts           #   CJS build required (./reporter → dist-cjs)
│   │       ├── fixtures.ts           #   aria / network / console capture
│   │       ├── api-fixtures.ts
│   │       ├── assemble.ts           #   evidence bundle from a Playwright result
│   │       ├── bind.ts               #   page-object step recording
│   │       ├── sidecar.ts
│   │       ├── spawn.ts              #   child-process `playwright test`
│   │       └── steps.ts
│   │
│   ├── llm/                          # @aplaytest/llm — zod, Anthropic SDK
│   │   └── src/
│   │       ├── client.ts
│   │       ├── factory.ts
│   │       ├── fake.ts
│   │       ├── budget.ts             #   token and cost guard
│   │       ├── pricing.ts
│   │       ├── errors.ts
│   │       └── providers/            #   anthropic.ts, unavailable.ts
│   │
│   ├── agent/                        # @aplaytest/agent — the model tier
│   │   └── src/
│   │       ├── repair.ts             #   ranks candidates proposeHeal already made
│   │       └── author.ts             #   drafts a test; does not accept it
│   │
│   ├── author/                       # @aplaytest/author — the falsifiability gate
│   │   └── src/
│   │       ├── gate.ts
│   │       ├── ground.ts
│   │       └── mutants.ts
│   │
│   ├── heal/                         # @aplaytest/heal
│   │   └── src/
│   │       ├── candidates.ts         #   generateCandidates, synchronous
│   │       ├── propose.ts            #   gate order, including the flake score
│   │       ├── resolve.ts
│   │       ├── validate.ts           #   re-run the target, then the spec
│   │       ├── patch.ts
│   │       └── ledger.ts
│   │
│   ├── flaky/                        # @aplaytest/flaky
│   │   └── src/
│   │       ├── score.ts
│   │       ├── features.ts
│   │       ├── classify.ts
│   │       ├── analyze.ts
│   │       ├── resolve.ts
│   │       ├── bisect.ts
│   │       ├── quarantine.ts
│   │       └── codemod.ts
│   │
│   ├── impact/                       # @aplaytest/impact — core only
│   │   └── src/
│   │       ├── graph.ts
│   │       ├── coverage.ts
│   │       └── select.ts
│   │
│   ├── report/                       # @aplaytest/report
│   │   └── src/
│   │       ├── args.ts
│   │       ├── html.ts
│   │       ├── load.ts
│   │       ├── markdown.ts           #   pull-request comment
│   │       └── merge.ts
│   │
│   ├── mcp/                          # @aplaytest/mcp — stdio
│   │   └── src/
│   │       ├── bin.ts
│   │       ├── server.ts
│   │       ├── tools.ts
│   │       └── safety.ts
│   │
│   └── cli/                          # @aplaytest/cli — the `aplaytest` bin
│       └── src/
│           ├── bin.ts                #   node:util parseArgs
│           ├── commands/             #   one file per command; ci.ts holds the workflow
│           ├── store.ts              #   --db, then ATEST_HISTORY_URL, then :memory:
│           ├── ledger.ts
│           └── ui/output.ts
│
├── examples/
│   ├── bjjeire-live/
│   ├── fixture-app/
│   ├── smoke/
│   └── ci/atest-analyze.yml
│
└── docs/
```

## Package boundaries

| Package | May import | Rationale |
| --- | --- | --- |
| `core` | nothing internal | No Playwright and no LLM. Holds the shared types. |
| `runner-playwright` | `core` | The only package that knows Playwright. It does not depend on `llm`. |
| `llm` | zod, the Anthropic SDK | The budget guard lives here. |
| `heal`, `flaky` | `core`, `runner-playwright` | Engines do not import each other. |
| `impact` | `core` | Import graph and selection. |
| `author` | `core`, `runner-playwright` | Decides whether a drafted test is falsifiable. No model. |
| `agent` | `core`, `llm` | Drafts a test and ranks heal candidates. It does not decide. |
| `report` | `core` | HTML report and the pull-request comment. |
| `mcp` | `core`, `flaky`, `heal`, `impact`, `author` | Same engines the CLI calls, over stdio. |
| `cli` | the engines, `llm`, `agent` | The other place that calls more than one engine. Azure is a dynamic import. |

`@aplaytest/author` and `@aplaytest/agent`'s `author.ts` are different packages. The
agent drafts. The author package's gate accepts or rejects the draft.

## Packaging constraints

1. **CJS reporter entry.** A CommonJS suite loads reporters with `require`.
   `@aplaytest/runner-playwright` publishes `./reporter` as
   `dist-cjs/reporter.js` for `require` and `dist/reporter.js` for `import`.
   The CJS build is `tsc --build tsconfig.cjs.json` and `scripts/finalize-cjs.ts`.

2. **Playwright is a peer dependency** of `@aplaytest/runner-playwright`:
   `"@playwright/test": ">=1.55.0"`. This repo's devDependency is pinned to
   `1.64.1`, the same version as `ARG PLAYWRIGHT_VERSION` in the Dockerfile and
   the default image in `aplaytest ci generate`. The tag and the npm version
   are one decision: the image ships the browser build that package expects.

3. **No LLM SDK on the run path.** `@aplaytest/runner-playwright` does not depend
   on `@aplaytest/llm`. The reporter runs inside the test process.

4. **Evidence is plain JSON** with a `schemaVersion`. A human can read a bundle
   with `jq`.

## What lands in the consumer repo

In `bjjeire-tests` the footprint is the reporter entry, `atest.config.ts` when
you want one, and a gitignored `.atest/` for evidence and run records. History
across CI runs is `ATEST_HISTORY_URL` (`azblob://…`) or a SQLite path. See
[08 — CI/CD](./08-cicd.md) and [12 — Azure history](./12-azure-history.md).
