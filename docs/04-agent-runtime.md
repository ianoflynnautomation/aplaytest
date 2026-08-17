# 04 — Agent runtime

## Two agents, not one

A single general agent would be worse at both jobs. The runtime hosts two, with
different loops, tools, and risk profiles.

| | **Repair agent** | **Author agent** |
| --- | --- | --- |
| Input | An `EvidenceBundle` | A natural-language goal |
| Loop | ReAct, bounded (≤ 8 steps) | Plan-and-Execute + Reflexion |
| Side effects | None — proposes only | Writes to a scratch branch |
| Browser | Read-only, on a replayed page | Full drive |
| Model | Sonnet-class | Opus-class |
| Volume | High (every healable failure) | Low (a handful per week) |
| Failure mode if wrong | A rejected patch | A rejected spec |

Both share the same runtime shell: tool registry, budget guard, transcript, and OTel
instrumentation.

---

## Runtime shell

```ts
// packages/agent/src/runtime/loop.ts

export interface AgentSpec<TInput, TOutput> {
  readonly name: string;
  readonly model: ModelRole;                       // 'classify' | 'heal' | 'author'
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly systemPrompt: PromptTemplate;
  readonly tools: readonly ToolDef[];
  readonly outputSchema: z.ZodType<TOutput>;       // structured final answer
  readonly limits: AgentLimits;
  buildInitialMessages(input: TInput, ctx: AgentContext): Promise<Message[]>;
}

export interface AgentLimits {
  readonly maxSteps: number;
  readonly maxWallClockMs: number;
  readonly maxTokens: number;
  readonly maxUsd: number;
  readonly maxToolErrors: number;   // consecutive tool failures before abort
}

export type AgentResult<T> =
  | { readonly status: 'ok'; readonly output: T; readonly usage: Usage; readonly transcript: Transcript }
  | { readonly status: 'budget_exceeded' | 'max_steps' | 'tool_failure' | 'invalid_output' | 'llm_unavailable';
      readonly reason: string; readonly usage: Usage; readonly transcript: Transcript };

export async function runAgent<I, O>(
  spec: AgentSpec<I, O>, input: I, ctx: AgentContext,
): Promise<AgentResult<O>> {
  const budget = new BudgetGuard(spec.limits, ctx.budgetPool);
  const transcript = new Transcript(spec.name, ctx.traceId);
  let messages = await spec.buildInitialMessages(input, ctx);

  for (let step = 0; step < spec.limits.maxSteps; step++) {
    const guard = budget.check();
    if (!guard.ok) return abort(guard.reason, budget, transcript);

    const res = await ctx.llm.complete({
      model: ctx.models[spec.model],
      system: spec.systemPrompt.render(ctx),   // cached across the whole run
      messages,
      tools: [...spec.tools, finalAnswerTool(spec.outputSchema)],
      // NOT temperature — sampling params are rejected (400) on Opus 5 / Sonnet 5.
      // Reasoning depth is controlled by effort; see 10-recommendations.md.
      thinking: { type: 'adaptive' },
      outputConfig: { effort: spec.effort },   // 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    });
    budget.record(res.usage);
    transcript.push(res);

    if (res.stopReason !== 'tool_use') return abort('invalid_output', budget, transcript);

    const finals = res.toolCalls.filter(c => c.name === FINAL_ANSWER);
    if (finals.length > 0) {
      const parsed = spec.outputSchema.safeParse(finals[0]!.input);
      // One structured repair attempt, then give up — do not loop on malformed output.
      if (!parsed.success) {
        messages = [...messages, res.asMessage(), schemaRepairMessage(parsed.error)];
        continue;
      }
      return { status: 'ok', output: parsed.data, usage: budget.usage(), transcript };
    }

    const results = await executeTools(res.toolCalls, spec.tools, ctx, transcript);
    messages = [...messages, res.asMessage(), toolResultMessage(results)];
  }
  return abort('max_steps', budget, transcript);
}
```

Design notes that matter in practice:

- **The final answer is a tool**, not free text. There is exactly one parse path, and it
  is Zod-validated. No regex over prose, ever.
- **One schema-repair round.** LLMs occasionally emit a wrong-shaped object; two rounds
  fixes almost all of them, and looping past that burns budget on a model that is stuck.
- **Budget is a pool**, shared across a run. Analyzing 40 failures cannot cost 40× the
  per-failure cap; `--budget` bounds the whole invocation.
