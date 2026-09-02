/**
 * Assemble an EvidenceBundle from Playwright's test objects plus the optional
 * fixture sidecars.
 *
 * Deliberately PURE and synchronous, over structural interfaces rather than
 * Playwright's own types: the whole thing is unit-testable with plain object
 * fixtures, no browser and no runner. The reporter does the async I/O and
 * hands the results in.
 */

import {
  classify,
  evidenceId,
  joinErrors,
  parseLocator,
  parsePlaywrightError,
  testIdDistance,
  type ClassifiableFailure,
  type EvidenceBundle,
  type FailureKind,
  type LocatorCandidate,
  type RequestRecord,
  type StepRecord,
} from '@atest/core';

import { extractSteps, findFailingStep, type StepLike } from './steps.js';
import type { ConsoleSidecar, IntentSidecar, NetworkSidecar, PageSidecar } from './sidecar.js';

export interface TestCaseLike {
  readonly id: string;
  readonly title: string;
  readonly titlePath: () => string[];
  readonly location: { readonly file: string; readonly line: number };
  readonly tags: readonly string[];
}

export interface TestErrorLike {
  readonly message?: string | undefined;
  readonly stack?: string | undefined;
}

export interface TestResultLike {
  readonly status: string;
  readonly duration: number;
  readonly retry: number;
  readonly workerIndex: number;
  readonly startTime: Date;
  readonly errors: readonly TestErrorLike[];
  readonly steps: readonly StepLike[];
  readonly attachments: readonly {
    readonly name: string;
    readonly path?: string | undefined;
    readonly contentType: string;
  }[];
}

export interface AssembleContext {
  readonly runId: string;
  readonly traceId: string | null;
  readonly project: string;
  readonly shard: { readonly current: number; readonly total: number } | null;
  readonly workers: number;
  readonly appEnv: string;
  readonly baseUrl: string;
  readonly browser: string;
  readonly platform: string;
  readonly commit: string;
  readonly changedPaths: readonly string[];
  /** Configured test timeout, used to compute how much budget was consumed. */
  readonly timeoutMs: number;
}

export interface Sidecars {
  readonly page: PageSidecar | null;
  readonly network: NetworkSidecar | null;
  readonly console: ConsoleSidecar | null;
  readonly intent: IntentSidecar | null;
}

export interface AssembleInput {
  readonly test: TestCaseLike;
  readonly result: TestResultLike;
  readonly sidecars: Sidecars;
  readonly context: AssembleContext;
}

const EMPTY_SIDECARS: Sidecars = { page: null, network: null, console: null, intent: null };

function attachmentPath(result: TestResultLike, name: string): string | null {
  return result.attachments.find(a => a.name === name)?.path ?? null;
}

/** Candidates further than this from the intended id are not plausible renames. */
const MAX_SEED_DISTANCE = 0.4;
/** Enough for a ranker to choose from; small enough to stay readable. */
const MAX_SEED_CANDIDATES = 10;

/**
 * Seed candidates from the test-id index.
 *
 * Two things this must NOT do. It must not return every id on the page — a
 * real page carries dozens, and an unranked dump is noise that pushes the
 * cost of choosing onto whatever reads it. And it must not claim the
 * candidates resolve uniquely: no browser is available in the reporter, so
 * `matchCount` is -1 to mean "not checked" rather than asserting a uniqueness
 * nobody measured. The heal engine verifies against a live page before it
 * ranks anything.
 */
function seedCandidates(intended: string | null, present: readonly string[]): LocatorCandidate[] {
  const parsed = parseLocator(intended);
  if (parsed === null || parsed.strategy !== 'testid') return [];

  return present
    .filter(id => id !== parsed.value)
    .map(id => ({ id, distance: testIdDistance(parsed.value, id) }))
    .filter(({ distance }) => distance <= MAX_SEED_DISTANCE)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_SEED_CANDIDATES)
    .map(({ id, distance }) => ({
      strategy: 'testid' as const,
      expression: `getByTestId('${id}')`,
      matchCount: -1,
      visible: false,
      enabled: false,
      accessibleName: null,
      boundingBox: null,
      semanticDistance: distance,
      stabilityRank: 0,
    }));
}

