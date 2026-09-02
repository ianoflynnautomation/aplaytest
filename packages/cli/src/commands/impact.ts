/**
 * `aplaytest impact` — which specs a diff could affect.
 *
 * Prints the selection AND the edge that selected each spec. A selection
 * nobody can explain is a coverage hole waiting to happen, so "why did this
 * run?" is answerable from the output rather than from the source.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, resolve } from 'node:path';

import {
  DEFAULT_SELECTION_CONFIG,
  DEFAULT_SPEC_PATTERN,
  buildCoverage,
  buildGraph,
  resolveTsConfig,
  scanRouteOwnership,
  selectTests,

} from '@aplaytest/impact';
import { MemoryHistoryStore, ingestDirectory } from '@aplaytest/core';

import { EXIT, UsageError, type ExitCode } from '../exit.js';
import { heading, line, style, table } from '../ui/output.js';

const run = promisify(execFile);

export interface ImpactFlags {
  readonly cwd?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly tsconfig?: string | undefined;
  readonly changed?: string | undefined;
  readonly alwaysRun?: string | undefined;
  readonly runs?: string | undefined;
  readonly json: boolean;
}

async function changedFiles(flags: ImpactFlags, cwd: string): Promise<string[]> {
  if (flags.changed !== undefined) {
    return flags.changed.split(',').map(f => f.trim()).filter(Boolean);
  }

  const from = flags.from ?? 'origin/main';
  const to = flags.to ?? 'HEAD';

  try {
    const { stdout } = await run('git', ['diff', '--name-only', `${from}...${to}`], { cwd });
    const files = stdout.split('\n').map(f => f.trim()).filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // Fall through: an unknown ref is a usage problem, not a crash.
  }

  const { stdout } = await run('git', ['diff', '--name-only', 'HEAD'], { cwd }).catch(() => ({
    stdout: '',
  }));
  return stdout.split('\n').map(f => f.trim()).filter(Boolean);
}

export async function impact(flags: ImpactFlags): Promise<ExitCode> {
  const cwd = resolve(flags.cwd ?? process.cwd());
  const tsConfigPath = resolveTsConfig(cwd, flags.tsconfig);

  const changed = await changedFiles(flags, cwd);
  if (changed.length === 0) {
    line('No changed files. Nothing to select.');
    return EXIT.OK;
  }

  const graph = buildGraph({ tsConfigPath, rootDir: cwd, specPattern: DEFAULT_SPEC_PATTERN });
  if (graph.specs.length === 0) {
    throw new UsageError(
      `No spec files found via ${tsConfigPath}. Point --tsconfig at the test project.`,
    );
  }

  // Route coverage, when history exists. This is what narrows past a shared
  // fixture barrel; without it the graph can only report that everything
  // depends on everything.
  const runsDir = flags.runs ?? '.atest/runs';
  const store = new MemoryHistoryStore();
  const ingested = await ingestDirectory(store, runsDir);
  const attempts = await store.attempts();
  await store.close();

  const routeInputs =
    ingested.runsIngested > 0
      ? {
          ownership: scanRouteOwnership(tsConfigPath, cwd),
          // Playwright records absolute paths; the graph is repo-relative.
          // Mixing the two silently matches nothing, which reads as "no spec
          // has coverage" and selects everything — while also double-counting,
          // since the absolute keys are added on top.
          coverage: buildCoverage(
            attempts.map(a => ({
              file: relative(cwd, a.file).split('\\').join('/'),
              routes: [...a.routes],
            })),
          ),
        }
      : undefined;

  const selection = selectTests(graph, changed, {
    ...DEFAULT_SELECTION_CONFIG,
    alwaysRun:
      flags.alwaysRun === undefined
        ? DEFAULT_SELECTION_CONFIG.alwaysRun
        : flags.alwaysRun.split(',').map(p => p.trim()).filter(Boolean),
  }, routeInputs);

  if (flags.json) {
    line(JSON.stringify(selection, null, 2));
    return EXIT.OK;
  }

  if (routeInputs === undefined) {
    line(
      style.yellow('no route coverage') +
        style.dim(
          ` — no run history under ${runsDir}. Falling back to the import graph, which cannot\n` +
            '  narrow past a shared fixture barrel. Run the suite once with the atest reporter.',
        ),
    );
  } else {
    line(
      style.dim(
        `route coverage from ${ingested.runsIngested} run(s) · ` +
          `${routeInputs.coverage.size} spec(s) observed`,
      ),
    );
  }

  heading(`${changed.length} changed file${changed.length === 1 ? '' : 's'}`);
  for (const file of changed.slice(0, 12)) line(style.dim(`  ${file}`));
  if (changed.length > 12) line(style.dim(`  … and ${changed.length - 12} more`));

  if (selection.mode === 'full') {
    heading('running the full suite');
    line(`  ${selection.fullSuiteReason ?? ''}`);
    line(style.dim(`  ${selection.totalSpecs} specs`));

    if (selection.hubs.length > 0) {
      heading('why it could not narrow');
      table(
        [{ header: 'reach', align: 'right' }, { header: 'file every spec depends on' }],
        selection.hubs
          .slice(0, 5)
          .map(h => [`${(h.reach * 100).toFixed(0)}%`, h.file]),
      );
      line();
      line(
        style.dim(
          '  A composed fixture barrel gives every spec a real dependency on every feature,\n' +
            '  so changing one feature legitimately reaches almost all of them. This is a\n' +
            '  property of the architecture, not a limit of the diff — runtime coverage\n' +
            '  (which routes each test actually visits) is what narrows past it.',
        ),
      );
    }
    return EXIT.OK;
  }

  const share = ((selection.selected.length / selection.totalSpecs) * 100).toFixed(0);
  heading(`${selection.selected.length}/${selection.totalSpecs} specs selected (${share}%)`);

  table(
    [{ header: 'spec' }, { header: 'why' }, { header: 'via' }],
    selection.reasons.map(r => [
      r.spec.length > 52 ? `…${r.spec.slice(-51)}` : r.spec,
      r.reason,
      // `via` means different things per reason: the routes that matched, or
      // the import one step before the spec. Rendering both as "the second to
      // last element" left the column blank for a single route.
      r.reason === 'visited-route'
        ? r.via.join(', ')
        : r.via.length > 1
          ? (r.via[r.via.length - 2] ?? '')
          : '',
    ]),
  );

  // Only report the specs actually included for this reason — listing every
  // structurally-unattributable spec regardless would contradict the table
  // directly above it.
  const unattributable = selection.reasons
    .filter(r => r.reason === 'unattributable' || r.reason === 'no-coverage')
    .map(r => r.spec);
  if (unattributable.length > 0) {
    heading(`${unattributable.length} spec(s) with nothing to reason about — always run`);
    line(
      style.dim(
        '  Either they import too little to attribute, or they have no recorded coverage yet.\n' +
          '  Never dropped: silently losing them is the failure mode that makes teams stop\n' +
          '  trusting test selection.',
      ),
    );
    for (const spec of unattributable.slice(0, 8)) line(style.dim(`  ${spec}`));
  }

  line();
  line(style.cyan(`  npx playwright test ${selection.selected.slice(0, 3).join(' ')}${selection.selected.length > 3 ? ' …' : ''}`));
  return EXIT.OK;
}
