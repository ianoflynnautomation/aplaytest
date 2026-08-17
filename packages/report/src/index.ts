/**
 * @atest/report — shard merge, PR comment, and the self-contained HTML report.
 *
 * Wholly deterministic, like @atest/flaky: this package renders what was
 * measured and never asks a model to phrase it. The report is what people read
 * when a release is broken at 2am, and it has to be identical every time it is
 * generated from the same inputs.
 */

export { mergeRuns, formatDuration } from './merge.js';
export type { MergedRun } from './merge.js';

export { renderMarkdown, fence, cell, MAX_COMMENT_CHARS, COMMENT_MARKER } from './markdown.js';
export type { ReportInput, FlakySummary, HealSummary } from './markdown.js';

export { renderHtml, escapeHtml } from './html.js';

export { formatArgs } from './args.js';

export { loadRuns, loadEvidence, orderFailures } from './load.js';
export type { LoadResult } from './load.js';
