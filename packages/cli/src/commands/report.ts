/**
 * `atest report` — merge shards, render the HTML report and the PR comment.
 *
 * Runs at the very end of a CI job that has usually already failed, so it must
 * NEVER fail the build itself. A report generator that exits non-zero converts
 * "three tests are broken" into "the tooling is broken", and the second one
 * gets triaged first. Every path here returns EXIT.OK except a usage mistake.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SqliteHistoryStore, ingestDirectory } from '@atest/core';
import { DEFAULT_ANALYZE_CONFIG, analyzeAll } from '@atest/flaky';
import {
  loadEvidence,
  loadRuns,
  mergeRuns,
  orderFailures,
  renderHtml,
  renderMarkdown,
  type FlakySummary,
  type ReportInput,
} from '@atest/report';

import { EXIT, type ExitCode } from '../exit.js';
import { style, warn } from '../ui/output.js';

export interface ReportFlags {
  readonly runs: string;
  readonly evidence: string;
  readonly db: string;
  readonly out?: string | undefined;
  /** Write the PR comment here; omitted means stdout. */
  readonly comment?: string | undefined;
  readonly reportUrl?: string | undefined;
  readonly json: boolean;
}

async function flakySummaries(flags: ReportFlags): Promise<FlakySummary[]> {
  // Best-effort. History is a nice-to-have on top of the run being reported;
  // a missing or locked database must not cost us the failure cards, which
  // are the part somebody is actually waiting for.
  try {
    const store = new SqliteHistoryStore(flags.db);
    await ingestDirectory(store, flags.runs);
    const report = await analyzeAll(store, DEFAULT_ANALYZE_CONFIG);
    await store.close();

    return report.flaky.map(v => ({
      title: v.title,
      project: v.project,
      score: v.score.score,
      class: v.classification.class,
      prescription: v.classification.prescription,
    }));
  } catch {
    return [];
  }
}

export async function report(flags: ReportFlags): Promise<ExitCode> {
  const [runs, evidence] = await Promise.all([loadRuns(flags.runs), loadEvidence(flags.evidence)]);

  const merged = mergeRuns(runs.items);
  if (merged === null) {
    // Not an error. A run with the reporter disabled, or a job cancelled
    // before any spec finished, legitimately produces no records.
    warn(`No run records under ${flags.runs} — nothing to report.`);
    return EXIT.OK;
  }

  const failures = orderFailures(evidence.items);
  const input: ReportInput = {
    run: merged,
    failures,
    flaky: await flakySummaries(flags),
    ...(flags.reportUrl === undefined ? {} : { reportUrl: flags.reportUrl }),
  };

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          run: { ...merged, attempts: undefined },
          failures: failures.map(f => ({
            id: f.id,
            kind: f.failure.kind,
            title: f.test.title,
            file: f.test.file,
            project: f.test.project,
          })),
          flaky: input.flaky,
          skipped: [...runs.skipped, ...evidence.skipped],
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  const markdown = renderMarkdown(input);
  if (flags.comment === undefined) process.stdout.write(markdown);
  else {
    await mkdir(dirname(flags.comment), { recursive: true });
    await writeFile(flags.comment, markdown, 'utf8');
  }

  if (flags.out !== undefined) {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, renderHtml(input), 'utf8');
  }

  // The summary goes to STDERR, never stdout. Without `--comment` the markdown
  // IS stdout, and `atest report --out r.html > comment.md` would otherwise
  // append this human-readable block to the file it just wrote — landing the
  // words "report / 3 tests · 1 failed" at the bottom of a PR comment.
  const note = (text: string): void => void process.stderr.write(`${text}\n`);
  note('');
  note(style.bold('report'));
  note(
    `  ${plural(merged.totals.tests, 'test')} · ${merged.totals.failed} failed · ` +
      `${plural(failures.length, 'evidence bundle')}` +
      (merged.shardsMerged > 1 ? ` · ${plural(merged.shardsMerged, 'shard')} merged` : ''),
  );
  if (flags.comment !== undefined) note(`  comment  ${flags.comment}`);
  if (flags.out !== undefined) note(`  html     ${flags.out}`);

  // Unusable inputs are reported, never swallowed: a shard whose artifact
  // failed to upload makes the totals wrong, and silently correct-looking
  // wrong numbers are the worst outcome available here.
  const skipped = [...runs.skipped, ...evidence.skipped];
  if (skipped.length > 0) {
    note('');
    warn(`${plural(skipped.length, 'file')} skipped — totals may be incomplete:`);
    for (const entry of skipped.slice(0, 5)) note(style.dim(`  ${entry.file} — ${entry.reason}`));
  }

  return EXIT.OK;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
