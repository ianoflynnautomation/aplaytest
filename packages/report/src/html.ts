/**
 * HTML report — a single self-contained file.
 *
 * Deliberately NOT a replacement for the Playwright HTML report. That one
 * already shows traces, screenshots and stacks, and does it better. This one
 * answers the question Playwright's cannot: *why* did these fail, and is it
 * one cause or twelve? So each card leads with intent and classification, and
 * the stack is the last thing on the page.
 *
 * Self-contained is a hard constraint, not a preference. The file is consumed
 * as a CI artifact — downloaded, unzipped, opened from file://, often on a
 * laptop with no network. A single CDN <script> makes it a blank page, and it
 * would be a blank page for the person debugging a failed release.
 */

import type { EvidenceBundle } from '@aplaytest/core';

import { formatArgs } from './args.js';
import { formatDuration, type MergedRun } from './merge.js';
import type { FlakySummary, ReportInput } from './markdown.js';

/**
 * Escape for HTML TEXT and double-quoted attributes.
 *
 * Every string on this page originates outside it: test titles, error
 * messages, ARIA snapshots scraped from the app under test. A title
 * containing `<img>` must render as text — not because a test author is an
 * attacker, but because the page silently breaking is indistinguishable from
 * the tool being wrong.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --panel: #f6f7f9; --border: #d8dce2; --fg: #14181f;
  --muted: #5b6472; --accent: #2563eb; --fail: #b42318; --warn: #b54708;
  --pass: #067647; --code: #eef1f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #2b323c; --fg: #e6edf3;
    --muted: #9198a1; --accent: #58a6ff; --fail: #ff7b72; --warn: #d29922;
    --pass: #3fb950; --code: #1c2128;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
.wrap { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2.25rem 0 .75rem; }
.sub { color: var(--muted); font-size: .875rem; margin-bottom: 1.5rem; }
.totals { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
.pill {
  border: 1px solid var(--border); border-radius: 999px; padding: .2rem .7rem;
  font-size: .8rem; background: var(--panel);
}
.pill.fail { color: var(--fail); border-color: currentColor; }
.pill.pass { color: var(--pass); border-color: currentColor; }
.pill.warn { color: var(--warn); border-color: currentColor; }
.card {
  border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
  margin-bottom: .75rem; overflow: hidden;
}
.card > summary {
  cursor: pointer; padding: .75rem 1rem; list-style: none;
  display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap;
}
.card > summary::-webkit-details-marker { display: none; }
.card > summary:hover { background: var(--code); }
.kind {
  font-size: .72rem; text-transform: uppercase; letter-spacing: .04em;
  color: var(--fail); font-weight: 600; white-space: nowrap;
}
.title { font-weight: 500; }
.where { color: var(--muted); font-size: .8rem; margin-left: auto; }
.body { padding: 0 1rem 1rem; }
.row { display: grid; grid-template-columns: 7.5rem 1fr; gap: .35rem .75rem; margin: .5rem 0; }
.label { color: var(--muted); font-size: .8rem; padding-top: .15rem; }
code, pre {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: .82rem;
}
code { background: var(--code); padding: .1rem .35rem; border-radius: 4px; }
pre {
  background: var(--code); padding: .7rem .85rem; border-radius: 6px;
  overflow-x: auto; margin: 0; max-height: 22rem;
}
table { border-collapse: collapse; width: 100%; font-size: .85rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 500; font-size: .78rem; }
tbody tr:last-child td { border-bottom: none; }
.scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.empty { color: var(--muted); font-style: italic; }
.arrow { color: var(--accent); }
footer { color: var(--muted); font-size: .78rem; margin-top: 3rem; }
`;

function intentBlock(bundle: EvidenceBundle): string {
  const step = bundle.intent.failingStep;
  if (step === null) return `<span class="empty">no instrumented step</span>`;
  const call = `${step.pageObject}.${step.method}(${formatArgs(step.args)})`;
  return `<code>${escapeHtml(call)}</code>`;
}

function candidatesBlock(bundle: EvidenceBundle): string {
  const candidates = bundle.page.candidates;
  if (candidates.length === 0) return '';

  // matchCount is -1 when nothing has resolved the candidate against a live
  // page — the reporter has no browser, so it records "not checked" rather
  // than asserting a uniqueness nobody measured. Rendering that sentinel as a
  // number prints "-1 matches — ambiguous" next to the CORRECT candidate,
  // telling the reader it is disqualified from healing when it is not.
  const items = candidates
    .slice(0, 5)
    .map(c => {
      const note =
        c.matchCount < 0
          ? `unverified · distance ${c.semanticDistance.toFixed(2)}`
          : c.matchCount === 1
            ? `unique · distance ${c.semanticDistance.toFixed(2)}`
            : `${c.matchCount} matches — ambiguous`;
      return `<div><code>${escapeHtml(c.expression)}</code> <span class="where">${escapeHtml(note)}</span></div>`;
    })
    .join('');
  return `<div class="row"><span class="label">candidates</span><div>${items}</div></div>
<div class="row"><span class="label"></span><div class="sub">Ranked by name distance. &ldquo;unverified&rdquo; means no browser
has resolved it yet &mdash; <code>aplaytest heal</code> checks uniqueness against the live page before proposing.</div></div>`;
}

function failureCard(bundle: EvidenceBundle): string {
  const file = bundle.test.file.split('/').pop() ?? bundle.test.file;
  const consoleErrors = bundle.console.errors.slice(0, 5);
  const failedRequests = bundle.network.failed.slice(0, 5);

  const parts: string[] = [];
  parts.push(`<div class="row"><span class="label">intent</span><div>${intentBlock(bundle)}</div></div>`);

  if (bundle.intent.selector !== null) {
    parts.push(
      `<div class="row"><span class="label">selector</span><div><code>${escapeHtml(bundle.intent.selector)}</code></div></div>`,
    );
  }
  parts.push(candidatesBlock(bundle));
  parts.push(
    `<div class="row"><span class="label">page</span><div><code>${escapeHtml(bundle.page.url)}</code></div></div>`,
  );

  if (consoleErrors.length > 0) {
    parts.push(
      `<div class="row"><span class="label">console</span><pre>${escapeHtml(consoleErrors.join('\n'))}</pre></div>`,
    );
  }
  if (failedRequests.length > 0) {
    const text = failedRequests
      .map(r => `${r.status ?? 'ERR'} ${r.method} ${r.url}`)
      .join('\n');
    parts.push(`<div class="row"><span class="label">network</span><pre>${escapeHtml(text)}</pre></div>`);
  }

  // Last, and only here: the raw message. It is the thing everyone already
  // has, so it does not get to be the headline.
  parts.push(
    `<div class="row"><span class="label">message</span><pre>${escapeHtml(bundle.failure.message)}</pre></div>`,
  );

  return `<details class="card">
  <summary>
    <span class="kind">${escapeHtml(bundle.failure.kind.replace(/_/g, ' '))}</span>
    <span class="title">${escapeHtml(bundle.test.title)}</span>
    <span class="where">${escapeHtml(file)}:${bundle.test.line} · ${escapeHtml(bundle.test.project)}</span>
  </summary>
  <div class="body">${parts.join('')}</div>
</details>`;
}

function flakyTable(flaky: readonly FlakySummary[]): string {
  if (flaky.length === 0) return '';
  const rows = flaky
    .map(
      f => `<tr>
      <td>${escapeHtml(f.title)}</td>
      <td>${escapeHtml(f.project)}</td>
      <td>${f.score.toFixed(2)}</td>
      <td>${escapeHtml(f.class)}</td>
      <td>${escapeHtml(f.prescription)}</td>
    </tr>`,
    )
    .join('');
  return `<h2>Flaky</h2>
<div class="scroll"><table>
  <thead><tr><th>test</th><th>project</th><th>score</th><th>cause</th><th>prescription</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
}

function healTable(input: ReportInput): string {
  const heals = (input.heals ?? []).filter(h => h.validated);
  if (heals.length === 0) return '';
  const rows = heals
    .map(
      h => `<tr>
      <td>${escapeHtml(h.title)}</td>
      <td><code>${escapeHtml(h.from)}</code> <span class="arrow">&rarr;</span> <code>${escapeHtml(h.to)}</code></td>
      <td>${(h.confidence * 100).toFixed(0)}%</td>
    </tr>`,
    )
    .join('');
  return `<h2>Suggested selector repairs</h2>
<div class="scroll"><table>
  <thead><tr><th>test</th><th>change</th><th>confidence</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="sub">Each was verified by re-running the test with the patch applied, and every
proposal is recorded in the heal ledger. Review before applying &mdash; a passing test with the
wrong selector is worse than a failing one.</p>`;
}

function totalsBar(run: MergedRun): string {
  const pills: string[] = [];
  if (run.totals.failed > 0) pills.push(`<span class="pill fail">${run.totals.failed} failed</span>`);
  pills.push(`<span class="pill pass">${run.totals.passed} passed</span>`);
  if (run.totals.flaky > 0) pills.push(`<span class="pill warn">${run.totals.flaky} flaky</span>`);
  if (run.totals.skipped > 0) pills.push(`<span class="pill">${run.totals.skipped} skipped</span>`);
  pills.push(`<span class="pill">${formatDuration(run.totals.durationMs)}</span>`);
  if (run.shardsMerged > 1) pills.push(`<span class="pill">${run.shardsMerged} shards</span>`);
  return `<div class="totals">${pills.join('')}</div>`;
}

export function renderHtml(input: ReportInput): string {
  const { run } = input;
  const meta = [
    `run ${escapeHtml(run.runId)}`,
    run.branch === null ? null : escapeHtml(run.branch),
    run.commit === null ? null : escapeHtml(run.commit.slice(0, 7)),
    escapeHtml(run.startedAt),
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');

  const failures =
    input.failures.length === 0
      ? '<p class="empty">No failures captured.</p>'
      : input.failures.map(failureCard).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aplaytest report — ${escapeHtml(run.runId)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <h1>Test run</h1>
  <div class="sub">${meta}</div>
  ${totalsBar(run)}
  <h2>Failures</h2>
  ${failures}
  ${flakyTable(input.flaky ?? [])}
  ${healTable(input)}
  <footer>
    Generated by atest. Every number on this page is measured from recorded attempts &mdash;
    no model was consulted to produce it.
  </footer>
</div>
</body>
</html>
`;
}
