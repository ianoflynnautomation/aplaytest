/**
 * The MCP tool surface.
 *
 * Deliberately few. A server with forty tools makes the client agent worse at
 * choosing, and every tool here is a thin envelope over the SAME engine
 * function the CLI calls — if a capability exists in one surface and not the
 * other, that is a bug in an adapter rather than a missing feature.
 *
 * Note what `atest_list_failures` does NOT return: the ARIA snapshot. Handing
 * back full evidence for forty failures would blow the client's context in a
 * single call. The agent picks one failure, then fetches its detail.
 */

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { z } from 'zod';
import { falsifiabilityGate, ground } from '@atest/author';
import {
  MemoryHistoryStore,
  formatFailingStep,
  ingestDirectory,
  loadRunBundles,
  type EvidenceBundle,
} from '@atest/core';
import { DEFAULT_ANALYZE_CONFIG, analyzeAll } from '@atest/flaky';
import {
  DEFAULT_HEAL_OPTIONS,
  assessBundle,
  generateCandidates,
  missingTestIds,
  proposeHeal,
} from '@atest/heal';
import {
  DEFAULT_SELECTION_CONFIG,
  DEFAULT_SPEC_PATTERN,
  buildCoverage,
  buildGraph,
  resolveTsConfig,
  scanRouteOwnership,
  selectTests,
} from '@atest/impact';

export interface ToolContext {
  readonly cwd: string;
  readonly evidenceDir: string;
  readonly runsDir: string;
}

/**
 * The schema drives the type, never the other way round.
 *
 * Declaring the input shape by hand and asserting `z.ZodType<I>` over it fights
 * `exactOptionalPropertyTypes`: Zod infers `run?: string | undefined` while a
 * hand-written `run?: string` is a different type. Inferring from the schema
 * means the two can never drift.
 */
type ToolSchema = z.ZodObject;

export interface ToolDefinition<S extends ToolSchema = ToolSchema> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: S;
  handler(input: z.output<S>, context: ToolContext): Promise<unknown>;
}

/**
 * Full inference at the definition site, erased at the collection site so the
 * registry can hold tools with different input shapes in one array.
 */
export function defineTool<S extends ToolSchema>(definition: ToolDefinition<S>): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

const DEFAULT_FAILURE_LIMIT = 50;
const DEFAULT_FAILURE_INCLUDES = ['aria', 'candidates'] as const;

async function loadBundles(context: ToolContext, run?: string): Promise<EvidenceBundle[]> {
  const { bundles } = await loadRunBundles(context.evidenceDir, run);
  return [...bundles];
}

async function findBundle(
  context: ToolContext,
  evidenceId: string,
): Promise<EvidenceBundle | undefined> {
  const bundles = await loadBundles(context);
  return bundles.find(bundle => bundle.id === evidenceId);
}

