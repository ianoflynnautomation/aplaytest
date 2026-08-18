/**
 * `atest gate` — run the falsifiability gate against a test.
 *
 * Exposed as its own command rather than only as a phase of `atest agent
 * author`, because it is just as useful on a HUMAN-written test. "Does this
 * test actually assert anything?" is not a question that only applies to
 * generated code, and the answer is frequently uncomfortable.
 */

import { falsifiabilityGate, type MutantName } from '@atest/author';

import { EXIT, PolicyError, UsageError, type ExitCode } from '../exit.js';
import { heading, line, style } from '../ui/output.js';

export interface GateFlags {
  readonly spec?: string | undefined;
  readonly test?: string | undefined;
  readonly cwd?: string | undefined;
  readonly config?: string | undefined;
  readonly project?: string | undefined;
  readonly validate?: string | undefined;
  readonly apiPattern?: string | undefined;
  readonly only?: string | undefined;
  readonly json: boolean;
  readonly ci: boolean;
}

const MUTANT_NAMES: readonly MutantName[] = ['empty-page', 'unfiltered', 'http-500'];

export async function gate(flags: GateFlags): Promise<ExitCode> {
  if (flags.spec === undefined) throw new UsageError('atest gate requires --spec <file>.');
  if (flags.test === undefined) throw new UsageError('atest gate requires --test <title>.');

  let only: MutantName[] | undefined;
  if (flags.only !== undefined) {
    const requested = flags.only.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = requested.filter(r => !MUTANT_NAMES.includes(r as MutantName));
    if (unknown.length > 0) {
      throw new UsageError(
        `Unknown mutant(s): ${unknown.join(', ')}. Available: ${MUTANT_NAMES.join(', ')}.`,
      );
    }
    only = requested as MutantName[];
  }

  const result = await falsifiabilityGate({
    cwd: flags.cwd ?? process.cwd(),
    specFile: flags.spec,
    testTitle: flags.test,
    ...(flags.config === undefined ? {} : { config: flags.config }),
    ...(flags.project === undefined ? {} : { project: flags.project }),
    ...(flags.validate === undefined ? {} : { stabilityRuns: Number.parseInt(flags.validate, 10) }),
    ...(flags.apiPattern === undefined ? {} : { apiPattern: flags.apiPattern }),
    ...(only === undefined ? {} : { only }),
  });

  // Three outcomes, three exit codes. Collapsing "could not decide" into the
  // rejection code would tell CI a test asserts nothing when the truth is that
  // the mutant run never executed it.
  const code = result.passed
    ? EXIT.OK
    : result.undecidable
      ? EXIT.TEST_FAILURES
      : EXIT.POLICY_VIOLATION;

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return code;
  }

  heading(flags.test);
  for (const check of result.checks) {
    const mark = check.ok ? style.green('pass') : style.red('FAIL');
    line(`  ${mark}  ${check.name.padEnd(15)} ${check.detail}`);
  }

  if (result.mutants.length > 0) {
    line();
    line(style.dim('  mutants'));
    for (const mutant of result.mutants) {
      // "survived" is the interesting word, so it is the one that gets colour.
      const verdict = mutant.inconclusive
        ? style.red('UNREADABLE  ')
        : mutant.killed
          ? style.dim('killed      ')
          : style.yellow('SURVIVED    ');
      line(`  ${verdict} ${mutant.name.padEnd(12)} ${style.dim(mutant.detail ?? mutant.kills)}`);
    }
  }

  line();
  line(`  ${result.summary}`);

  if (result.undecidable) {
    line();
    line(style.dim('  This is not a verdict about the test. One or more mutant runs never'));
    line(style.dim('  executed it, so nothing was proved either way — look at the reason'));
    line(style.dim('  above, fix the environment, and re-run.'));
    return EXIT.TEST_FAILURES;
  }

  if (!result.passed) {
    line();
    line(style.dim('  A test that survives every data mutant would still pass if the'));
    line(style.dim('  feature it names stopped working. Assert on the data, not the chrome.'));
    // Exit 4, not 1: this is a policy verdict about test quality, which CI
    // should be able to distinguish from a test that simply failed.
    if (flags.ci) throw new PolicyError(result.summary);
    return EXIT.POLICY_VIOLATION;
  }

  return EXIT.OK;
}
