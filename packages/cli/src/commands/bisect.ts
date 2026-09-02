/**
 * `aplaytest flaky bisect` — re-run a test under controlled perturbations.
 *
 * Slow by nature: it runs the test dozens of times on purpose. Progress is
 * streamed per probe rather than buffered, because a command that prints
 * nothing for four minutes looks hung, and the first thing a user does to a
 * hung command is kill it.
 */

import { DEFAULT_BISECT_OPTIONS, bisect, type BisectDimension } from '@aplaytest/flaky';

import { EXIT, UsageError, type ExitCode } from '../exit.js';
import { heading, line, style } from '../ui/output.js';
import type { FlakyFlags } from './flaky.js';

export interface BisectFlags extends FlakyFlags {
  readonly repeat?: string | undefined;
  readonly workers?: string | undefined;
  readonly config?: string | undefined;
  readonly cwd?: string | undefined;
}

function parseWorkerLevels(raw: string | undefined): number[] {
  if (raw === undefined) return [...DEFAULT_BISECT_OPTIONS.workerLevels];
  const levels = raw
    .split(',')
    .map(v => Number.parseInt(v.trim(), 10))
    .filter(n => Number.isInteger(n) && n > 0);
  if (levels.length === 0) throw new UsageError(`--workers "${raw}" contains no positive integers.`);
  return [...new Set(levels)].sort((a, b) => a - b);
}

export async function flakyBisect(flags: BisectFlags): Promise<ExitCode> {
  if (flags.test === undefined || flags.file === undefined) {
    throw new UsageError('aplaytest flaky bisect requires --test "<title>" and --file <path>');
  }

  const repeat = Number.parseInt(flags.repeat ?? String(DEFAULT_BISECT_OPTIONS.repeat), 10);
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new UsageError('--repeat must be a positive integer.');
  }

  const workerLevels = parseWorkerLevels(flags.workers);
  const dimensions: BisectDimension[] = [...DEFAULT_BISECT_OPTIONS.dimensions];

  heading(`Bisecting "${flags.test}"`);
  line(
    style.dim(
      `${flags.file} · ${repeat} repetitions per probe · workers ${workerLevels.join(', ')}`,
    ),
  );
  line(style.dim('this runs the test many times — expect it to take a while\n'));

  const result = await bisect({
    cwd: flags.cwd ?? process.cwd(),
    file: flags.file,
    title: flags.test,
    config: flags.config,
    project: flags.project,
    repeat,
    workerLevels,
    dimensions,
    onProbe: p => {
      const label = p.setting.padEnd(12);
      if (p.inconclusive) {
        line(`  ${label} ${style.yellow('inconclusive')} — the run produced no results`);
        return;
      }
      const outcome = `${p.passed}/${p.total} passed`;
      const colour = p.failed === 0 ? style.green : p.failed >= p.total / 2 ? style.red : style.yellow;
      line(`  ${label} ${colour(outcome)}`);
    },
  });

  const { verdict } = result;
  heading(`verdict: ${verdict.class} (${verdict.confidence} confidence)`);
  line(`  ${verdict.mechanism}`);
  line();
  for (const evidence of verdict.evidence) line(style.dim(`  · ${evidence}`));
  line();
  line(style.cyan(`  ${verdict.recommendation}`));

  if (flags.json) line(`\n${JSON.stringify(result, null, 2)}`);

  return EXIT.OK;
}