- **The transcript is persisted** to `.atest/agent/<id>.jsonl`. Every proposal is
  reproducible and reviewable — you can read exactly what the model saw and did. This
  is the auditability requirement, satisfied concretely.
- **Every agent run is an OTel span** parented to the test's trace id, so agent activity
  shows up in the same Grafana view as the test and the app.

---

## Tool registry

Tools are Zod-schema'd, sandboxed, and grouped by capability. An agent receives only
the groups its job needs — the repair agent has no write tools at all.

```ts
export interface ToolDef<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;                  // becomes the model-facing doc
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly capability: Capability;               // for allow-listing
  readonly costHint: 'cheap' | 'slow' | 'expensive';
  execute(input: I, ctx: AgentContext): Promise<O>;
}
```

### Browser tools (`capability: 'browser.read' | 'browser.write'`)

| Tool | Capability | Notes |
| --- | --- | --- |
| `snapshot_aria` | read | Primary sensor. Returns the ARIA tree, optionally scoped to a locator. |
| `query_candidates` | read | `{ intent, near?, role?, text? }` → ranked `LocatorCandidate[]`. Does the heavy lifting so the model does not invent selectors. |
| `list_test_ids` | read | Every `data-testid` on the page. Cheap and decisive. |
| `screenshot` | read | Vision only. Gated: refused unless the failure kind is visual/actionability. |
| `read_network` | read | Request ledger with status, timing, and Zod-parse results. |
| `read_console` | read | Errors and warnings. |
| `navigate` / `click` / `fill` / `select` / `press` | write | Author agent only. |
| `wait_for_response` | write | Author agent only — teaches it to wait on signals, not time. |
| `mock_route` | write | Author agent only, and only for the four sanctioned cases (empty/error/pagination/snapshot). |

`evaluate` (arbitrary JS in the page) is **not** offered. It is the one tool that would
let an agent produce a passing-but-meaningless test, and every legitimate use is covered
by `snapshot_aria` + `query_candidates`.

### Repo tools (`capability: 'repo.read' | 'repo.write'`)

`read_file` (allow-listed globs), `grep_repo`, `list_page_object_api`,
`list_seeded_data`, `read_conventions`, `write_file` (author agent, scratch dir only).

Hard denials, enforced in the tool layer rather than the prompt:

```ts
const REPO_DENY: readonly string[] = [
  'tests/testdata/seeded/**',   // the oracle — an agent that edits it can prove anything
  '**/__screenshots__/**',      // baselines are the oracle for visual tests
  '**/__aria__/**',
  '.env*', '.github/workflows/**', 'atest.config.ts',
];
```

The seeded-data denial is the single most important guardrail in the whole design. If
an agent may edit `SEEDED_GYM_BLACKWATER_VALLEY`, then every assertion in the suite is
negotiable and the suite proves nothing.

### Verify tools (`capability: 'verify'`)

| Tool | What it runs |
| --- | --- |
| `run_test` | `playwright test <file> -g "<title>" --project <p> --repeat-each <n>` in strict mode |
| `run_mutant` | Same, with a mutation applied — the falsifiability gate |
| `typecheck` | `npm run typecheck` |
| `lint` | `npm run lint` — this is how `waitForTimeout` and floating promises get rejected |
| `check_conventions` | Title pattern, required tags, seeded-data usage, forbidden imports |

This is the **constraints-as-tools** principle. Rather than writing "do not use
`waitForTimeout`" in a system prompt and hoping, the agent's output is run through the
ESLint config that already errors on it. Prompt text is advisory; tools are binding.
Your repo already owns the enforcement — the agent just has to face it.

---

## Repair agent

Bounded, cheap, and the highest-volume consumer of the model.

