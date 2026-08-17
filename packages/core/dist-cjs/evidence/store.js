"use strict";
/**
 * The evidence store: plain JSON on disk, one directory per run.
 *
 *   <dir>/<runId>/<evidenceId>.json
 *
 * Deliberately not a binary format and not a database. A human with `jq` must
 * be able to read a bundle, and a CI job must be able to upload the directory
 * as an artifact with no export step. Every bundle carries `schemaVersion` so
 * a reader can refuse politely rather than mis-parse.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvidenceStore = exports.SchemaVersionError = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const redact_js_1 = require("./redact.js");
const types_js_1 = require("./types.js");
class SchemaVersionError extends Error {
    found;
    expected;
    path;
    constructor(found, expected, path) {
        super(`Evidence bundle at ${path} is schemaVersion ${found}, this build reads ${expected}. ` +
            `Re-run the suite to regenerate, or use a matching atest version.`);
        this.found = found;
        this.expected = expected;
        this.path = path;
        this.name = 'SchemaVersionError';
    }
}
exports.SchemaVersionError = SchemaVersionError;
class EvidenceStore {
    options;
    constructor(options) {
        this.options = options;
    }
    bundlePath(runId, id) {
        return (0, node_path_1.join)(this.options.dir, runId, `${id}.json`);
    }
    /**
     * Redaction happens HERE, on the write path, so there is exactly one place
     * that can forget to do it.
     */
    async write(bundle) {
        const safe = (0, redact_js_1.redact)(bundle, this.options.redactKeys);
        const path = this.bundlePath(bundle.runId, bundle.id);
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(path), { recursive: true });
        await (0, promises_1.writeFile)(path, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
        return path;
    }
    async read(runId, id) {
        const path = this.bundlePath(runId, id);
        const raw = await (0, promises_1.readFile)(path, 'utf8');
        const parsed = JSON.parse(raw);
        const version = typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed
            ? parsed.schemaVersion
            : undefined;
        if (version !== types_js_1.EVIDENCE_SCHEMA_VERSION) {
            throw new SchemaVersionError(Number(version), types_js_1.EVIDENCE_SCHEMA_VERSION, path);
        }
        return parsed;
    }
    /** Run ids, newest first by directory mtime. */
    async listRuns() {
        const entries = await (0, promises_1.readdir)(this.options.dir, { withFileTypes: true }).catch(() => []);
        const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
        const withTime = await Promise.all(dirs.map(async (name) => ({
            name,
            mtime: await (0, promises_1.stat)((0, node_path_1.join)(this.options.dir, name))
                .then(s => s.mtimeMs)
                .catch(() => 0),
        })));
        return withTime.sort((a, b) => b.mtime - a.mtime).map(e => e.name);
    }
    async listBundles(runId) {
        const entries = await (0, promises_1.readdir)((0, node_path_1.join)(this.options.dir, runId)).catch(() => []);
        return entries.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
    }
    /** Drop the oldest runs beyond the retention limit. Returns what it removed. */
    async prune() {
        const runs = await this.listRuns();
        const doomed = runs.slice(this.options.retainRuns);
        await Promise.all(doomed.map(r => (0, promises_1.rm)((0, node_path_1.join)(this.options.dir, r), { recursive: true, force: true })));
        return doomed;
    }
}
exports.EvidenceStore = EvidenceStore;
//# sourceMappingURL=store.js.map