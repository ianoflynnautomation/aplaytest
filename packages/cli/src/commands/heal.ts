/**
 * `aplaytest heal` — propose selector heals from captured evidence.
 *
 * Proposes; it does not merge. The output is a reviewable patch plus the
 * record of the re-run that justifies it. `--apply` writes to the working
 * tree, and even then a human still reviews the diff in the normal way.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  DEFAULT_HEAL_OPTIONS,
  buildRecord,
  proposeHeal,
  readRecords,
  revertHeal,
  writeRecord,
  type HealProposal,
  type ProposeOptions,
} from '@aplaytest/heal';
import {
  ATEST_VERSION,
  formatFailingStep,
  loadRunBundles,
  type EvidenceBundle,
} from '@aplaytest/core';
import { BudgetGuard, createLlmClient, type LlmClient } from '@aplaytest/llm';
import { runRepairAgent } from '@aplaytest/agent';

import { EXIT, UsageError, type ExitCode } from '../exit.js';
import { heading, line, renderDiff, style, warn } from '../ui/output.js';

export interface HealFlags {
  readonly evidence: string;
  readonly run?: string | undefined;
  readonly constants?: string | undefined;
  readonly spec?: string | undefined;
  readonly config?: string | undefined;
  readonly project?: string | undefined;
  readonly cwd?: string | undefined;
  readonly validate?: string | undefined;
  readonly apply: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly noCollateral: boolean;
  readonly healLedger: string;
  readonly force: boolean;
  /** Force the deterministic tier even when a key is present. */
  readonly noLlm: boolean;
}

export { ATEST_VERSION };

async function loadBundles(evidenceDir: string, run: string | undefined): Promise<EvidenceBundle[]> {
  const { bundles, skipped } = await loadRunBundles(evidenceDir, run);
  for (const skip of skipped) warn(`${skip.file}: ${skip.reason}`);
  return [...bundles];
}

function rankWithRepairAgent(
  llm: LlmClient,
  budget: BudgetGuard,
  bundle: EvidenceBundle,
): NonNullable<ProposeOptions['rankCandidates']> {
  return async ({ candidates, missingTestId }) => {
    const outcome = await runRepairAgent(
      llm,
      {
        testTitle: bundle.test.title,
        intent: formatFailingStep(bundle.intent.failingStep),
        missingTestId,
        failureKind: bundle.failure.kind,
        expected: bundle.failure.expected,
        actual: bundle.failure.actual,
        ariaSnapshot: bundle.page.ariaSnapshot,
        candidates: candidates.map(candidate => ({
          value: candidate.value,
          expression: candidate.expression,
          semanticDistance: candidate.semanticDistance,
        })),
      },
      { budget },
    );

    const chosen = outcome.status === 'chose' ? outcome.choice.chosen : null;
    return {
      used: outcome.status !== 'unavailable',
      model: llm.modelFor('heal'),
      outcome: outcome.status,
      reasoning: 'choice' in outcome ? outcome.choice.reasoning : null,
      confidence: 'choice' in outcome ? outcome.choice.confidence : null,
      usd: 'usd' in outcome ? outcome.usd : 0,
      changedChoice: false,
      chosen,
      realBug: outcome.status === 'real-bug',
    };
  };
}

function renderProposal(proposal: HealProposal): void {
  heading(proposal.testTitle);

  if (proposal.status !== 'proposed') {
    const colour = proposal.status.startsWith('refused') ? style.yellow : style.red;
    line(`  ${colour(proposal.status)}  ${proposal.reason}`);
    return;
  }

  const chosen = proposal.chosen;
  const patch = proposal.patch;
  if (chosen === null || patch?.after === null || patch === null) return;

  line(`  ${style.dim('selector')}  ${proposal.intendedSelector ?? ''}`);
  line(`  ${style.dim('reason')}    ${proposal.reason}`);
  line();

  for (const diffLine of renderDiff(patch.before, patch.after)) line(diffLine);

  if (patch.touched.length > 1) {
    line();
    warn(
      `${patch.touched.length} constants share this literal and were all updated: ` +
        patch.touched.map(t => `${t.path} (line ${t.line})`).join(', '),
    );
  }

  line();
  line(`  ${style.dim('candidates considered')}`);
  for (const candidate of proposal.candidates.slice(0, 5)) {
    const mark = candidate.value === chosen.value ? style.green('→') : ' ';
    line(`  ${mark} ${candidate.semanticDistance.toFixed(2)}  ${candidate.expression}`);
  }

  if (proposal.tierOne !== null) {
    const t = proposal.tierOne;
    line();
    line(
      `  ${style.dim('tier 1')}      ${t.used ? t.model ?? 'model' : 'not used'} · ${t.outcome}` +
        (t.confidence === null ? '' : ` · confidence ${t.confidence.toFixed(2)}`) +
        (t.changedChoice ? style.yellow('  (changed the Tier-0 choice)') : ''),
    );
    if (t.reasoning !== null) line(style.dim(`              ${t.reasoning.slice(0, 160)}`));
  }

  if (proposal.validation !== null) {
    const v = proposal.validation;
    line();
    line(
      `  ${style.dim('validation')}  ${v.targetPassed}/${v.targetTotal} target · ` +
        `${v.collateralPassed} neighbouring tests still pass`,
    );
  }
}