```ts
export const repairAgent: AgentSpec<EvidenceBundle, RepairProposal> = {
  name: 'repair',
  model: 'heal',
  effort: 'medium',   // ranking pre-verified candidates — not a deep-reasoning task
  tools: [snapshotAria, queryCandidates, listTestIds, readNetwork, readFile, grepRepo],
  limits: { maxSteps: 8, maxWallClockMs: 90_000, maxTokens: 60_000, maxUsd: 0.05, maxToolErrors: 2 },
  outputSchema: RepairProposalSchema,
  systemPrompt: REPAIR_PROMPT,
  buildInitialMessages: async (bundle, ctx) => [
    userMessage([
      renderIntent(bundle),                    // what the test wanted, in domain terms
      renderFailure(bundle),                   // kind, matcher, expected/actual
      renderAriaSnapshot(bundle, { maxTokens: 6_000 }),
      renderTestIdIndex(bundle),
      renderSelectorSource(bundle, ctx),       // the constants file, with line numbers
      await renderNearestExemplar(bundle, ctx) // a similar, passing page object
    ]),
  ],
};

export const RepairProposalSchema = z.object({
  diagnosis: z.enum([
    'selector_renamed', 'selector_moved', 'element_removed',
    'ambiguous_match', 'timing_not_selector', 'app_regression', 'unknown',
  ]),
  reasoning: z.string().max(1200),
  proposal: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('selector'),
      targetFile: z.string(),
      constantPath: z.string(),               // e.g. "TEST_IDS.cardName"
      before: z.string(),
      after: z.string(),
      strategy: z.enum(['testid', 'role', 'label', 'text']),
    }),
    z.object({ kind: z.literal('assertion'), targetFile: z.string(), before: z.string(),
               after: z.string(), appChangeEvidence: z.string() }),
    z.object({ kind: z.literal('none'), recommendation: z.string() }),
  ]),
  confidence: z.number().min(0).max(1),
  isRealBug: z.boolean(),   // if true, the engine discards the proposal and files a bug
});
```

`isRealBug` is deliberately a first-class output. The most valuable thing a repair agent
can say is *"do not heal this — the app is broken."* Making that a normal, rewarded
answer rather than an exception path is what keeps the agent from rationalising a patch.

**Key input design decision:** the agent is handed candidates, not asked to invent
selectors. `query_candidates` runs Tier-0 generation (05) and passes ranked, verified,
`matchCount === 1` options. The model's job is to pick the one that matches *intent* —
a judgement call — not to guess syntax, which it does worse than a deterministic search.

---

## Author agent

Six phases. Only phases 2–5 use the model.

```
1. GROUND      (no model)  retrieve conventions + exemplars + seeded data + PO API
2. PLAN        (model)     domain-language step list, reviewed before any browser use
3. EXPLORE     (model)     drive a real browser; record every resolved locator
4. SYNTHESIZE  (model)     emit spec + page-object deltas in repo idiom
5. VERIFY      (no model)  falsifiability gate — see below
6. REFLECT     (model)     one repair loop on gate failure, then hand to a human
```

### Phase 1 — Ground

Retrieval, not guessing. Concretely, for `--feature events` the agent receives:

- `CLAUDE.md` conventions section (verbatim — it is already a precise spec).
- The **full export surface** of `src/ui/pages/events/events.page.ts`, as signatures.
- `src/ui/pages/events/events.constants.ts` in full.
- All seeded DTOs from `tests/testdata/seeded/events.ts`, with their partial-name guards.
- **Two exemplar specs**: the nearest existing spec in the same feature, and the nearest
  in a *different* feature that performs the same interaction shape (e.g. the gyms
  county-filter test when authoring an events county-filter test).

Exemplars beat style rules by a wide margin. "Match this file's idiom" with a concrete
file produces conventional code; a bulleted list of rules produces plausible-looking
code that fails review on five small things.

### Phase 3 — Explore

The agent drives the real app. Every successful action records `(intent, resolved
locator, stability rank)`. The synthesized spec is then built from **recorded**
locators, not remembered ones — eliminating the classic failure where a model writes a
selector it never actually verified.

The exploration transcript is also a first-class deliverable: if the gate fails, a human
reads what the agent actually saw.

### Phase 5 — Verify: the falsifiability gate

```ts
export async function falsifiabilityGate(
  candidate: GeneratedTest, ctx: AgentContext,
): Promise<GateResult> {
  const checks: GateCheck[] = [];

  checks.push(await check('typecheck', () => ctx.verify.typecheck()));
  checks.push(await check('lint',      () => ctx.verify.lint(candidate.files)));
  checks.push(await check('conventions', () => checkConventions(candidate, ctx.config.conventions)));

  // Stability: must pass every time.
  checks.push(await check('stability', async () => {
    const r = await ctx.verify.runTest(candidate, { repeat: ctx.config.agent.stabilityRuns ?? 5 });
    return r.passed === r.total ? ok() : fail(`passed ${r.passed}/${r.total}`);
  }));

  // Falsifiability: must fail under at least one mutation, or it proves nothing.
  const mutants = buildMutants(candidate);          // see below
  const outcomes = await Promise.all(mutants.map(m => ctx.verify.runMutant(candidate, m)));
  // NOT `killed.length > 0`. Mutants are not equal evidence: http-500 breaks
  // the whole page render, so it kills almost any test that loads a page.
  // Measured against the live app, a deliberately vacuous test ("navigate,
  // assert the header") was killed by http-500 and by nothing else — and a
  // one-kill rule certified it. Only DATA mutants count towards the verdict.
  const killed = outcomes.filter(o => o.failed);
  const meaningful = killed.filter(o => MEANINGFUL_CLASSES.has(o.class));
  checks.push(
    meaningful.length > 0
      ? ok('falsifiability', `killed ${meaningful.length} data mutant(s)`)
      : fail('falsifiability', 'survived every data mutant — it asserts nothing meaningful'),
  );

  return { passed: checks.every(c => c.ok), checks, killedMutants: killed };
}
```

