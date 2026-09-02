/**
 * Test selection.
 *
 * The guards matter more than the graph. Impact analysis trades coverage for
 * latency, and every rule here exists to bound what that trade can cost:
 *
 *   · `main` runs everything. Selection is a pull-request optimisation only.
 *   · Smoke always runs. It is the floor, and it is cheap.
 *   · Some paths trigger the full suite outright — configuration, shared
 *     modules, lockfiles. Cheap insurance against a clever-but-wrong selection.
 *   · Above a threshold share, run everything. The saving stops justifying
 *     the risk long before it reaches 100%.
 *   · Specs the graph cannot attribute are always run, never dropped.
 *
 * A model is not involved and does not need to be.
 */

import {
  selectByRoute,
  specsWithoutCoverage,
  type RouteCoverage,
  type RouteOwnership,
} from './coverage.js';
import {
  affectedSpecs,
  hubFiles,
  reachesOnlyViaHubs,
  unattributableSpecs,
  type HubFile,
  type ImportGraph,
} from './graph.js';

export type SelectionMode = 'full' | 'partial';

export interface SelectionConfig {
  /** Changing any of these runs everything. */
  readonly fullSuiteTriggers: readonly string[];
  /** Above this share of all specs, just run everything. */
  readonly fullSuiteThreshold: number;
  /** Specs matching these always run regardless of the diff. */
  readonly alwaysRun: readonly string[];
  /** Treat unattributable specs as always-run rather than dropping them. */
  readonly runUnattributable: boolean;
}

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  fullSuiteTriggers: [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'playwright.config.ts',
    'atest.config.ts',
    'Dockerfile',
  ],
  fullSuiteThreshold: 0.6,
  alwaysRun: [],
  runUnattributable: true,
};

export interface SelectionReason {
  readonly spec: string;
  readonly reason: 'always-run' | 'unattributable' | 'imports-changed-file' | 'visited-route' | 'no-coverage';
  /** The import chain that selected it, changed file first. */
  readonly via: readonly string[];
}

export interface Selection {
  readonly mode: SelectionMode;
  /** Files nearly every spec depends on, which defeat narrowing. */
  readonly hubs: readonly HubFile[];
  /** Why the whole suite is running, when it is. */
  readonly fullSuiteReason: string | null;
  readonly selected: readonly string[];
  readonly reasons: readonly SelectionReason[];
  readonly totalSpecs: number;
  readonly changed: readonly string[];
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => {
    if (pattern.includes('*')) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/(?<!\.)\*/g, '[^/]*');
      return new RegExp(`^${escaped}$`).test(path);
    }
    return path === pattern || path.endsWith(`/${pattern}`);
  });
}

export interface RouteInputs {
  readonly ownership: RouteOwnership;
  readonly coverage: RouteCoverage;
}

/**
 * Select which specs a diff should run.
 *
 * Guards bound what the import-graph trade can cost: full-suite triggers,
 * hubs, unattributable specs, and an optional route-coverage signal that
 * survives a shared fixture barrel. A model is not involved.
 *
 * @param graph - Import graph from `buildGraph`.
 * @param changed - Repo-relative paths that changed.
 * @param config - Triggers, always-run tags, and the full-suite threshold.
 * @param routeInputs - Optional ownership + coverage, used before the graph
 *   when present.
 * @returns Either a partial selection with a reason per spec, or `mode: 'full'`
 *   with an explanation of why nothing was skipped.
 *
 * @example
 * ```ts
 * const graph = buildGraph({ rootDir: process.cwd() });
 * const selection = selectTests(graph, ['src/pages/gyms.page.ts']);
 * await playwright.test(toPlaywrightArgs(selection));
 * ```
 */
