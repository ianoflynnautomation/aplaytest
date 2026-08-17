"use strict";
/**
 * The atest Playwright reporter.
 *
 * INVARIANT: this reporter must never change a run's verdict. It reports no
 * status from `onEnd`, swallows its own errors to stderr, and does its I/O
 * after the run rather than inside it. If atest breaks, the suite still tells
 * the truth about the application — that property is what makes adopting it a
 * one-line, revertible change.
 *
 * Work is COLLECTED in `onTestEnd` (synchronous, cheap: a couple of object
 * references) and FLUSHED in `onEnd` (asynchronous: attachment reads, JSON
 * writes). Playwright's `onTestEnd` cannot await, and doing file I/O per test
 * inside a parallel run is exactly the kind of overhead that would make people
 * turn the tool off.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ATEST_VERSION = void 0;
exports.runFileName = runFileName;
const promises_1 = require("node:fs/promises");
const promises_2 = require("node:fs/promises");
const node_path_1 = require("node:path");
const core_1 = require("@atest/core");
const assemble_js_1 = require("./assemble.js");
const sidecar_js_1 = require("./sidecar.js");
exports.ATEST_VERSION = '0.0.0';
const DEFAULTS = {
    evidenceDir: '.atest/evidence',
    runsDir: '.atest/runs',
    retainRuns: 50,
    redactKeys: ['password', 'token', 'authorization', 'cookie', 'secret', 'api-key'],
};
function toOutcome(status) {
    switch (status) {
        case 'passed':
            return 'passed';
        case 'failed':
            return 'failed';
        case 'timedOut':
            return 'timedOut';
        case 'skipped':
            return 'skipped';
        case 'interrupted':
            return 'interrupted';
        default:
            return 'failed';
    }
}
function warn(message) {
    process.stderr.write(`[atest] ${message}\n`);
}
class AtestReporter {
    options;
    collected = [];
    workerTests = new Map();
    config;
    runId = '';
    startedAt = '';
    enabled = true;
    constructor(options = {}) {
        this.options = options;
    }
    /** We add a short footer only; other reporters own the main output. */
    printsToStdio() {
        return false;
    }
    onBegin(config) {
        this.config = config;
        this.enabled = this.options.enabled ?? process.env['ATEST'] !== '0';
        this.startedAt = new Date().toISOString();
        const fromOptions = typeof this.options.runId === 'function' ? this.options.runId() : this.options.runId;
        // Environment wins over config, deliberately. Every shard of a CI run must
        // share one run id, and only the runtime knows it — a value baked into
        // playwright.config.ts cannot vary per invocation, so config-wins would
        // make sharded runs silently collapse into a single overwritten record.
        this.runId =
            process.env['ATEST_RUN_ID'] ??
                fromOptions ??
                `${this.startedAt.replace(/[:.]/g, '-')}-${process.pid}`;
    }
    onTestEnd(test, result) {
        if (!this.enabled)
            return;
        // Cheap and synchronous by design — two references and a string push.
        this.collected.push({ test, result });
        const onWorker = this.workerTests.get(result.workerIndex) ?? [];
        onWorker.push(test.id);
        this.workerTests.set(result.workerIndex, onWorker);
    }
    async onEnd(_result) {
        if (!this.enabled)
            return;
        try {
            await this.flush();
        }
        catch (error) {
            // A reporting failure must never become a test failure.
            warn(`failed to write evidence: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async flush() {
        const evidenceStore = new core_1.EvidenceStore({
            dir: this.options.evidenceDir ?? DEFAULTS.evidenceDir,
            redactKeys: this.options.redactKeys ?? DEFAULTS.redactKeys,
            retainRuns: this.options.retainRuns ?? DEFAULTS.retainRuns,
        });
        const attempts = [];
        let bundlesWritten = 0;
        for (const { test, result } of this.collected) {
            const outcome = toOutcome(result.status);
            // Playwright names the implicit project '' when a config declares no
            // projects. Empty string is a poor grouping key: it is part of the
            // scoring key and the evidence id, and it reads as missing data in
            // every report.
            const projectName = test.parent.project()?.name;
            const project = projectName === undefined || projectName === '' ? 'default' : projectName;
            const traceId = this.options.traceId?.({ id: test.id }, result.retry) ?? null;
            let failureKind = null;
            let evidenceIdValue = null;
            // Coverage is read for EVERY attempt, not only failures: what a passing
            // test visited is precisely what future selection needs.
            const coverage = await this.readCoverage(result);
            if ((0, core_1.isFailure)(outcome)) {
                try {
                    const sidecars = await this.readSidecars(result);
                    const bundle = (0, assemble_js_1.assembleBundle)({
                        test: {
                            id: test.id,
                            title: test.title,
                            titlePath: () => test.titlePath(),
                            location: { file: test.location.file, line: test.location.line },
                            tags: test.tags,
                        },
                        result: result,
                        sidecars,
                        context: {
                            runId: this.runId,
                            traceId,
                            project,
                            shard: this.config?.shard ?? null,
                            workers: this.config?.workers ?? 1,
                            appEnv: process.env['APP_ENV'] ?? 'unknown',
                            baseUrl: process.env['BASE_URL'] ?? '',
                            browser: project,
                            platform: process.platform,
                            commit: process.env['GITHUB_SHA'] ?? '',
                            changedPaths: [],
                            timeoutMs: test.timeout,
                        },
                    });
                    await evidenceStore.write(bundle);
                    bundlesWritten += 1;
                    failureKind = bundle.failure.kind;
                    evidenceIdValue = bundle.id;
                }
                catch (error) {
                    if (error instanceof sidecar_js_1.SidecarParseError) {
                        // Loud, named, and actionable — a drifted contract is a bug in the
                        // fixtures, not something to paper over with an empty bundle.
                        warn(error.message);
                    }
                    else {
                        warn(`could not build evidence for "${test.title}": ` +
                            `${error instanceof Error ? error.message : String(error)}`);
                    }
                    failureKind = (0, assemble_js_1.classifyResult)(result, EMPTY, test.timeout).kind;
                }
            }
            attempts.push({
                testId: test.id,
                title: test.title,
                titlePath: test.titlePath(),
                file: test.location.file,
                line: test.location.line,
                project,
                tags: test.tags,
                retry: result.retry,
                outcome,
                failureKind,
                durationMs: result.duration,
                workerIndex: result.workerIndex,
                shard: this.config?.shard ?? null,
                traceId,
                evidenceId: evidenceIdValue,
                coScheduled: (this.workerTests.get(result.workerIndex) ?? []).filter(id => id !== test.id),
                routes: coverage,
            });
        }
        const run = {
            schemaVersion: core_1.RUN_SCHEMA_VERSION,
            runId: this.runId,
            startedAt: this.startedAt,
            finishedAt: new Date().toISOString(),
            commit: process.env['GITHUB_SHA'] ?? null,
            branch: process.env['GITHUB_REF_NAME'] ?? null,
            appEnv: process.env['APP_ENV'] ?? null,
            ci: process.env['CI'] === 'true' || process.env['CI'] === '1',
            workers: this.config?.workers ?? 1,
            shard: this.config?.shard ?? null,
            atestVersion: exports.ATEST_VERSION,
            playwrightVersion: this.config?.version ?? null,
            attempts,
        };
        const runPath = (0, node_path_1.join)(this.options.runsDir ?? DEFAULTS.runsDir, runFileName(this.runId, run.shard, attempts.map(a => a.project)));
        await (0, promises_2.mkdir)((0, node_path_1.dirname)(runPath), { recursive: true });
        await (0, promises_2.writeFile)(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
        await evidenceStore.prune();
        const failures = attempts.filter(a => (0, core_1.isFailure)(a.outcome)).length;
        if (failures > 0) {
            warn(`${bundlesWritten}/${failures} failures captured → ${runPath}`);
        }
    }
    async readAttachment(result, name) {
        const attachment = result.attachments.find(a => a.name === name);
        if (attachment === undefined)
            return undefined;
        if (attachment.body !== undefined)
            return attachment.body.toString('utf8');
        if (attachment.path !== undefined)
            return (0, promises_1.readFile)(attachment.path, 'utf8').catch(() => undefined);
        return undefined;
    }
    async readCoverage(result) {
        try {
            const parsed = (0, sidecar_js_1.parseSidecar)(sidecar_js_1.SIDECAR.coverage, await this.readAttachment(result, sidecar_js_1.SIDECAR.coverage));
            return parsed?.routes ?? [];
        }
        catch (error) {
            // A drifted coverage sidecar must not cost us the attempt record.
            warn(error instanceof Error ? error.message : String(error));
            return [];
        }
    }
    async readSidecars(result) {
        const read = (name) => this.readAttachment(result, name);
        return {
            page: (0, sidecar_js_1.parseSidecar)(sidecar_js_1.SIDECAR.page, await read(sidecar_js_1.SIDECAR.page)),
            network: (0, sidecar_js_1.parseSidecar)(sidecar_js_1.SIDECAR.network, await read(sidecar_js_1.SIDECAR.network)),
            console: (0, sidecar_js_1.parseSidecar)(sidecar_js_1.SIDECAR.console, await read(sidecar_js_1.SIDECAR.console)),
            intent: (0, sidecar_js_1.parseSidecar)(sidecar_js_1.SIDECAR.intent, await read(sidecar_js_1.SIDECAR.intent)),
        };
    }
}
exports.default = AtestReporter;
const EMPTY = { page: null, network: null, console: null, intent: null };
/**
 * One file per INVOCATION, not per run.
 *
 * Naming the file `<runId>.json` looks right until the suite is sharded, and
 * then it silently destroys almost all of the data. Every shard shares one run
 * id on purpose — that is how they get merged — so every shard wrote the same
 * filename. Measured on a three-shard run: shards 1 and 2 recorded their
 * attempts, shard 3 had no tests to run, and its empty record overwrote both.
 * The surviving file reported `attempts: 0` for a run that passed four tests.
 *
 * It survives the upload too. CI downloads shard artifacts with
 * `merge-multiple: true`, which flattens them into one directory — identical
 * names collide there as well, so a 6-shard × 9-project matrix would keep one
 * file in fifty-four.
 *
 * Shard and project both go in the name because their matrix varies both, and
 * two jobs differing only by project would otherwise still collide.
 */
function runFileName(runId, shard, projects) {
    const parts = [runId];
    if (shard !== null)
        parts.push(`shard-${shard.current}of${shard.total}`);
    const distinct = [...new Set(projects)].sort();
    if (distinct.length === 1 && distinct[0] !== undefined)
        parts.push(distinct[0]);
    else if (distinct.length > 1)
        parts.push(shortHash(distinct.join(',')));
    return `${parts.join('-').replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}
/** djb2, base36. Deterministic — re-ingesting the same file must be idempotent. */
function shortHash(input) {
    let hash = 5381;
    for (let i = 0; i < input.length; i += 1)
        hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
    return hash.toString(36).padStart(7, '0').slice(0, 7);
}
//# sourceMappingURL=reporter.js.map