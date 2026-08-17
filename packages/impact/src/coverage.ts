/**
 * Route-based selection — the signal that survives a fixture barrel.
 *
 * The import graph says every spec depends on every feature, because they all
 * compose one `test` object. That is *true*, and useless. Two independent
 * facts narrow past it:
 *
 *   OWNERSHIP (static)  which file navigates to which route — `page.goto('/gyms')`
 *   COVERAGE  (runtime) which routes each test actually visited
 *
 * Change a file that owns `/gyms`, and the tests worth running are the ones
 * that went to `/gyms`. Neither fact passes through the barrel, so neither is
 * washed out by it.
 *
 * This also fixes the case the import graph can never see: a route sweep that
 * reads its targets from an array imports no page object at all, but its
 * coverage records every route it visited.
 */

import { Project, SyntaxKind } from 'ts-morph';
import { relative } from 'node:path';

/** file → routes it navigates to. */
export type RouteOwnership = ReadonlyMap<string, ReadonlySet<string>>;

/** spec file → routes its tests visited. */
export type RouteCoverage = ReadonlyMap<string, ReadonlySet<string>>;

const GOTO_METHODS = new Set(['goto', 'navigate']);

/**
 * Scan for navigation literals: `page.goto('/gyms')`.
 *
 * Deliberately literal-only. A computed route (`page.goto(url)`) is not
 * guessed at — an ownership claim that might be wrong is worse than no claim,
 * because it would silently narrow the selection to the wrong set.
 */
export function scanRouteOwnership(tsConfigPath: string, rootDir: string): RouteOwnership {
  const project = new Project({ tsConfigFilePath: tsConfigPath, skipAddingFilesFromTsConfig: false });
  const ownership = new Map<string, Set<string>>();

  for (const file of project.getSourceFiles()) {
    if (file.isDeclarationFile()) continue;
    const path = relative(rootDir, file.getFilePath()).split('\\').join('/');

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (!expression.isKind(SyntaxKind.PropertyAccessExpression)) continue;
      if (!GOTO_METHODS.has(expression.getName())) continue;

      const first = call.getArguments()[0];
      if (first === undefined) continue;
      if (!first.isKind(SyntaxKind.StringLiteral) && !first.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
        continue;
      }

      const raw = first.getLiteralText();
      const route = normaliseRoute(raw);
      if (route === null) continue;

      const existing = ownership.get(path) ?? new Set<string>();
      existing.add(route);
      ownership.set(path, existing);
    }
  }

  return ownership;
}

/** `http://host/gyms?q=x` and `/gyms` both become `/gyms`. */
export function normaliseRoute(raw: string): string | null {
  if (raw === '') return null;
  try {
    const url = new URL(raw, 'http://placeholder');
    // about:, data: and blob: are not routes. Without this check
    // `about:blank` normalises to the pathname "blank" and is recorded as
    // though the test had visited a page called that.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const path = url.pathname;
    return path === '' ? '/' : path;
  } catch {
    return raw.startsWith('/') ? (raw.split('?')[0] ?? raw) : null;
  }
}

export interface CoverageAttempt {
  readonly file: string;
  readonly routes: readonly string[];
}

/** Fold attempt records into spec → routes. */
export function buildCoverage(attempts: readonly CoverageAttempt[]): RouteCoverage {
  const coverage = new Map<string, Set<string>>();

  for (const attempt of attempts) {
    if (attempt.routes.length === 0) continue;
    const existing = coverage.get(attempt.file) ?? new Set<string>();
    for (const route of attempt.routes) existing.add(route);
    coverage.set(attempt.file, existing);
  }

  return coverage;
}

export interface RouteSelection {
  /** spec → the routes that selected it. */
  readonly selected: ReadonlyMap<string, readonly string[]>;
  /** Routes owned by the changed files. */
  readonly routes: readonly string[];
  /** True when no changed file owns any route — route selection cannot help. */
  readonly noOwnership: boolean;
}

/**
 * Which specs visited a route owned by one of the changed files.
 *
 * Returns `noOwnership` rather than an empty selection when the diff touches
 * nothing route-bearing: "no spec matched" and "this method does not apply"
 * are different answers, and conflating them would silently skip everything.
 */
export function selectByRoute(
  changed: readonly string[],
  ownership: RouteOwnership,
  coverage: RouteCoverage,
): RouteSelection {
  const routes = new Set<string>();
  for (const file of changed) {
    for (const route of ownership.get(file) ?? []) routes.add(route);
  }

  if (routes.size === 0) {
    return { selected: new Map(), routes: [], noOwnership: true };
  }

  const selected = new Map<string, string[]>();
  for (const [spec, visited] of coverage) {
    const hits = [...visited].filter(route => routes.has(route));
    if (hits.length > 0) selected.set(spec, hits.sort());
  }

  return { selected, routes: [...routes].sort(), noOwnership: false };
}

/** Specs with no recorded coverage — they must never be silently dropped. */
export function specsWithoutCoverage(
  allSpecs: readonly string[],
  coverage: RouteCoverage,
): string[] {
  return allSpecs.filter(spec => !coverage.has(spec)).sort();
}
