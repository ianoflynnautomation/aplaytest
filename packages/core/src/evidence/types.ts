/**
 * The Evidence Bundle — the central data structure of the system.
 *
 * Everything downstream (healing, flaky classification, MCP resources, report
 * insights) consumes this and only this. Engines never re-open a browser to
 * "go look"; if a field is missing, the fix is to capture it at source, not to
 * re-run the test.
 *
 * DESIGN NOTE — nullable, not optional. Fields that may be absent are typed
 * `T | null` rather than `field?: T`. Bundles are written to disk as JSON and
 * read back by other processes (and by humans with `jq`); `undefined`
 * disappears on serialisation, `null` round-trips. Every bundle therefore has
 * the same key set regardless of what was captured.
 */

import type { FailureKind } from '../taxonomy/kinds.js';
import type { LocatorStrategy } from '../locator/stability.js';

/** sha256(runId, testId, project, retry) — stable and reproducible. */
export type EvidenceId = string & { readonly __brand: 'EvidenceId' };

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One page-object call, captured by the bindPage wrapper. */
export interface StepRecord {
  /** e.g. "gymsPage" */
  readonly pageObject: string;
  /** e.g. "expectCardData" */
  readonly method: string;
  /** Domain arguments, JSON-safe and redacted. */
  readonly args: readonly unknown[];
  readonly startedAt: string;
  readonly durationMs: number;
  readonly failed: boolean;
}

/** Where a selector literal lives in source — the target of a heal patch. */
export interface SelectorSource {
  readonly file: string;
  readonly line: number;
  /** e.g. "TEST_IDS.cardName" */
  readonly constantPath: string;
  /** Other constants in the same file holding the identical literal. */
  readonly aliases: readonly string[];
}

export interface LocatorCandidate {
  readonly strategy: LocatorStrategy;
  /** e.g. "getByRole('option', { name: 'Cork' })" */
  readonly expression: string;
  /** Must be exactly 1 to be eligible — ambiguity is disqualifying. */
  readonly matchCount: number;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly accessibleName: string | null;
  readonly boundingBox: Rect | null;
  /** 0 = means the same thing, 1 = unrelated. Tier-0 heuristic. */
  readonly semanticDistance: number;
  /** 0 = testid … 6 = xpath. See locator/stability. */
  readonly stabilityRank: number;
}

export interface RequestRecord {
  readonly url: string;
  readonly method: string;
  readonly status: number | null;
  readonly durationMs: number;
  readonly failureText: string | null;
  /** Set when the body was parsed against a wire schema and failed. */
  readonly schemaError: string | null;
}

export interface AppSpanRecord {
  readonly spanId: string;
  readonly name: string;
  readonly durationMs: number;
  readonly status: 'ok' | 'error' | 'unset';
}

export interface EvidenceBundle {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly id: EvidenceId;
  readonly runId: string;
  /** Joins to OpenTelemetry / Tempo. Derived, not random. */
  readonly traceId: string;
  readonly capturedAt: string;

  readonly test: {
    /** Playwright's stable test id — survives a title rename. */
    readonly id: string;
    readonly title: string;
    readonly titlePath: readonly string[];
    readonly file: string;
    readonly line: number;
    readonly project: string;
    readonly tags: readonly string[];
    readonly retry: number;
    readonly workerIndex: number;
    readonly shard: { readonly current: number; readonly total: number } | null;
  };

  readonly failure: {
    readonly kind: FailureKind;
    readonly message: string;
    readonly stack: string;
    /** e.g. "toBeVisible" | "toHaveText" */
    readonly matcher: string | null;
    readonly expected: string | null;
    readonly actual: string | null;
    readonly timedOut: boolean;
  };

  /** What the test was trying to do, in domain terms. */
  readonly intent: {
    readonly steps: readonly StepRecord[];
    readonly failingStep: StepRecord | null;
    readonly selector: string | null;
    readonly selectorSource: SelectorSource | null;
  };

  /** Primary model-facing page representation. ARIA first: cheap and semantic. */
  readonly page: {
    readonly url: string;
    readonly title: string;
    readonly ariaSnapshot: string;
    readonly candidates: readonly LocatorCandidate[];
    /** Structural skeleton only, sent when ARIA is insufficient. */
    readonly htmlDigest: string | null;
    /** Every data-testid present. The cheapest answer to "was it renamed?" */
    readonly testIdsPresent: readonly string[];
  };

  readonly visual: {
    readonly screenshotPath: string | null;
    readonly diffPath: string | null;
    readonly diffPixelRatio: number | null;
  };

  readonly network: {
    readonly failed: readonly RequestRecord[];
    readonly slow: readonly RequestRecord[];
    readonly statusCounts: Readonly<Record<string, number>>;
  };

  readonly console: {
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  };

  readonly timing: {
    readonly testMs: number;
    readonly failingActionMs: number | null;
    readonly navigationMs: number | null;
    /** testMs / configured timeout. Near 1.0 implies a timing failure. */
    readonly budgetUsedRatio: number;
  };

  readonly env: {
    readonly appEnv: string;
    readonly baseUrl: string;
    readonly browser: string;
    readonly platform: string;
    readonly workers: number;
    readonly commit: string;
    readonly changedPaths: readonly string[];
  };

  /** Populated when an OTel backend is reachable; joined on traceId. */
  readonly appSpans: readonly AppSpanRecord[] | null;

  readonly artifacts: {
    readonly tracePath: string | null;
    readonly videoPath: string | null;
  };
}

/**
 * The subset of a bundle the classifier needs. Keeping this narrow means
 * classification can be unit-tested against small fixtures instead of
 * requiring a full bundle, and makes the classifier reusable at capture time
 * before the rest of the bundle is assembled.
 */
export interface ClassifiableFailure {
  readonly message: string;
  readonly stack: string;
  readonly matcher: string | null;
  readonly timedOut: boolean;
  readonly consoleErrors: readonly string[];
  readonly failedRequests: readonly RequestRecord[];
  readonly budgetUsedRatio: number;
}
