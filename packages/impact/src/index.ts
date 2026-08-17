/**
 * @atest/impact — test selection from a static import graph.
 *
 * Entirely deterministic. The one place a model could help is mapping a diff
 * in ANOTHER repository (the application) onto tests here, where no import
 * edge exists — and even there it may only ADD tests, never remove them, so a
 * model error costs CI minutes rather than coverage.
 */

export {
  buildGraph,
  affectedSpecs,
  unattributableSpecs,
  hubFiles,
  reachesOnlyViaHubs,
  resolveTsConfig,
  DEFAULT_SPEC_PATTERN,
} from './graph.js';
export type { ImportGraph, GraphOptions, HubFile } from './graph.js';

export { selectTests, toPlaywrightArgs, DEFAULT_SELECTION_CONFIG } from './select.js';
export type { Selection, SelectionConfig, SelectionReason, SelectionMode } from './select.js';

export {
  scanRouteOwnership,
  buildCoverage,
  selectByRoute,
  specsWithoutCoverage,
  normaliseRoute,
} from './coverage.js';
export type { RouteOwnership, RouteCoverage, RouteSelection, CoverageAttempt } from './coverage.js';
export type { RouteInputs } from './select.js';
