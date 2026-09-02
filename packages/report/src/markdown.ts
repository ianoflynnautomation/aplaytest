/**
 * Markdown renderer — the PR comment.
 *
 * This is the surface most people will ever see of atest, so it is held to a
 * stricter rule than the HTML report: SAY LESS. A comment nobody reads is
 * worse than no comment, and a comment that reprints the Playwright output
 * they already have is exactly that.
 *
 * Three bounds, all of them defensive:
 *   · GitHub hard-truncates a comment at 65536 characters. Truncation mid-
 *     table produces a broken render, so we cut at a section boundary and say
 *     what was cut.
 *   · Failure text is untrusted. An error message containing ``` would escape
 *     a fenced block and let the remainder of the message render as markup.
 *   · Nothing here calls a model. The comment must post during a provider
 *     outage.
 */

import type { EvidenceBundle } from '@aplaytest/core';

import { formatArgs } from './args.js';
import { formatDuration, type MergedRun } from './merge.js';

/** GitHub's limit is 65536; leave room for the surrounding template. */
export const MAX_COMMENT_CHARS = 60_000;

/** Marker so CI can update its previous comment instead of posting a new one. */
export const COMMENT_MARKER = '<!-- atest-report -->';

export interface FlakySummary {
  readonly title: string;
  readonly project: string;
  readonly score: number;
  readonly class: string;
  readonly prescription: string;
}

export interface HealSummary {
  readonly title: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly confidence: number;
  readonly validated: boolean;
}

export interface ReportInput {
  readonly run: MergedRun;
  readonly failures: readonly EvidenceBundle[];
  readonly flaky?: readonly FlakySummary[] | undefined;
  readonly heals?: readonly HealSummary[] | undefined;
  readonly reportUrl?: string | undefined;
}

/**
 * Wrap untrusted text in a fence long enough to contain it.
 *
 * An error message that itself contains ``` — a spec asserting on markdown, a
 * snapshot of a code block — would otherwise close the fence early and let the
 * rest of the message render as markup.
 */
export function fence(content: string, lang = ''): string {
  const longest = [...content.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${content}\n${ticks}`;
}

/** Escape the characters that would break out of a markdown TABLE CELL. */
export function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function verdictLine(run: MergedRun): string {
  const { totals } = run;
  if (totals.failed > 0) {
    return `**${totals.failed} failed**, ${totals.passed} passed`;
  }
  if (totals.flaky > 0) {
    return `**All green** — ${totals.flaky} passed on retry`;
  }
  return `**All ${totals.passed} passed**`;
}

function intentOf(bundle: EvidenceBundle): string {
  const step = bundle.intent.failingStep;
  if (step !== null) {
    return `${step.pageObject}.${step.method}(${truncate(formatArgs(step.args), 60)})`;
  }
  // No bound page object — a raw locator in the spec. Falling back to the test
  // title prints it twice in adjacent columns, which reads as a rendering bug
  // and wastes the one column that was meant to add information.
  if (bundle.intent.selector !== null) return truncate(bundle.intent.selector, 60);
  return '—';
}

/**
 * Render failures, grouped by kind, within a character budget.
 *
 * The budget is enforced GROUP BY GROUP rather than by dropping the section.
 * Dropping it whole is what the obvious implementation does, and on a run with
 * four thousand failures it produced a 153-character comment reading
 * "1 section(s) omitted" — the single most important section discarded
 * precisely when there was most to say. Partial beats absent: the largest
 * groups are also the likeliest to share one cause, so the ones that fit are
 * the ones worth having.
 */
function failuresSection(failures: readonly EvidenceBundle[], budget: number): string[] {
  if (failures.length === 0) return [];

  // Grouping by kind is the whole point: ten failures sharing one kind are
  // usually one cause, and a flat list hides that.
  const byKind = new Map<string, EvidenceBundle[]>();
  for (const bundle of failures) {
    const kind = bundle.failure.kind;
    byKind.set(kind, [...(byKind.get(kind) ?? []), bundle]);
  }

  const header = ['### Failures', ''];
  const lines = [...header];
  let used = header.join('\n').length;

  const ordered = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length);
  let shownGroups = 0;
  let shownFailures = 0;

  for (const [kind, bundles] of ordered) {
    const group = [`**${kind.replace(/_/g, ' ')}** · ${bundles.length}`, '', '| test | intent | where |', '| --- | --- | --- |'];
    for (const bundle of bundles.slice(0, 10)) {
      const where = `${bundle.test.file.split('/').pop() ?? ''}:${bundle.test.line}`;
      group.push(
        `| ${cell(truncate(bundle.test.title, 70))} | \`${cell(intentOf(bundle))}\` | ${cell(where)} |`,
      );
    }
    if (bundles.length > 10) group.push(`| _+${bundles.length - 10} more_ | | |`);
    group.push('');

    const size = group.join('\n').length + 1;
    // Reserve room for the "not shown" footer so it can always be appended.
    if (used + size > budget - 120) break;

    lines.push(...group);
    used += size;
    shownGroups += 1;
    shownFailures += bundles.length;
  }

  const hiddenGroups = ordered.length - shownGroups;
  if (hiddenGroups > 0) {
    const hiddenFailures = failures.length - shownFailures;
    lines.push(
      `_${hiddenFailures} further failure(s) across ${hiddenGroups} more kind(s) not shown — see the full report._`,
      '',
    );
  }

  return lines;
}

