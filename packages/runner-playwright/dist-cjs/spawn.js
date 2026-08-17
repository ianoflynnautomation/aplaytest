"use strict";
/**
 * Drive `playwright test` as a child process and read structured results.
 *
 * Used by bisect (re-run under controlled perturbations) and by heal
 * validation (re-run with a candidate patch applied). Both need counts, not
 * evidence, so this uses Playwright's own JSON reporter rather than ours —
 * fewer moving parts, and it works against a consumer repo whether or not the
 * atest reporter is configured.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeForGrep = escapeForGrep;
exports.runPlaywright = runPlaywright;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
/** Playwright's `-g` takes a regular expression; titles are literal text. */
function escapeForGrep(title) {
    return title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Walk the (recursively nested) suite tree and total each spec's results. */
function collectSpecs(suites, file = '') {
    const out = [];
    for (const suite of suites ?? []) {
        const suiteFile = suite.file ?? file;
        for (const spec of suite.specs ?? []) {
            let passed = 0;
            let failed = 0;
            for (const test of spec.tests ?? []) {
                for (const result of test.results ?? []) {
                    if (result.status === 'passed')
                        passed += 1;
                    else if (result.status === 'failed' || result.status === 'timedOut')
                        failed += 1;
                }
            }
            out.push({ title: spec.title ?? '', file: suiteFile, passed, failed });
        }
        out.push(...collectSpecs(suite.suites, suiteFile));
    }
    return out;
}
function buildArgs(options, jsonPath) {
    const args = ['playwright', 'test'];
    if (options.config !== undefined)
        args.push('--config', options.config);
    if (options.file !== undefined)
        args.push(options.file);
    if (options.grepTitle !== undefined)
        args.push('-g', escapeForGrep(options.grepTitle));
    if (options.project !== undefined)
        args.push('--project', options.project);
    if (options.workers !== undefined)
        args.push(`--workers=${options.workers}`);
    if (options.repeatEach !== undefined)
        args.push(`--repeat-each=${options.repeatEach}`);
    if (options.maxFailures !== undefined)
        args.push(`--max-failures=${options.maxFailures}`);
    // Replaces the project's reporters for this invocation. Deliberate: bisect
    // and validation want counts, and inheriting a consumer's HTML or blob
    // reporter would write artifacts nobody asked for on every probe.
    args.push('--reporter=json');
    void jsonPath;
    return args;
}
async function runPlaywright(options) {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'atest-run-'));
    const jsonPath = (0, node_path_1.join)(dir, 'report.json');
    try {
        const args = buildArgs(options, jsonPath);
        const result = await new Promise(resolve => {
            const child = (0, node_child_process_1.spawn)('npx', args, {
                cwd: options.cwd,
                env: {
                    ...process.env,
                    ...options.env,
                    PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath,
                    // The reporter is not wanted during a probe: bisect runs the same
                    // test dozens of times, and each run would otherwise write evidence
                    // bundles that pollute the history the analysis is reading.
                    ATEST: '0',
                    FORCE_COLOR: '0',
                },
                stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString('utf8');
            });
            const timeout = options.timeoutMs === undefined
                ? null
                : setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
            child.on('close', code => {
                if (timeout !== null)
                    clearTimeout(timeout);
                resolve({ code: code ?? 1, stderr });
            });
            child.on('error', error => {
                if (timeout !== null)
                    clearTimeout(timeout);
                resolve({ code: 1, stderr: error.message });
            });
        });
        const raw = await (0, promises_1.readFile)(jsonPath, 'utf8').catch(() => null);
        if (raw === null) {
            // No report means the run never got as far as executing tests — a config
            // error, a missing browser. That is INCONCLUSIVE, not a failing test;
            // counting it as a failure would make bisect blame the code under test
            // for a broken environment.
            return {
                ok: false,
                passed: 0,
                failed: 0,
                flaky: 0,
                skipped: 0,
                durationMs: 0,
                exitCode: result.code,
                inconclusive: true,
                stderr: result.stderr,
                specs: [],
            };
        }
        let report = {};
        try {
            report = JSON.parse(raw);
        }
        catch {
            return {
                ok: false,
                passed: 0,
                failed: 0,
                flaky: 0,
                skipped: 0,
                durationMs: 0,
                exitCode: result.code,
                inconclusive: true,
                stderr: `unparseable JSON report\n${result.stderr}`,
                specs: [],
            };
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
    }
    finally {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    }
}
//# sourceMappingURL=spawn.js.map