Mutations are cheap and mechanical, generated by `buildMutants`:

| Mutant | Class | Should kill tests that... |
| --- | --- | --- |
| `empty-page` — every array in the response emptied | content | assert content is present |
| `unfiltered` — query parameters stripped, endpoint re-requested | discrimination | assert a filter narrows results |
| `http-500` — the API fails outright | **liveness** | touch the app at all — weak evidence alone |

Only `content` and `discrimination` kills count towards the verdict. A `liveness`
kill proves the test loads a page, which is not what any test claims to be about.

The "interaction skipped" mutant from the original design is not implemented:
`unfiltered` catches the same class of vacuous test through the network, without
needing a source-level transform of the candidate's own statements.

Mutation is applied by temporarily injecting a `beforeEach` into the candidate and
restoring the file afterwards — the same apply/run/restore discipline `validateHeal`
uses. An env var read by a cooperating fixture was rejected (it would require the
target repo to adopt an atest fixture, so the gate would not work on the suite that
needs it most), as was an HTTP proxy (a second network hop changes timing, and timing
is exactly what the stability check must not be confounded by).

That third row is the one that catches the most insidious generated test: one that
navigates, asserts the page header, and calls it filtering coverage. Against the
"unfiltered dataset" mutant it still passes — so the gate rejects it.

This gate also enforces your data policy mechanically. A generated test that asserts a
seeded card is on page 1 of an *unfiltered* list survives locally (61 gyms, lucky
ordering) but dies against the unfiltered mutant, exactly as `CLAUDE.md` requires.

---

## Prompting strategy

Concrete positions, not generalities.

1. **Structured output for everything.** Tool-use schemas derived from Zod. No prose
   parsing anywhere in the system.

2. **Prompt-cache the invariant block.** System prompt + conventions + page-object API
   surface are identical across every call in a run. Mark them cacheable; on a run
   analyzing 40 failures this is the difference between one conventions payload and
   forty. Order messages cache-prefix-first: `[system][conventions][exemplars] |
   [per-failure evidence]`.

3. **Two-model split by job, not by "quality".**
   - `classify` → Haiku 4.5: taxonomy tie-breaks, dedupe, narrative summarisation. High
     volume, low stakes.
   - `heal` → Sonnet 5: candidate ranking with reasoning. Medium volume, medium stakes.
   - `author` → Opus 5: planning, exploration, synthesis. Low volume, high stakes.

4. **Vision is gated, not default.** Screenshots are expensive and mostly redundant
   against ARIA. Send images only for `visual_diff` (what changed?) and
   `locator_not_actionable` (what is covering it?).

5. **Control depth with `effort`, never sampling parameters.** `temperature`, `top_p`, and
   `top_k` are **rejected with a 400** on Opus 5 and Sonnet 5 — the reflex to "set
   temperature 0 for determinism" is now a runtime error, and it never guaranteed identical
   outputs anyway. Use `output_config.effort`: `medium` for classification and heal ranking,
   `xhigh` for the author agent. Where the old instinct was "raise temperature for variety"
   (exploring alternative paths), get it from the prompt — ask for N distinct approaches and
   pick one — not from a knob that no longer exists.

6. **Negative instructions become guards.** Every "never do X" in a prompt should have a
   corresponding tool-layer or gate-layer enforcement. If it cannot be enforced, it is
   a suggestion — write it as one and do not rely on it.

7. **Version prompts as files** under `packages/agent/src/prompts/*.md`, with a
   `promptVersion` recorded on every proposal. When heal quality regresses you need to
   know which prompt produced which patch.

8. **Evaluate prompts against a fixture corpus.** Keep ~40 real evidence bundles with
   known-correct outcomes in `packages/agent/test/corpus/`. Any prompt change runs
   against them; regression in accepted-heal rate blocks the change. Prompt engineering
   without a regression suite is superstition.