export function toClassifiable(
  result: TestResultLike,
  sidecars: Sidecars,
  timeoutMs: number,
): ClassifiableFailure {
  const { message, stack } = joinErrors(result.errors);
  const parsed = parsePlaywrightError(message, stack);

  return {
    message,
    stack,
    matcher: parsed.matcher,
    timedOut: parsed.timedOut || result.status === 'timedOut',
    consoleErrors: sidecars.console?.errors ?? [],
    failedRequests: (sidecars.network?.failed ?? []) as readonly RequestRecord[],
    budgetUsedRatio: timeoutMs > 0 ? result.duration / timeoutMs : 0,
  };
}

/**
 * Assemble an {@link EvidenceBundle} from a Playwright test result.
 *
 * The reporter calls this once per failure. Classification, step extraction,
 * and sidecar merge happen here so a reporting failure cannot become a test
 * failure — the caller swallows errors from this function.
 *
 * @param input - Playwright test/result shapes, run context, and optional
 *   capture-fixture sidecars (ARIA, network, console, intent).
 * @returns A schema-versioned evidence bundle ready to persist.
 */
export function assembleBundle(input: AssembleInput): EvidenceBundle {
  const { test, result, context } = input;
  const sidecars = { ...EMPTY_SIDECARS, ...input.sidecars };

  const { message, stack } = joinErrors(result.errors);
  const parsed = parsePlaywrightError(message, stack);
  const classifiable = toClassifiable(result, sidecars, context.timeoutMs);
  const classification = classify(classifiable);

  const steps: StepRecord[] = extractSteps(result.steps);
  const failingStep = findFailingStep(result.steps);

  // The fixture's recorded selector is authoritative when present — it knows
  // which locator the page object actually built. Falling back to the parsed
  // error text is a best effort for suites without the fixture wrapper.
  const selector = sidecars.intent?.selector ?? parsed.locator;

  return {
    schemaVersion: 1,
    id: evidenceId({
      runId: context.runId,
      testId: test.id,
      project: context.project,
      retry: result.retry,
    }),
    runId: context.runId,
    traceId: context.traceId ?? '',
    capturedAt: new Date().toISOString(),

    test: {
      id: test.id,
      title: test.title,
      titlePath: test.titlePath(),
      file: test.location.file,
      line: test.location.line,
      project: context.project,
      tags: test.tags,
      retry: result.retry,
      workerIndex: result.workerIndex,
      shard: context.shard,
    },

    failure: {
      kind: classification.kind as FailureKind,
      message,
      stack,
      matcher: parsed.matcher,
      expected: parsed.expected,
      actual: parsed.actual,
      timedOut: classifiable.timedOut,
    },

    intent: {
      steps,
      failingStep,
      selector,
      selectorSource: sidecars.intent?.selectorSource ?? null,
    },

    page: {
      url: sidecars.page?.url ?? '',
      title: sidecars.page?.title ?? '',
      ariaSnapshot: sidecars.page?.ariaSnapshot ?? '',
      candidates: seedCandidates(selector, sidecars.page?.testIdsPresent ?? []),
      htmlDigest: sidecars.page?.htmlDigest ?? null,
      testIdsPresent: sidecars.page?.testIdsPresent ?? [],
    },

    visual: {
      screenshotPath: attachmentPath(result, 'screenshot'),
      diffPath: attachmentPath(result, 'diff'),
      diffPixelRatio: null,
    },

    network: {
      failed: (sidecars.network?.failed ?? []) as readonly RequestRecord[],
      slow: (sidecars.network?.slow ?? []) as readonly RequestRecord[],
      statusCounts: sidecars.network?.statusCounts ?? {},
    },

    console: {
      errors: sidecars.console?.errors ?? [],
      warnings: sidecars.console?.warnings ?? [],
    },

    timing: {
      testMs: result.duration,
      failingActionMs: failingStep?.durationMs ?? null,
      navigationMs: null,
      budgetUsedRatio: classifiable.budgetUsedRatio,
    },

    env: {
      appEnv: context.appEnv,
      baseUrl: context.baseUrl,
      browser: context.browser,
      platform: context.platform,
      workers: context.workers,
      commit: context.commit,
      changedPaths: context.changedPaths,
    },

    appSpans: null,

    artifacts: {
      tracePath: attachmentPath(result, 'trace'),
      videoPath: attachmentPath(result, 'video'),
    },
  };
}

/** Re-exported so the reporter can record the rule that fired. */
export function classifyResult(
  result: TestResultLike,
  sidecars: Sidecars,
  timeoutMs: number,
): ReturnType<typeof classify> {
  return classify(toClassifiable(result, sidecars, timeoutMs));
}
