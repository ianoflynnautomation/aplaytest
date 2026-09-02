/**
 * Validation: Playwright decides, not the score.
 *
 * A candidate's score orders the queue. Whether a heal is ACCEPTED is settled
 * by re-running the failing test with the patch applied — N times, plus the
 * rest of the spec file. Confidence never authorises a change.
 *
 * The collateral check is the one that catches the seductive-but-wrong heal.
 * Retargeting a constant to a container element can make one assertion pass
 * while quietly breaking the other nine tests that read the same constant —
 * and a patch that passes its own test while breaking its neighbours is
 * exactly what an unattended healing loop would merrily commit.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

import { runPlaywright } from '@atest/runner-playwright';

export type ValidationStatus =
  | 'validated'
  | 'target-still-failing'
  | 'collateral-damage'
  | 'inconclusive';

export interface ValidationRecord {
  readonly status: ValidationStatus;
  readonly runs: number;
  readonly targetPassed: number;
  readonly targetTotal: number;
  readonly collateralPassed: number;
  /** Tests that passed BEFORE the patch and fail after — the ones that matter. */
  readonly collateralRegressed: readonly string[];
  /** Tests already failing before the patch; not the patch's fault. */
  readonly preexistingFailures: readonly string[];
  readonly message: string;
}

export interface ValidateOptions {
  readonly cwd: string;
  /** Spec file containing the failing test. */
  readonly specFile: string;
  readonly testTitle: string;
  /** File the patch rewrites (constants, page object, or spec). */
  readonly patchFile: string;
  readonly patchedText: string;
  readonly config?: string | undefined;
  readonly project?: string | undefined;
  readonly runs: number;
  readonly checkCollateral: boolean;
  readonly timeoutMs?: number | undefined;
}

const BACKUP_SUFFIX = '.atest-backup';

/**
 * Apply the patch, run, restore — always.
 *
 * The original is moved aside rather than held in memory so that a crash
 * mid-validation leaves a recoverable file on disk instead of a half-healed
 * repository. Restoration runs in `finally`, and the backup is only removed
 * once the original is definitely back.
 */
export async function validateHeal(options: ValidateOptions): Promise<ValidationRecord> {
  const backupPath = `${options.patchFile}${BACKUP_SUFFIX}`;
  const original = await readFile(options.patchFile, 'utf8');

  // BASELINE FIRST, before the patch exists.
  //
  // Without it, any test already failing in this file — for reasons that have
  // nothing to do with the selector — reads as damage the patch caused, and no
  // heal in that file could ever be proposed. Only tests that PASSED before
  // and fail after are the patch's doing. The cost is one extra run of the
  // file, which is the honest price of not blaming a patch for what it did
  // not break.
  const baselineFailures = new Set<string>();
  if (options.checkCollateral) {
    const baseline = await runPlaywright({
      cwd: options.cwd,
      config: options.config,
      file: options.specFile,
      project: options.project,
      timeoutMs: options.timeoutMs,
    });
    for (const spec of baseline.specs) {
      if (spec.failed > 0) baselineFailures.add(spec.title);
    }
  }

  await writeFile(backupPath, original, 'utf8');
  await writeFile(options.patchFile, options.patchedText, 'utf8');

  try {
    const target = await runPlaywright({
      cwd: options.cwd,
      config: options.config,
      file: options.specFile,
      grepTitle: options.testTitle,
      project: options.project,
      repeatEach: options.runs,
      timeoutMs: options.timeoutMs,
    });

    const targetSpecs = target.specs.filter(s => s.title === options.testTitle);
    const targetPassed = targetSpecs.reduce((sum, s) => sum + s.passed, 0);
    const targetFailed = targetSpecs.reduce((sum, s) => sum + s.failed, 0);
    const targetTotal = targetPassed + targetFailed;

    if (target.inconclusive || targetTotal === 0) {
      return {
        status: 'inconclusive',
        runs: options.runs,
        targetPassed: 0,
        targetTotal: 0,
        collateralPassed: 0,
        collateralRegressed: [],
        preexistingFailures: [...baselineFailures],
        message:
          'The target test did not run under the patch — check the title, file and project. ' +
          'An unverified patch is not a heal.',
      };
    }

    // Must pass EVERY time. One flake here means the heal is unproven, not
    // "mostly working" — and shipping an unproven heal is how a suite starts
    // lying about what it tests.
    if (targetPassed !== targetTotal) {
      return {
        status: 'target-still-failing',
        runs: options.runs,
        targetPassed,
        targetTotal,
        collateralPassed: 0,
        collateralRegressed: [],
        preexistingFailures: [...baselineFailures],
        message: `The patched test passed ${targetPassed}/${targetTotal} times. A heal must pass every time.`,
      };
    }

    if (!options.checkCollateral) {
      return {
        status: 'validated',
        runs: options.runs,
        targetPassed,
        targetTotal,
        collateralPassed: 0,
        collateralRegressed: [],
        preexistingFailures: [],
        message: `Target passed ${targetPassed}/${targetTotal}. Collateral check skipped.`,
      };
    }

    const whole = await runPlaywright({
      cwd: options.cwd,
      config: options.config,
      file: options.specFile,
      project: options.project,
      timeoutMs: options.timeoutMs,
    });

    const others = whole.specs.filter(s => s.title !== options.testTitle);
    const collateralPassed = others.reduce((sum, s) => sum + s.passed, 0);
    // Only NEW failures are the patch's doing.
    const regressed = others
      .filter(s => s.failed > 0 && !baselineFailures.has(s.title))
      .map(s => s.title);
    const preexisting = others.filter(s => baselineFailures.has(s.title)).map(s => s.title);

    if (regressed.length > 0) {
      return {
        status: 'collateral-damage',
        runs: options.runs,
        targetPassed,
        targetTotal,
        collateralPassed,
        collateralRegressed: regressed,
        preexistingFailures: preexisting,
        message:
          `The patch fixes its own test but breaks ${regressed.length} that passed before it: ` +
          `${regressed.join(', ')}. Rejected.`,
      };
    }

    return {
      status: 'validated',
      runs: options.runs,
      targetPassed,
      targetTotal,
      collateralPassed,
      collateralRegressed: [],
      preexistingFailures: preexisting,
      message:
        `Target passed ${targetPassed}/${targetTotal}; ${collateralPassed} neighbouring test ` +
        `results unchanged` +
        (preexisting.length > 0
          ? ` (${preexisting.length} were already failing before the patch and still are)`
          : ''),
    };
  } finally {
    await writeFile(options.patchFile, original, 'utf8').catch(async () => {
      // Writing back failed — fall back to moving the backup into place rather
      // than leaving the repository patched.
      await rename(backupPath, options.patchFile).catch(() => undefined);
    });
    await unlink(backupPath).catch(() => undefined);
  }
}
