/**
 * `aplaytest flaky …`
 *
 * Every command body here is thin on purpose: parse flags, call one engine
 * function, format the result. Logic that lives in a command cannot be tested
 * without a terminal and cannot be reached from the MCP server, which is
 * supposed to call the identical engine function.
 */

import { readFile, writeFile } from 'node:fs/promises';

import {
  DEFAULT_ANALYZE_CONFIG,
  DEFAULT_QUARANTINE_POLICY,
  analyzeAll,
  buildQuarantineEntry,
  evaluateQuarantinePolicy,
  quarantineCodemod,
  releaseCodemod,
  renderQuarantineComment,
  type FlakyVerdict,
} from '@aplaytest/flaky';
import { ATEST_VERSION, ingestDirectory } from '@aplaytest/core';

import { EXIT, PolicyError, UsageError, type ExitCode } from '../exit.js';
import { openHistoryStore, resolveHistoryUrl, storeWarnings } from '../store.js';
import { heading, line, renderDiff, style, table, warn } from '../ui/output.js';
import { DEFAULT_LEDGER_PATH, readLedger, removeEntry, upsertEntry, writeLedger } from '../ledger.js';

export interface FlakyFlags {
  readonly runs: string;
  /**
   * History target. `undefined` means "not stated" — resolveHistoryUrl then
   * falls back to $ATEST_HISTORY_URL and finally to :memory:. Defaulting it
   * here would make the environment variable unreachable.
   */
  readonly db: string | undefined;
  readonly ledger: string;
  readonly json: boolean;
  readonly ci: boolean;
  readonly dryRun: boolean;
  readonly test?: string | undefined;
  readonly file?: string | undefined;
  readonly project?: string | undefined;
  readonly reason?: string | undefined;
  readonly issue?: string | undefined;
  readonly expires?: string | undefined;
  readonly suiteSize?: string | undefined;
}

async function loadReport(flags: FlakyFlags) {
  const { store, description } = await openHistoryStore(resolveHistoryUrl(flags.db, process.env));
  // Ingesting before scoring is what makes `flaky report` work as one command
  // on a fresh CI runner: the shard artifacts land, get written to the store,
  // and are scored against everything already there — in that order.
  const ingest = await ingestDirectory(store, flags.runs);
  const report = await analyzeAll(store, DEFAULT_ANALYZE_CONFIG);
  const unreadable = storeWarnings(store);
  await store.close();
  return { ingest, report, description, unreadable };
}

async function loadOptionalReport(flags: FlakyFlags) {
  try {
    return (await loadReport(flags)).report;
  } catch {
    // Quarantine is valid without history: a test the user just watched flake
    // can still be tagged. A missing runs dir must not block that.
    return null;
  }
}

function parseNonNegativeNumber(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`${flag} must be a non-negative number`);
  }
  return parsed;
}

const verdictLabel = (v: FlakyVerdict): string =>
  v.flaky ? 'FLAKY' : v.score.insufficientData ? 'no data' : 'not flaky';

export async function flakyReport(flags: FlakyFlags): Promise<ExitCode> {
  const { ingest, report, description, unreadable } = await loadReport(flags);

  if (flags.json) {
    line(JSON.stringify(report, null, 2));
    return EXIT.OK;
  }

  line(
    style.dim(
      `${description} · ingested ${ingest.runsIngested} runs · ${ingest.attemptsIngested} attempts` +
        (ingest.skipped.length > 0 ? ` · ${ingest.skipped.length} skipped` : ''),
    ),
  );
  for (const skip of ingest.skipped) warn(`skipped ${skip.file}: ${skip.reason}`);
  for (const skip of unreadable) warn(`unreadable in the store: ${skip.name} — ${skip.reason}`);

  if (report.analyzed === 0) {
    line(`\nNo history under ${flags.runs}. Run a suite with the atest reporter first.`);
    return EXIT.OK;
  }

  heading(`Flake leaderboard — ${report.analyzed} (test, project) pairs`);
  table(
    [
      { header: 'score', align: 'right' },
      { header: 'n', align: 'right' },
      { header: 'verdict' },
      { header: 'class' },
      { header: 'test' },
    ],
    report.verdicts.map(v => [
      v.score.score.toFixed(2),
      String(v.score.rawN),
      verdictLabel(v),
      v.classification.class,
      v.title.length > 52 ? `${v.title.slice(0, 51)}…` : v.title,
    ]),
  );

  // Regressions are surfaced separately and first: a broken test above the
  // flake threshold is the thing you most need to see, and the thing a plain
  // "flaky tests" list would bury among genuine flakes.
  if (report.regressions.length > 0) {
    heading(`${report.regressions.length} look like genuine regressions, not flakes`);
    for (const v of report.regressions) {
      line(`  ${style.red(v.title)}  [${v.project}]`);
      for (const evidence of v.classification.evidence) line(style.dim(`    · ${evidence}`));
    }
  }

  for (const v of report.verdicts.filter(x => x.flaky)) {
    heading(`${v.title}  [${v.project}]`);
    line(`  class         ${v.classification.class} (${v.classification.confidence} confidence)`);
    line(`  prescription  ${v.classification.prescription}`);
    line(`  retry helps   ${v.classification.retryable ? 'yes' : 'no'}`);
    for (const evidence of v.classification.evidence) line(style.dim(`  evidence      · ${evidence}`));
    line(
      style.cyan(
        `  next          aplaytest flaky quarantine --test ${JSON.stringify(v.title)} --file ${v.file}`,
      ),
    );
  }

  return EXIT.OK;
}