export function selectTests(
  graph: ImportGraph,
  changed: readonly string[],
  config: SelectionConfig = DEFAULT_SELECTION_CONFIG,
  routeInputs?: RouteInputs,
): Selection {
  const total = graph.specs.length;

  const trigger = changed.find(path => matchesAny(path, config.fullSuiteTriggers));
  if (trigger !== undefined) {
    return {
      mode: 'full',
      fullSuiteReason: `${trigger} changed — that reaches everything, so nothing is skipped.`,
      selected: graph.specs,
      reasons: [],
      totalSpecs: total,
      changed,
      hubs: [],
    };
  }

  const hubs = hubFiles(graph);
  const paths = affectedSpecs(graph, changed);

  // Route selection FIRST, when the data exists. It is the only signal that
  // survives a shared fixture barrel, so trying it before falling back to the
  // import graph is what makes selection possible at all in such a suite.
  if (routeInputs !== undefined) {
    const byRoute = selectByRoute(changed, routeInputs.ownership, routeInputs.coverage);

    if (!byRoute.noOwnership) {
      const reasons: SelectionReason[] = [];
      const selected = new Set<string>();

      for (const spec of graph.specs) {
        if (matchesAny(spec, config.alwaysRun)) {
          selected.add(spec);
          reasons.push({ spec, reason: 'always-run', via: [] });
        }
      }

      // A spec with no recorded coverage has never been observed, so nothing
      // is known about it. Dropping it would be a guess dressed as a decision.
      for (const spec of specsWithoutCoverage(graph.specs, routeInputs.coverage)) {
        if (selected.has(spec)) continue;
        selected.add(spec);
        reasons.push({ spec, reason: 'no-coverage', via: [] });
      }

      for (const [spec, routes] of byRoute.selected) {
        // Coverage can name a spec the graph does not know about — a deleted
        // file, or a path recorded in a different form. Selecting something
        // that is not in the suite is how "3/2 selected" happens.
        if (selected.has(spec) || !graph.specs.includes(spec)) continue;
        selected.add(spec);
        reasons.push({ spec, reason: 'visited-route', via: routes });
      }

      if (total > 0 && selected.size / total > config.fullSuiteThreshold) {
        return {
          mode: 'full',
          fullSuiteReason:
            `${selected.size}/${total} specs selected by route coverage, above the ` +
            `${(config.fullSuiteThreshold * 100).toFixed(0)}% threshold.`,
          selected: graph.specs,
          reasons,
          totalSpecs: total,
          changed,
          hubs,
        };
      }

      return {
        mode: 'partial',
        fullSuiteReason: null,
        selected: [...selected].sort(),
        reasons: reasons.sort((a, b) => a.spec.localeCompare(b.spec)),
        totalSpecs: total,
        changed,
        hubs,
      };
    }
  }

  // If every route from the diff to a spec runs through a hub, the graph has
  // not actually discriminated — it has just confirmed that everything
  // depends on the hub. Presenting that as a narrowed selection would be a
  // number that looks like insight and is not.
  if (reachesOnlyViaHubs(paths, hubs)) {
    const worst = hubs[0];
    return {
      mode: 'full',
      fullSuiteReason:
        `every affected spec reaches this change only through ${worst?.file ?? 'a shared module'}, ` +
        `which ${((worst?.reach ?? 0) * 100).toFixed(0)}% of specs import. Static analysis cannot ` +
        'narrow past a hub like that — runtime coverage could.',
      selected: graph.specs,
      reasons: [],
      totalSpecs: total,
      changed,
      hubs,
    };
  }

  const reasons: SelectionReason[] = [];
  const selected = new Set<string>();

  for (const spec of graph.specs) {
    if (matchesAny(spec, config.alwaysRun)) {
      selected.add(spec);
      reasons.push({ spec, reason: 'always-run', via: [] });
    }
  }

  if (config.runUnattributable) {
    for (const spec of unattributableSpecs(graph)) {
      if (selected.has(spec)) continue;
      selected.add(spec);
      reasons.push({ spec, reason: 'unattributable', via: [] });
    }
  }

  for (const [spec, path] of paths) {
    if (selected.has(spec)) continue;
    selected.add(spec);
    reasons.push({ spec, reason: 'imports-changed-file', via: path });
  }

  // Past the threshold the bookkeeping stops being worth the risk: a
  // near-full run that skips a handful of tests carries all the danger of
  // selection and almost none of the saving.
  if (total > 0 && selected.size / total > config.fullSuiteThreshold) {
    return {
      mode: 'full',
      fullSuiteReason:
        `${selected.size}/${total} specs selected, above the ` +
        `${(config.fullSuiteThreshold * 100).toFixed(0)}% threshold — running everything is safer ` +
        'and barely slower.',
      selected: graph.specs,
      reasons,
      totalSpecs: total,
      changed,
      hubs,
    };
  }

  return {
    mode: 'partial',
    fullSuiteReason: null,
    selected: [...selected].sort(),
    reasons: reasons.sort((a, b) => a.spec.localeCompare(b.spec)),
    totalSpecs: total,
    changed,
    hubs,
  };
}

/** A Playwright-ready argument list for the selection. */
export function toPlaywrightArgs(selection: Selection): string[] {
  return selection.mode === 'full' ? [] : [...selection.selected];
}
