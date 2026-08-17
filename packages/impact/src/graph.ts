/**
 * The static import graph.
 *
 * Answers "which specs could a change to this file possibly affect?" by
 * walking import edges backwards. Deterministic, explainable, and fast enough
 * to run on every pull request — which is why this, and not a model, decides
 * what runs.
 *
 * Path aliases (`@ui/*`, `@shared/*`) resolve through the project's own
 * tsconfig: ts-morph asks the TypeScript compiler, so whatever the suite
 * compiles against is what the graph sees.
 */

import { relative, resolve } from 'node:path';

import { Project, type SourceFile } from 'ts-morph';

export interface GraphOptions {
  readonly tsConfigPath: string;
  readonly rootDir: string;
  /** Files matching this are treated as test entry points. */
  readonly specPattern: RegExp;
}

export const DEFAULT_SPEC_PATTERN = /\.(spec|test)\.tsx?$/;

export interface ImportGraph {
  /** Repo-relative spec paths. */
  readonly specs: readonly string[];
  /** file → files that import it, directly. */
  readonly importers: ReadonlyMap<string, ReadonlySet<string>>;
  readonly fileCount: number;
}

function toRelative(rootDir: string, file: string): string {
  return relative(rootDir, file).split('\\').join('/');
}

export function buildGraph(options: GraphOptions): ImportGraph {
  const project = new Project({
    tsConfigFilePath: options.tsConfigPath,
    skipAddingFilesFromTsConfig: false,
  });

  const importers = new Map<string, Set<string>>();
  const specs: string[] = [];
  const sourceFiles = project.getSourceFiles().filter((f: SourceFile) => !f.isDeclarationFile());

  for (const file of sourceFiles) {
    const importer = toRelative(options.rootDir, file.getFilePath());
    if (options.specPattern.test(importer)) specs.push(importer);

    // getReferencedSourceFiles resolves through the compiler, so path aliases
    // and index files are handled the same way the suite itself resolves them.
    for (const referenced of file.getReferencedSourceFiles()) {
      const path = referenced.getFilePath();
      if (path.includes('node_modules')) continue;
      const target = toRelative(options.rootDir, path);
      const existing = importers.get(target) ?? new Set<string>();
      existing.add(importer);
      importers.set(target, existing);
    }
  }

  return { specs: specs.sort(), importers, fileCount: sourceFiles.length };
}

/**
 * Every spec reachable from the changed files by following imports backwards.
 *
 * Returns the path that selected each spec, not just the set. A selection
 * nobody can explain is a coverage hole waiting to happen, and "why did this
 * run?" has to be answerable without reading the implementation.
 */
export function affectedSpecs(
  graph: ImportGraph,
  changed: readonly string[],
): Map<string, string[]> {
  const affected = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue: { file: string; path: string[] }[] = changed.map(file => ({ file, path: [file] }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) continue;
    if (seen.has(next.file)) continue;
    seen.add(next.file);

    if (graph.specs.includes(next.file)) {
      affected.set(next.file, next.path);
      // A spec is a leaf: nothing imports it, so there is nowhere further to walk.
      continue;
    }

    for (const importer of graph.importers.get(next.file) ?? []) {
      if (!seen.has(importer)) queue.push({ file: importer, path: [...next.path, importer] });
    }
  }

  return affected;
}

export interface HubFile {
  readonly file: string;
  /** Share of all specs that reach this file. */
  readonly reach: number;
  readonly specCount: number;
}

/**
 * Files that nearly every spec depends on — barrels, composed fixtures,
 * shared config.
 *
 * These defeat static test selection, and saying so is the whole point of
 * detecting them. A suite that composes all feature fixtures into one `test`
 * export gives every spec a real dependency on every feature: change one
 * feature's page object and the graph correctly, uselessly, selects almost
 * everything. Reporting the hub explains WHY a selection did not narrow,
 * instead of leaving someone to conclude the tool is broken.
 */
/**
 * @param threshold  share of specs a file must reach to count as a hub
 * @param minSpecs   below this, "most specs" is not a meaningful statement —
 *                   in a two-spec project anything reaching one spec is 50%,
 *                   and calling that a hub would suppress selection entirely
 */
export function hubFiles(graph: ImportGraph, threshold = 0.8, minSpecs = 5): HubFile[] {
  const total = graph.specs.length;
  if (total < minSpecs) return [];

  const hubs: HubFile[] = [];
  for (const file of graph.importers.keys()) {
    if (graph.specs.includes(file)) continue;
    const reached = affectedSpecs(graph, [file]).size;
    const reach = reached / total;
    if (reach >= threshold) hubs.push({ file, reach, specCount: reached });
  }

  return hubs.sort((a, b) => b.reach - a.reach);
}

/**
 * Does this change reach specs ONLY by passing through a hub?
 *
 * If so the selection is not meaningfully narrower than the whole suite, and
 * the honest answer is to run everything rather than to present a number that
 * looks like discrimination and is not.
 */
export function reachesOnlyViaHubs(
  paths: ReadonlyMap<string, readonly string[]>,
  hubs: readonly HubFile[],
): boolean {
  if (paths.size === 0 || hubs.length === 0) return false;
  const hubPaths = new Set(hubs.map(h => h.file));
  return [...paths.values()].every(path => path.some(step => hubPaths.has(step)));
}

/**
 * Specs the graph cannot reason about.
 *
 * A spec that imports almost nothing — an accessibility sweep iterating routes
 * from an array, for instance — has no import edge to the page objects it
 * exercises. The graph will never select it, and quietly dropping it is
 * exactly the silent coverage loss that makes teams distrust test selection.
 * These are reported so they can be forced to always run.
 */
export function unattributableSpecs(graph: ImportGraph, minEdges = 2): string[] {
  const outgoing = new Map<string, number>();

  for (const [target, importerSet] of graph.importers) {
    for (const importer of importerSet) {
      if (!graph.specs.includes(importer)) continue;
      void target;
      outgoing.set(importer, (outgoing.get(importer) ?? 0) + 1);
    }
  }

  return graph.specs.filter(spec => (outgoing.get(spec) ?? 0) < minEdges).sort();
}

export function resolveTsConfig(rootDir: string, provided?: string): string {
  return provided === undefined ? resolve(rootDir, 'tsconfig.json') : resolve(provided);
}
