/**
 * The falsifiability-gate contract, same command CI runs.
 *
 * Two tests in examples/fixture-app:
 *   · MEANINGFUL must pass (exit 0) and be killed by `unfiltered`
 *   · VACUOUS must be rejected (exit 4) and must not die to a data mutant
 *
 * Run from the repo root after `npm run build`:
 *
 *   npm run test:gate
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(ROOT, 'examples/fixture-app');
const CLI = join(ROOT, 'packages/cli/dist/bin.js');

const MEANINGFUL = 'MEANINGFUL: filtering by county narrows the list to that county';
const VACUOUS = 'VACUOUS: asserts only that the page rendered';

interface MutantRow {
  readonly name: string;
  readonly class: string;
  readonly killed: boolean;
}

interface GatePayload {
  readonly passed: boolean;
  readonly undecidable: boolean;
  readonly summary: string;
  readonly mutants: readonly MutantRow[];
}

interface GateRun {
  readonly title: string;
  readonly code: number;
  readonly payload: GatePayload | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runGate(title: string): GateRun {
  const spawned = spawnSync(process.execPath, [CLI, 'gate', '--json', '--validate', '2', '--spec', 'tests/gyms.spec.ts', '--test', title], {
    cwd: FIXTURE,
    encoding: 'utf8',
  });

  let payload: GatePayload | null = null;
  try {
    payload = JSON.parse(spawned.stdout) as GatePayload;
  } catch {
    payload = null;
  }

  return {
    title,
    code: spawned.status ?? 1,
    payload,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
  };
}

function dump(run: GateRun): void {
  console.error(`--- ${run.title} ---`);
  console.error(`exit ${run.code}`);
  if (run.payload !== null) {
    console.error(JSON.stringify(run.payload, null, 2));
  } else {
    console.error('stdout was not JSON:');
    console.error(run.stdout);
  }
  if (run.stderr.trim() !== '') {
    console.error('stderr:');
    console.error(run.stderr);
  }
}

function fail(message: string, runs: readonly GateRun[]): never {
  console.error(message);
  for (const run of runs) dump(run);
  process.exit(1);
}

const meaningful = runGate(MEANINGFUL);
const vacuous = runGate(VACUOUS);
const runs = [meaningful, vacuous];

if (meaningful.code === 1 || meaningful.payload?.undecidable === true) {
  fail('The meaningful test was UNDECIDABLE — a mutant run never executed it. Fix the environment, not the test.', runs);
}
if (meaningful.code !== 0 || meaningful.payload === null) {
  fail(`A test that asserts on filtered data must pass the gate; got exit ${meaningful.code}.`, runs);
}
const unfiltered = meaningful.payload.mutants.find(row => row.name === 'unfiltered');
if (unfiltered === undefined || !unfiltered.killed) {
  fail('The unfiltered mutant did not kill a filtering test.', runs);
}

if (vacuous.code === 1 || vacuous.payload?.undecidable === true) {
  fail('The vacuous test was UNDECIDABLE — a mutant run failed to execute the test.', runs);
}
if (vacuous.code !== 4 || vacuous.payload === null) {
  fail(`A test asserting only page chrome must be rejected with exit 4; got ${vacuous.code}.`, runs);
}
if (vacuous.payload.mutants.some(row => row.class !== 'liveness' && row.killed)) {
  fail('A vacuous test was killed by a data mutant.', runs);
}

console.log('gate contract ok');
console.log(`  meaningful  exit ${meaningful.code}  ${meaningful.payload.summary}`);
console.log(`  vacuous     exit ${vacuous.code}  ${vacuous.payload.summary}`);