export async function heal(flags: HealFlags): Promise<ExitCode> {
  let constantsText: string | undefined;
  if (flags.constants !== undefined) {
    const text = await readFile(flags.constants, 'utf8').catch(() => null);
    if (text === null) throw new UsageError(`Cannot read ${flags.constants}`);
    constantsText = text;
  }

  const bundles = await loadBundles(flags.evidence, flags.run);
  if (bundles.length === 0) {
    line(`No evidence under ${flags.evidence}. Run a suite with the atest reporter first.`);
    return EXIT.OK;
  }

  const validationRuns = Number.parseInt(
    flags.validate ?? String(DEFAULT_HEAL_OPTIONS.validationRuns),
    10,
  );

  // Tier 1 is optional and additive. Without a key the deterministic ranking
  // stands, which resolves the common rename cases on its own.
  const llm = createLlmClient({ disabled: flags.noLlm });
  const budget = new BudgetGuard();

  if (!llm.available) {
    line(style.dim('tier 0 only — no model configured; deterministic ranking stands'));
  }

  const proposals: HealProposal[] = [];
  for (const bundle of bundles) {
    proposals.push(
      await proposeHeal(bundle, {
        cwd: flags.cwd ?? process.cwd(),
        ...(flags.constants === undefined ? {} : { constantsFile: flags.constants }),
        ...(constantsText === undefined ? {} : { constantsText }),
        specFile: flags.spec ?? bundle.test.file,
        config: flags.config,
        project: flags.project,
        validationRuns,
        checkCollateral: !flags.noCollateral,
        // A dry run must never produce a record that reads as verified.
        skipValidation: flags.dryRun,
        rankCandidates: llm.available ? rankWithRepairAgent(llm, budget, bundle) : undefined,
      }),
    );
  }

  if (flags.json) {
    line(JSON.stringify(proposals, null, 2));
    return EXIT.OK;
  }

  for (const proposal of proposals) renderProposal(proposal);

  // Model usage is always disclosed inline. A reader must never have to wonder
  // whether a number came from a measurement or from a model.
  if (llm.available) line(`\n${style.dim(budget.summary())}`);

  const accepted = proposals.filter(p => p.status === 'proposed');
  heading(`${accepted.length}/${proposals.length} heal${accepted.length === 1 ? '' : 's'} proposed`);

  if (accepted.length === 0) return EXIT.OK;

  if (flags.dryRun) {
    line(style.dim('  dry run — nothing written, and nothing validated'));
    return EXIT.OK;
  }

  if (!flags.apply) {
    line(style.cyan('  review the diff above, then re-run with --apply to write it'));
    return EXIT.OK;
  }

  // Applied one at a time, each recorded before the next is considered.
  //
  // Batching them would compound patches against stale text: every proposal
  // was generated and validated against the file as it was, so applying a
  // second on top of the first would write a patch nothing ever ran.
  const first = accepted[0];
  if (first?.patch?.after === undefined || first.patch.after === null) return EXIT.OK;

  const targetFile = first.patch.file;
  const cwd = flags.cwd ?? process.cwd();
  const targetPath = isAbsolute(targetFile) ? targetFile : join(cwd, targetFile);
  await writeFile(targetPath, first.patch.after, 'utf8');

  const record = buildRecord(first, {
    project: flags.project ?? 'default',
    failureKind: 'locator_not_found',
    atestVersion: ATEST_VERSION,
    testFile: flags.spec ?? '',
  });

  if (record !== null) {
    const path = await writeRecord(record, flags.healLedger);
    line(style.green(`  applied to ${targetFile}`));
    line(style.dim(`  ledger:  ${path}`));
    line(style.cyan(`  undo:    aplaytest heal revert ${record.healId}`));
  } else {
    line(style.green(`  applied to ${targetFile}`));
  }

  if (accepted.length > 1) {
    line(
      style.dim(
        `\n  ${accepted.length - 1} further proposal(s) were validated against the file as it ` +
          'was. Re-run aplaytest heal to regenerate them against the patched file.',
      ),
    );
  }
  return EXIT.OK;
}

export async function healList(flags: HealFlags): Promise<ExitCode> {
  const records = await readRecords(flags.healLedger);

  if (flags.json) {
    line(JSON.stringify(records, null, 2));
    return EXIT.OK;
  }

  heading(`Heal ledger — ${records.length} record${records.length === 1 ? '' : 's'}`);
  if (records.length === 0) {
    line(style.dim(`  (none in ${flags.healLedger})`));
    return EXIT.OK;
  }

  for (const record of records) {
    const state = record.status === 'reverted' ? style.dim('reverted') : style.green('applied ');
    line(`  ${state}  ${record.healId}  ${record.patch.from} → ${record.patch.to}`);
    line(style.dim(`             ${record.test.title.slice(0, 60)}`));
    if (record.validation !== null) {
      line(
        style.dim(
          `             validated ${record.validation.targetPassed}/${record.validation.targetTotal}` +
            ` · ${record.patch.constants.length} constant(s) touched`,
        ),
      );
    }
  }
  return EXIT.OK;
}

export async function healRevert(flags: HealFlags, id: string | undefined): Promise<ExitCode> {
  if (id === undefined) throw new UsageError('aplaytest heal revert requires a heal id.');

  const result = await revertHeal(id, { dir: flags.healLedger, force: flags.force });

  if (result.status === 'reverted') {
    line(style.green(result.message));
    return EXIT.OK;
  }

  line(`${style.yellow(result.status)} ${result.message}`);
  return result.status === 'file-changed' ? EXIT.POLICY_VIOLATION : EXIT.USAGE;
}