function healsSection(heals: readonly HealSummary[]): string[] {
  if (heals.length === 0) return [];

  // Unvalidated proposals are deliberately not shown. A suggestion that has
  // not been re-run against the app is a guess, and a guess in a PR comment
  // gets applied by someone who trusts the tool.
  const validated = heals.filter(h => h.validated);
  if (validated.length === 0) return [];

  const lines = ['### Suggested selector repairs', ''];
  lines.push('| test | change | confidence |');
  lines.push('| --- | --- | --- |');
  for (const heal of validated.slice(0, 10)) {
    lines.push(
      `| ${cell(truncate(heal.title, 60))} | \`${cell(heal.from)}\` → \`${cell(heal.to)}\` | ${(heal.confidence * 100).toFixed(0)}% |`,
    );
  }
  lines.push('');
  lines.push(
    '_Each was verified by re-running the test with the patch applied. Review before applying — a passing test with the wrong selector is worse than a failing one._',
  );
  lines.push('');
  return lines;
}

function flakySection(flaky: readonly FlakySummary[]): string[] {
  if (flaky.length === 0) return [];

  const lines = ['### Flaky', ''];
  lines.push('| test | score | cause | do |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of flaky.slice(0, 10)) {
    lines.push(
      `| ${cell(truncate(entry.title, 60))} | ${entry.score.toFixed(2)} | ${cell(entry.class)} | ${cell(entry.prescription)} |`,
    );
  }
  if (flaky.length > 10) lines.push(`| _+${flaky.length - 10} more_ | | | |`);
  lines.push('');
  return lines;
}

export function renderMarkdown(input: ReportInput): string {
  const { run } = input;

  const head = [
    COMMENT_MARKER,
    `## ${verdictLine(run)}`,
    '',
    [
      `${run.totals.tests} tests`,
      `${formatDuration(run.totals.durationMs)}`,
      run.shardsMerged > 1 ? `${run.shardsMerged} shards` : null,
      run.totals.flaky > 0 ? `${run.totals.flaky} flaky` : null,
      run.totals.skipped > 0 ? `${run.totals.skipped} skipped` : null,
    ]
      .filter((p): p is string => p !== null)
      .join(' · '),
    '',
  ];

  const foot: string[] = [];
  if (input.reportUrl !== undefined) foot.push(`[Full report](${input.reportUrl})`);
  foot.push(`<sub>atest · run \`${run.runId}\`${run.commit === null ? '' : ` · ${run.commit.slice(0, 7)}`}</sub>`);

  let out = head.join('\n');
  const tail = `\n${foot.join('\n')}\n`;

  // Failures get the bulk of the budget and truncate internally; the two
  // advisory sections take what is left. Ordered by what a reviewer acts on
  // first — failures block the merge, flake is a background concern, heals
  // are optional suggestions.
  const available = MAX_COMMENT_CHARS - out.length - tail.length;
  const sections = [
    failuresSection(input.failures, Math.floor(available * 0.75)),
    input.flaky === undefined ? [] : flakySection(input.flaky),
    input.heals === undefined ? [] : healsSection(input.heals),
  ];

  let dropped = 0;
  for (const section of sections) {
    if (section.length === 0) continue;
    const text = `${section.join('\n')}\n`;
    // Section boundaries only: cutting mid-table renders as broken markup.
    if (out.length + text.length + tail.length > MAX_COMMENT_CHARS) {
      dropped += 1;
      continue;
    }
    out += text;
  }

  if (dropped > 0) {
    out += `\n_${dropped} advisory section(s) omitted — comment size limit. See the full report._\n`;
  }

  return out + tail;
}
