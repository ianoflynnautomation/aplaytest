/**
 * Drive `playwright test` as a child process and read structured results.
 *
 * Used by bisect (re-run under controlled perturbations) and by heal
 * validation (re-run with a candidate patch applied). Both need counts, not
 * evidence, so this uses Playwright's own JSON reporter rather than ours —
 * fewer moving parts, and it works against a consumer repo whether or not the
 * atest reporter is configured.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PlaywrightRunOptions {
  readonly cwd: string;
  readonly config?: string | undefined;
  readonly file?: string | undefined;
  /** Matched against the test title. Escaped for you — pass plain text. */
  readonly grepTitle?: string | undefined;
  readonly project?: string | undefined;
  readonly workers?: number | undefined;
  readonly repeatEach?: number | undefined;
  readonly maxFailures?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** Per-test outcomes, so a caller can measure ONE test inside a wider run. */
export interface SpecOutcome {
  readonly title: string;
  readonly file: string;
  readonly passed: number;
  readonly failed: number;
  /** Last failure message, when any result failed. Used to spot env errors. */
  readonly error: string | null;
}

export interface PlaywrightRunResult {
  /** Every test passed. */
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly flaky: number;
  readonly skipped: number;
  readonly durationMs: number;
  readonly exitCode: number;
  /** True when the run could not be parsed — treated as inconclusive, not as failure. */
  readonly inconclusive: boolean;
  readonly stderr: string;
  /**
   * Outcomes broken down per test.
   *
   * Essential whenever a run executes more tests than the one being measured:
   * aggregate stats would attribute a NEIGHBOUR's failures to the test under
   * examination, which is exactly how a co-scheduling probe manufactures a
   * false "test pollution" verdict.
   */
  readonly specs: readonly SpecOutcome[];
}

/** Playwright's `-g` takes a regular expression; titles are literal text. */
export function escapeForGrep(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface JsonSpec {
  title?: string;
  tests?: { results?: { status?: string; error?: { message?: string } }[] }[];
}

interface JsonSuite {
  file?: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonReport {
  suites?: JsonSuite[];
  stats?: {
    expected?: number;
    unexpected?: number;
    flaky?: number;
    skipped?: number;
    duration?: number;
  };
}

const RESULT_PASSED = 'passed';
const RESULT_FAILED = 'failed';
const RESULT_TIMED_OUT = 'timedOut';
const PLAYWRIGHT_JSON_OUTPUT = 'PLAYWRIGHT_JSON_OUTPUT_NAME';

function countResults(spec: JsonSpec): Pick<SpecOutcome, 'passed' | 'failed' | 'error'> {
  let passed = 0;
  let failed = 0;
  let error: string | null = null;
  for (const test of spec.tests ?? []) {
    for (const result of test.results ?? []) {
      if (result.status === RESULT_PASSED) passed += 1;
      else if (result.status === RESULT_FAILED || result.status === RESULT_TIMED_OUT) {
        failed += 1;
        error = result.error?.message ?? error;
      }
    }
  }
  return { passed, failed, error };
}

function collectSpecs(suites: readonly JsonSuite[] | undefined, file = ''): SpecOutcome[] {
  const out: SpecOutcome[] = [];

  for (const suite of suites ?? []) {
    const suiteFile = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      out.push({ title: spec.title ?? '', file: suiteFile, ...countResults(spec) });
    }
    out.push(...collectSpecs(suite.suites, suiteFile));
  }

  return out;
}

function buildArgs(options: PlaywrightRunOptions): string[] {
  const args = ['playwright', 'test'];

  if (options.config !== undefined) args.push('--config', options.config);
  if (options.file !== undefined) args.push(options.file);
  if (options.grepTitle !== undefined) args.push('-g', escapeForGrep(options.grepTitle));
  if (options.project !== undefined) args.push('--project', options.project);
  if (options.workers !== undefined) args.push(`--workers=${options.workers}`);
  if (options.repeatEach !== undefined) args.push(`--repeat-each=${options.repeatEach}`);
  if (options.maxFailures !== undefined) args.push(`--max-failures=${options.maxFailures}`);

  // Replaces the project's reporters for this invocation. Deliberate: bisect
  // and validation want counts, and inheriting a consumer's HTML or blob
  // reporter would write artifacts nobody asked for on every probe.
  args.push('--reporter=json');
  return args;
}

function isJsonReport(value: unknown): value is JsonReport {
  return typeof value === 'object' && value !== null;
}

function parseJsonReport(raw: string): JsonReport | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function inconclusiveResult(exitCode: number, stderr: string): PlaywrightRunResult {
  return {
    ok: false,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    exitCode,
    inconclusive: true,
    stderr,
    specs: [],
  };
}

export async function runPlaywright(options: PlaywrightRunOptions): Promise<PlaywrightRunResult> {
  const dir = await mkdtemp(join(tmpdir(), 'atest-run-'));
  const jsonPath = join(dir, 'report.json');

  try {
    const args = buildArgs(options);
    const result = await new Promise<{ code: number; stderr: string }>(resolve => {
      const child = spawn('npx', args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          [PLAYWRIGHT_JSON_OUTPUT]: jsonPath,
          // The reporter is not wanted during a probe: bisect runs the same
          // test dozens of times, and each run would otherwise write evidence
          // bundles that pollute the history the analysis is reading.
          ATEST: '0',
          FORCE_COLOR: '0',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const timeout =
        options.timeoutMs === undefined
          ? null
          : setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);

      child.on('close', code => {
        if (timeout !== null) clearTimeout(timeout);
        resolve({ code: code ?? 1, stderr });
      });
      child.on('error', error => {
        if (timeout !== null) clearTimeout(timeout);
        resolve({ code: 1, stderr: error.message });
      });
    });

    const raw = await readFile(jsonPath, 'utf8').catch(() => null);
    if (raw === null) {
      // No report means the run never got as far as executing tests — a config
      // error, a missing browser. That is INCONCLUSIVE, not a failing test;
      // counting it as a failure would make bisect blame the code under test
      // for a broken environment.
      return inconclusiveResult(result.code, result.stderr);
    }

    const report = parseJsonReport(raw);
    if (report === null) {
      return inconclusiveResult(result.code, `unparseable JSON report\n${result.stderr}`);
    }

    const stats = report.stats ?? {};
    const passed = stats.expected ?? 0;
    const failed = stats.unexpected ?? 0;
    const flaky = stats.flaky ?? 0;

    return {
      ok: failed === 0 && passed + flaky > 0,
      passed,
      failed,
      flaky,
      skipped: stats.skipped ?? 0,
      durationMs: stats.duration ?? 0,
      exitCode: result.code,
      // A run that executed nothing tells us nothing — usually a grep that
      // matched no test, which is a caller mistake worth surfacing.
      inconclusive: passed + failed + flaky === 0,
      stderr: result.stderr,
      specs: collectSpecs(report.suites),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