export async function flakyQuarantine(flags: FlakyFlags): Promise<ExitCode> {
  if (flags.test === undefined || flags.file === undefined) {
    throw new UsageError('aplaytest flaky quarantine requires --test "<title>" and --file <path>');
  }

  const ledger = await readLedger(flags.ledger);
  const source = await readFile(flags.file, 'utf8').catch(() => null);
  if (source === null) throw new UsageError(`Cannot read ${flags.file}`);

  const report = await loadOptionalReport(flags);
  const verdict = report?.verdicts.find(v => v.title === flags.test);

  const entry = buildQuarantineEntry({
    title: flags.test,
    testId: verdict?.testId,
    project: flags.project,
    reason: flags.reason,
    flakeScore: verdict?.score.score,
    rootCause: verdict?.classification.class,
    issueUrl: flags.issue,
  });

  // The budget is checked BEFORE writing, not after: the point of a cap is to
  // stop the list growing, which means refusing the addition rather than
  // reporting it next time CI runs.
  const suiteSize = parseNonNegativeNumber(flags.suiteSize, report?.analyzed ?? 0, '--suite-size');
  const projected = evaluateQuarantinePolicy(
    upsertEntry(ledger, entry),
    suiteSize,
    DEFAULT_QUARANTINE_POLICY,
  );
  const budgetViolation = projected.violations.find(v => v.kind === 'budget-exceeded');
  if (budgetViolation !== undefined) {
    throw new PolicyError(budgetViolation.message);
  }

  const result = quarantineCodemod(source, {
    file: flags.file,
    testTitle: flags.test,
    comment: renderQuarantineComment(entry, ATEST_VERSION),
  });

  if (result.status !== 'applied') {
    line(`${style.yellow(result.status)} ${result.message}`);
    return result.status === 'already-tagged' ? EXIT.OK : EXIT.USAGE;
  }

  heading(`${flags.file}:${result.line ?? '?'}`);
  for (const diffLine of renderDiff(result.before ?? '', result.after ?? '')) line(diffLine);

  if (flags.dryRun) {
    line(`\n${style.dim('dry run — nothing written')}`);
    return EXIT.OK;
  }

  await writeFile(flags.file, result.after ?? '', 'utf8');
  await writeLedger(upsertEntry(ledger, entry), flags.ledger);

  line(`\n${style.green('quarantined')} until ${entry.expiresAt.slice(0, 10)}`);
  line(style.dim(`ledger: ${flags.ledger}`));
  return EXIT.OK;
}

export async function flakyRelease(flags: FlakyFlags): Promise<ExitCode> {
  if (flags.test === undefined || flags.file === undefined) {
    throw new UsageError('aplaytest flaky release requires --test "<title>" and --file <path>');
  }

  const source = await readFile(flags.file, 'utf8').catch(() => null);
  if (source === null) throw new UsageError(`Cannot read ${flags.file}`);

  const result = releaseCodemod(source, { file: flags.file, testTitle: flags.test });
  if (result.status !== 'applied') {
    line(`${style.yellow(result.status)} ${result.message}`);
    return EXIT.OK;
  }

  heading(`${flags.file}:${result.line ?? '?'}`);
  for (const diffLine of renderDiff(result.before ?? '', result.after ?? '')) line(diffLine);

  if (flags.dryRun) {
    line(`\n${style.dim('dry run — nothing written')}`);
    return EXIT.OK;
  }

  await writeFile(flags.file, result.after ?? '', 'utf8');
  const ledger = await readLedger(flags.ledger);
  const entry = ledger.find(e => e.title === flags.test);
  if (entry !== undefined) {
    await writeLedger(removeEntry(ledger, entry.testId, entry.project), flags.ledger);
  }

  line(`\n${style.green('released')} — verify it before trusting it:`);
  line(style.cyan(`  npx playwright test ${flags.file} --repeat-each 30`));
  return EXIT.OK;
}

export async function flakyExpire(flags: FlakyFlags): Promise<ExitCode> {
  const ledger = await readLedger(flags.ledger);
  const suiteSize = parseNonNegativeNumber(flags.suiteSize, 0, '--suite-size');
  const result = evaluateQuarantinePolicy(ledger, suiteSize, DEFAULT_QUARANTINE_POLICY);

  if (flags.json) {
    line(JSON.stringify(result, null, 2));
    return result.ok ? EXIT.OK : EXIT.POLICY_VIOLATION;
  }

  heading(`Quarantine — ${result.active} active, budget ${result.budget}`);

  if (ledger.length > 0) {
    table(
      [{ header: 'expires' }, { header: 'class' }, { header: 'test' }],
      [...ledger]
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
        .map(e => [e.expiresAt.slice(0, 10), e.rootCause, e.title.slice(0, 52)]),
    );
  } else {
    line(style.dim('  (none)'));
  }

  for (const entry of result.expiringSoon) {
    warn(`${entry.title} expires ${entry.expiresAt.slice(0, 10)}`);
  }

  if (result.ok) {
    line(`\n${style.green('ok')}`);
    return EXIT.OK;
  }

  for (const violation of result.violations) {
    line(`\n${style.red(violation.kind)} ${violation.message}`);
    for (const id of violation.testIds.slice(0, 10)) line(style.dim(`  · ${id}`));
  }
  line(
    style.cyan(
      '\nrelease it, extend it with a written justification, or delete the test:' +
        '\n  aplaytest flaky release --test "<title>" --file <path>',
    ),
  );
  return EXIT.POLICY_VIOLATION;
}

export const FLAKY_LEDGER_DEFAULT = DEFAULT_LEDGER_PATH;
