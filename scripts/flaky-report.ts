/**
 * Ingest run records and print a flake leaderboard.
 *
 * A stand-in for `aplaytest flaky report` until the CLI package lands, and the
 * end-to-end check for the whole Phase 1 path: reporter JSON → history store →
 * score → features → classification.
 *
 *   node scripts/flaky-report.ts <runs-dir> [--db <path>]
 */

import { analyzeAll, type FlakyVerdict } from '@aplaytest/flaky';
import { SqliteHistoryStore, ingestDirectory } from '@aplaytest/core';

const [runsDir = 'examples/bjjeire-live/.atest/runs'] = process.argv.slice(2);
const dbIndex = process.argv.indexOf('--db');
const dbPath = dbIndex === -1 ? ':memory:' : (process.argv[dbIndex + 1] ?? ':memory:');

const store = new SqliteHistoryStore(dbPath);

const ingest = await ingestDirectory(store, runsDir);
console.log(
  `ingested ${ingest.runsIngested} runs · ${ingest.attemptsIngested} attempts` +
    (ingest.skipped.length > 0 ? ` · ${ingest.skipped.length} skipped` : ''),
);
for (const skip of ingest.skipped) {
  console.log(`  skipped ${skip.file}: ${skip.reason}`);
}

if (ingest.runsIngested === 0) {
  console.log(`\nNo run records under ${runsDir}. Run a suite with the atest reporter first.`);
  await store.close();
  process.exit(0);
}

const report = await analyzeAll(store);

const verdictLabel = (v: FlakyVerdict): string =>
  v.flaky ? 'FLAKY' : v.score.insufficientData ? 'no data' : 'not flaky';

console.log(
  `\nanalyzed ${report.analyzed} (test, project) pairs · threshold ${report.config.threshold}\n`,
);
console.log('score  n   verdict     class                  test');
console.log('─────  ──  ──────────  ─────────────────────  ─────────────────────────────────────');
for (const v of report.verdicts) {
  console.log(
    `${v.score.score.toFixed(2)}   ${String(v.score.rawN).padEnd(2)}  ` +
      `${verdictLabel(v).padEnd(10)}  ${v.classification.class.padEnd(21)}  ${v.title.slice(0, 45)}`,
  );
}

if (report.regressions.length > 0) {
  // Surfaced separately on purpose: a regression above the flake threshold is
  // the thing you most need to see, and the thing a plain "flaky tests" list
  // would bury among genuine flakes.
  console.log(`\n⚠  ${report.regressions.length} look like genuine regressions, not flakes:`);
  for (const v of report.regressions) {
    console.log(`   ${v.title}`);
    for (const line of v.classification.evidence) console.log(`     · ${line}`);
  }
}

for (const v of report.verdicts.filter(x => x.score.failures > 0)) {
  console.log(`\n${v.title}  [${v.project}]`);
  console.log(`  class         ${v.classification.class} (${v.classification.confidence} confidence)`);
  console.log(`  prescription  ${v.classification.prescription}`);
  console.log(`  retry helps   ${v.classification.retryable ? 'yes' : 'no'}`);
  console.log(
    `  measurements  ${v.score.failures}/${v.score.rawN} failed · ` +
      `transition density ${v.score.transitionDensity.toFixed(2)} · ` +
      `load delta ${v.features.workerLoadDelta.toFixed(2)}`,
  );
  for (const line of v.classification.evidence) console.log(`  evidence      · ${line}`);
}

await store.close();