export const listFailures = defineTool({
  name: 'atest_list_failures',
  title: 'List captured failures',
  description:
    'Summarise failures from a run: kind, intent, location, flake score. Deliberately omits ' +
    'the accessibility tree — call atest_get_failure for one failure once you have chosen it.',
  schema: z.object({
    run: z.string().optional(),
    kind: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(input, context) {
    const bundles = await loadBundles(context, input.run);
    const filtered =
      input.kind === undefined ? bundles : bundles.filter(b => b.failure.kind === input.kind);

    return {
      count: filtered.length,
      failures: filtered.slice(0, input.limit ?? DEFAULT_FAILURE_LIMIT).map(b => ({
        evidenceId: b.id,
        title: b.test.title,
        file: relative(context.cwd, b.test.file),
        line: b.test.line,
        project: b.test.project,
        kind: b.failure.kind,
        intent: formatFailingStep(b.intent.failingStep),
        selector: b.intent.selector,
        healable: assessBundle(b).eligible,
      })),
    };
  },
});

export const getFailure = defineTool({
  name: 'atest_get_failure',
  title: 'Get one failure in detail',
  description:
    'Full evidence for a single failure. Defaults to the accessibility tree and ranked heal ' +
    'candidates — the two things that actually explain a locator failure. Screenshots are ' +
    'never inlined; fetch the resource URI deliberately if you need one.',
  schema: z.object({
    evidenceId: z.string(),
    include: z.array(z.enum(['aria', 'candidates', 'network', 'console', 'steps'])).optional(),
  }),
  async handler(input, context) {
    const bundle = await findBundle(context, input.evidenceId);
    if (bundle === undefined) return { error: 'not_found', evidenceId: input.evidenceId };

    const include = new Set(input.include ?? DEFAULT_FAILURE_INCLUDES);
    const eligibility = assessBundle(bundle);

    return {
      evidenceId: bundle.id,
      test: bundle.test,
      failure: bundle.failure,
      intent: {
        selector: bundle.intent.selector,
        failingStep: bundle.intent.failingStep,
        ...(include.has('steps') ? { steps: bundle.intent.steps } : {}),
      },
      page: {
        url: bundle.page.url,
        testIdsPresent: bundle.page.testIdsPresent,
        ...(include.has('aria') ? { ariaSnapshot: bundle.page.ariaSnapshot } : {}),
      },
      heal: {
        eligible: eligibility.eligible,
        reason: eligibility.reason,
        ...(include.has('candidates') ? { candidates: generateCandidates(bundle) } : {}),
      },
      ...(include.has('network') ? { network: bundle.network } : {}),
      ...(include.has('console') ? { console: bundle.console } : {}),
      screenshot:
        // A path the client can open, not a resource URI this server does not
        // register. Screenshots are never inlined — they blow the token budget.
        bundle.visual.screenshotPath,
    };
  },
});

export const flakyQuery = defineTool({
  name: 'atest_flaky_query',
  title: 'Query flake history',
  description:
    'Flake scores and root-cause classification from recorded run history. Entirely ' +
    'deterministic — every number came from measuring past runs.',
  schema: z.object({
    testId: z.string().optional(),
    minScore: z.number().min(0).max(1).optional(),
  }),
  async handler(input, context) {
    const store = new MemoryHistoryStore();
    const ingest = await ingestDirectory(store, context.runsDir);
    const report = await analyzeAll(store, DEFAULT_ANALYZE_CONFIG);
    await store.close();

    const verdicts = report.verdicts
      .filter(v => input.testId === undefined || v.testId === input.testId)
      .filter(v => input.minScore === undefined || v.score.score >= input.minScore);

    return {
      runsAnalysed: ingest.runsIngested,
      verdicts: verdicts.map(v => ({
        testId: v.testId,
        title: v.title,
        project: v.project,
        score: v.score.score,
        flaky: v.flaky,
        class: v.classification.class,
        prescription: v.classification.prescription,
        retryHelps: v.classification.retryable,
        evidence: v.classification.evidence,
      })),
      regressions: report.regressions.map(v => v.title),
    };
  },
});

export const impact = defineTool({
  name: 'atest_impact',
  title: 'Which specs a change could affect',
  description:
    'Selects specs from an import graph plus recorded route coverage. Every selection comes ' +
    'with the reason that produced it; specs that cannot be attributed are always included.',
  schema: z.object({ changed: z.array(z.string()).min(1) }),
  async handler(input, context) {
    const tsConfigPath = resolveTsConfig(context.cwd);
    const graph = buildGraph({
      tsConfigPath,
      rootDir: context.cwd,
      specPattern: DEFAULT_SPEC_PATTERN,
    });

    const store = new MemoryHistoryStore();
    const ingested = await ingestDirectory(store, context.runsDir);
    const attempts = await store.attempts();
    await store.close();

    const routeInputs =
      ingested.runsIngested > 0
        ? {
            ownership: scanRouteOwnership(tsConfigPath, context.cwd),
            coverage: buildCoverage(
              attempts.map(a => ({
                file: relative(context.cwd, a.file).split('\\').join('/'),
                routes: [...a.routes],
              })),
            ),
          }
        : undefined;

    const selection = selectTests(graph, input.changed, DEFAULT_SELECTION_CONFIG, routeInputs);

    return {
      mode: selection.mode,
      reason: selection.fullSuiteReason,
      selected: selection.selected,
      totalSpecs: selection.totalSpecs,
      reasons: selection.reasons,
      hasRouteCoverage: routeInputs !== undefined,
    };
  },
});

export const proposeHealTool = defineTool({
  name: 'atest_propose_heal',
  title: 'Propose a selector heal',
  description:
    'Computes a patch for a drifted selector and returns it as data. Does NOT write anything ' +
    'and does NOT validate — safe to call while exploring. To apply, run `atest heal --apply` ' +
    'from the CLI after showing the diff to the user.',
  schema: z.object({ evidenceId: z.string(), constantsFile: z.string() }),
  async handler(input, context) {
    const bundle = await findBundle(context, input.evidenceId);
    if (bundle === undefined) return { error: 'not_found', evidenceId: input.evidenceId };

    const source = await readFile(join(context.cwd, input.constantsFile), 'utf8').catch(() => null);
    if (source === null) return { error: 'cannot_read', file: input.constantsFile };

    const proposal = await proposeHeal(bundle, {
      cwd: context.cwd,
      constantsFile: input.constantsFile,
      constantsText: source,
      specFile: bundle.test.file,
      validationRuns: DEFAULT_HEAL_OPTIONS.validationRuns,
      checkCollateral: false,
      skipValidation: true,
    });

    if (proposal.status !== 'proposed' || proposal.chosen === null || proposal.patch === null) {
      return { status: proposal.status, reason: proposal.reason };
    }

    return {
      status: proposal.patch.status,
      from: missingTestIds(bundle.intent.selector, bundle.page.testIdsPresent)[0] ?? null,
      to: proposal.chosen.value,
      constantsTouched: proposal.patch.touched,
      diffPreview: proposal.patch.after,
      candidates: proposal.candidates,
      validated: false,
      note: 'Not validated. Run `atest heal --apply` to validate by re-running the test.',
    };
  },
});

export const groundFeature = defineTool({
  name: 'atest_ground_feature',
  title: 'What the repo already says about a feature',
  description:
    'Retrieves the conventions file, the feature page object API, seeded fixtures and exemplar ' +
    'specs for a feature — the same grounding the author agent receives. Returns SIGNATURES and ' +
    'paths, not file bodies, so it can be called before deciding what to read in full.',
  schema: z.object({ feature: z.string().min(1) }),
  async handler(input, context) {
    const bundle = await ground({ cwd: context.cwd, feature: input.feature });
    return {
      feature: bundle.feature,
      conventionsPath: bundle.conventionsPath,
      pageObjectPath: bundle.pageObjectPath,
      pageObjectApi: bundle.pageObjectApi,
      seededDataPath: bundle.seededDataPath,
      // Paths and reasons only. Inlining two full spec files would spend the
      // caller's context on something it can read deliberately if it wants to.
      exemplars: bundle.exemplars.map(e => ({ path: e.path, reason: e.reason })),
      missing: bundle.missing,
    };
  },
});

export const gateTest = defineTool({
  name: 'atest_gate_test',
  title: 'Does this test actually assert anything?',
  description:
    'Runs the falsifiability gate: the test must pass repeatedly AND fail when the API is mutated ' +
    'to return empty or unfiltered data. Answers the question a passing test cannot — whether it ' +
    'would notice if the feature broke. Applies to human-written tests too. Slow (several full ' +
    'Playwright runs) and it temporarily rewrites the spec, so it is gated behind ATEST_MCP_WRITE.',
  schema: z.object({
    specFile: z.string().min(1),
    testTitle: z.string().min(1),
    stabilityRuns: z.number().int().min(1).max(10).optional(),
    apiPattern: z.string().optional(),
    confirm: z.boolean().optional(),
  }),
  async handler(input, context) {
    const result = await falsifiabilityGate({
      cwd: context.cwd,
      specFile: input.specFile,
      testTitle: input.testTitle,
      ...(input.stabilityRuns === undefined ? {} : { stabilityRuns: input.stabilityRuns }),
      ...(input.apiPattern === undefined ? {} : { apiPattern: input.apiPattern }),
    });

    return {
      passed: result.passed,
      summary: result.summary,
      checks: result.checks,
      mutants: result.mutants.map(m => ({
        name: m.name,
        class: m.class,
        killed: m.killed,
        kills: m.kills,
      })),
      // Stated rather than implied: a caller that sees `passed: false` should
      // fix the test's assertions, not retry the gate.
      guidance: result.passed
        ? 'The test fails when the data breaks, so it asserts something real.'
        : 'The test passes even when the API returns nothing. Assert on the data it claims to test.',
    };
  },
});

export const ALL_TOOLS = [
  listFailures,
  getFailure,
  flakyQuery,
  impact,
  proposeHealTool,
  groundFeature,
  gateTest,
] as const;
