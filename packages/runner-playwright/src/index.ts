/**
 * @atest/runner-playwright — the Playwright adapter.
 *
 * The only package that knows Playwright exists. Everything above it consumes
 * EvidenceBundles and RunRecords, so swapping in a different runner means
 * writing a sibling of this package and nothing else.
 *
 * NOTE: this package must NOT depend on @atest/llm. The reporter runs inside
 * the test process; pulling an HTTP client and a model SDK into every worker
 * would be both slow and a place a credential should never be.
 */

export { default as AtestReporter, ATEST_VERSION } from './reporter.js';
export type { AtestReporterOptions } from './reporter.js';

export { assembleBundle, toClassifiable, classifyResult } from './assemble.js';
export type {
  AssembleInput,
  AssembleContext,
  Sidecars,
  TestCaseLike,
  TestResultLike,
  TestErrorLike,
} from './assemble.js';

export { parsePlaywrightError, splitCallLog, stripAnsi } from './errors.js';
export type { ParsedError } from './errors.js';

export { atestFixtures, createCaptureFixture } from './fixtures.js';
export type { CaptureOptions } from './fixtures.js';

export { bindPage, previewArgs, previewValue } from './bind.js';
export type { BoundPageObject } from './bind.js';

export { extractSteps, findFailingStep, parseStepTitle, domainStringArgs } from './steps.js';
export type { StepLike, ParsedStepTitle } from './steps.js';

export {
  SIDECAR,
  parseSidecar,
  SidecarParseError,
  PageSidecarSchema,
  NetworkSidecarSchema,
  ConsoleSidecarSchema,
  IntentSidecarSchema,
} from './sidecar.js';
export type {
  SidecarName,
  PageSidecar,
  NetworkSidecar,
  ConsoleSidecar,
  IntentSidecar,
} from './sidecar.js';

export { runPlaywright, escapeForGrep } from './spawn.js';
export type { PlaywrightRunOptions, PlaywrightRunResult } from './spawn.js';
