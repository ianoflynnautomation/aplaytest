# atest

A control plane around Playwright: failure evidence, flaky-test management,
auto-healing, test impact analysis, and agentic test authoring — designed so
that **a green test never depends on a language model**.

Most "AI test automation" swaps a selector at runtime and lets the test go
green. That trades a loud, cheap failure for a silent, expensive one. `atest`
inverts it:

- **The LLM is never in the pass/fail path.** CI runs in `strict` mode: no
  model, byte-identical to `playwright test`. Heals are proposed offline, as
  reviewable git patches.
- **Playwright validates heals, not model confidence.** Every proposal is
  re-run before it is shown to anyone.
- **Every engine has a zero-LLM tier.** Missing an API key degrades scope,
  never correctness.
- **Some failures are never healed.** Schema violations and uncaught app
  errors are the bug — repairing them would destroy the most valuable signal
  a suite produces.

## Key features

- **Evidence bundles** — structured records of every failure (ARIA snapshot,
  test-id index, network/console ledgers, failing page-object call).
- **Flaky engine** — recency-weighted scoring, rule-based classification,
  bisect, quarantine budget and expiry. Entirely deterministic.
- **Selector healing** — candidates from the page's own test ids; patches via
  ts-morph; Playwright re-runs decide. `NEVER_HEAL` kinds are refused in code.
- **Impact analysis** — static import graph plus route coverage, with an
  explanation for every selected spec.
- **Falsifiability gate** — a generated test must pass *and* fail when the
  world breaks. Vacuous assertions are rejected.
- **CI split** — the job that runs tests and the job that holds model
  credentials are different jobs.
- **MCP façade** — the same engines as the CLI, read-only by default.

## Prerequisites & installation

Requires **Node.js 22+**.

```sh
npm i -D @atest/cli @atest/runner-playwright
npx atest init --apply
```

`atest init` adds one reporter line to `playwright.config.ts` and a
`.gitignore` block. `--apply` writes; without it, you see the diff first.
`atest init --undo --apply` removes both.

pnpm and yarn work the same way (`pnpm add -D …`, `yarn add -D …`).

Optional extras:

```sh
npm i -D @atest/store-azure   # Azure Blob history in CI
npm i -D @atest/mcp           # IDE agent server
```

## Quick start

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    ['@atest/runner-playwright/reporter'],
  ],
});
```

```ts
// atest.config.ts — every field is optional; empty means the safe defaults
import { defineAtestConfig } from '@atest/core';

export default defineAtestConfig({
  mode: 'strict',
  heal: { apply: 'propose' },
});
```

Run the suite as usual. Failures land in `.atest/evidence` and `.atest/runs`.
Then:

```sh
npx atest doctor
npx atest flaky report
npx atest heal --spec tests/gyms.spec.ts
npx atest impact --from origin/main
```

`ATEST=0` disables the reporter completely. Removing the reporter line
removes the framework.

Richer evidence (ARIA tree, rendered test ids, network/console ledgers) needs
the capture fixtures — still no spec changes, because the fixture is
`auto: true`:

```ts
import { test as base } from '@playwright/test';
import { atestFixtures, bindPage } from '@atest/runner-playwright';
import * as GymsPageMod from './pages/gyms.page.js';

export const test = base.extend({
  ...atestFixtures,
  gymsPage: async ({ page }, use) => {
    await use(bindPage(GymsPageMod, page, 'gymsPage'));
  },
});
```

`bindPage` is a drop-in for the usual binding helper; the extra `name`
argument is what turns *"a selector did not resolve"* into
*"`gymsPage.expectCardData({ name: '…' })` failed"*.

### Examples

- [examples/smoke](./examples/smoke) — reporter integration, no server needed.
- [examples/fixture-app](./examples/fixture-app) — capture fixtures and the
  falsifiability gate against a local app.
- [examples/bjjeire-live](./examples/bjjeire-live) — the same fixtures against
  a real application.

## API reference

Packages are independently versioned under the `@atest` scope. Engines import
`@atest/core`; they never import one another.

| Package | Role |
| --- | --- |
| `@atest/core` | Types, failure taxonomy, locator ranking, evidence, config, SQLite history |
| `@atest/runner-playwright` | Reporter, error parsing, step extraction, capture fixtures |
| `@atest/flaky` | Scoring, classification, bisect, quarantine policy and codemod |
| `@atest/heal` | Candidate generation, ts-morph patching, validation, ledger |
| `@atest/impact` | Import graph, hub detection, route-coverage selection |
| `@atest/author` | Falsifiability gate and data mutants |
| `@atest/report` | Shard merge, self-contained HTML report, PR comment |
| `@atest/store-azure` | Append-only blob log implementing the same `HistoryStore` |
| `@atest/llm` | Injected `LlmClient`, Anthropic adapter, budget, scripted fake |
| `@atest/agent` | Repair agent (ranks pre-verified options) and author agent |
| `@atest/cli` | The `atest` binary |
| `@atest/mcp` | MCP server over the same engines |

Primary entry points:

```ts
import { defineAtestConfig, classify } from '@atest/core';
import { proposeHeal } from '@atest/heal';
import { scoreTest, classifyFlake, extractFeatures } from '@atest/flaky';
import { buildGraph, selectTests, toPlaywrightArgs } from '@atest/impact';
import { createLlmClient } from '@atest/llm';
import { falsifiabilityGate } from '@atest/author';
```

Full design: [docs/README.md](./docs/README.md). CLI surface: `atest --help`
and [docs/03-cli.md](./docs/03-cli.md).

## Configuration

Environment variables are documented in [`.env.example`](./.env.example).
The important ones:

| Variable | Purpose |
| --- | --- |
| `ATEST=0` | Disable the reporter entirely |
| `ATEST_HISTORY_URL` | History store (`path`, `azblob://…`, or `:memory:`) |
| `ANTHROPIC_API_KEY` | Model tier. Unset = deterministic engines only |
| `ATEST_MCP_WRITE=1` | Allow mutating MCP tools (still requires `confirm: true`) |

`atest.config.ts` is Zod-validated. An empty config yields `mode: 'strict'`,
propose-only healing, and quarantine expiry. Invalid config fails at startup.

The current model adapter is Anthropic. `llm.provider` accepts `anthropic` or
`none`. OpenAI and Ollama are not implemented; setting them is a config error,
not a silent fallback.

### MCP

Read-only unless you opt in:

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

### CI

`atest ci generate --shards 4` emits a workflow built around one constraint:
**the job that runs tests and the job that holds model credentials are
different jobs.** Generated output is verified against `actionlint`,
`yamllint`, and a pinning policy.

## Current status

Deterministic engines (`core`, `runner-playwright`, `flaky`, `heal`,
`impact`, `author`, `report`, `store-azure`, CLI, MCP) are implemented and
tested, including live Playwright runs and an Azurite integration for blob
history.

`@atest/llm` and `@atest/agent` are built and unit-tested against a scripted
client. A live model call is optional: set `ANTHROPIC_API_KEY` and run
`atest heal` against a failing test. Until then the deterministic tier stands
on its own.

See [docs/09-roadmap.md](./docs/09-roadmap.md) for what lands next, and
[TODO.md](./TODO.md) for suggested follow-up issues.

## Contributing & license

See [CONTRIBUTING.md](./CONTRIBUTING.md). Please report vulnerabilities via
[GitHub security advisories](https://github.com/ianoflynnautomation/atest/security/advisories/new)
rather than a public issue ([SECURITY.md](./SECURITY.md)).

Licensed under the [MIT License](./LICENSE).
