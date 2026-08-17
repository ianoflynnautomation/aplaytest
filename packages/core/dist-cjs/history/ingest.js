"use strict";
/**
 * Ingest run records written by the reporter into the history store.
 *
 * The reporter writes plain JSON; this is the seam where those files become
 * queryable history. Keeping it separate means a CI job can download shard
 * artifacts from anywhere and ingest them in one pass, and a developer can
 * replay months of archived runs to seed history without waiting for it to
 * accumulate.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestDirectory = ingestDirectory;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const types_js_1 = require("./types.js");
function validate(parsed, file) {
    if (typeof parsed !== 'object' || parsed === null)
        return 'not an object';
    const candidate = parsed;
    if (candidate.schemaVersion !== types_js_1.RUN_SCHEMA_VERSION) {
        return `schemaVersion ${String(candidate.schemaVersion)} — this build reads ${types_js_1.RUN_SCHEMA_VERSION}`;
    }
    if (typeof candidate.runId !== 'string' || candidate.runId === '')
        return 'missing runId';
    if (!Array.isArray(candidate.attempts))
        return 'missing attempts';
    void file;
    return candidate;
}
/**
 * Ingest every `*.json` in a directory.
 *
 * A malformed or version-mismatched file is SKIPPED and reported, never
 * thrown: one bad artifact among fifty shards must not cost you the other
 * forty-nine, and a partial history is far more useful than none.
 */
async function ingestDirectory(store, dir) {
    const entries = await (0, promises_1.readdir)(dir).catch(() => []);
    const files = entries.filter(name => name.endsWith('.json'));
    const skipped = [];
    let runsIngested = 0;
    let attemptsIngested = 0;
    for (const name of files) {
        const path = (0, node_path_1.join)(dir, name);
        let parsed;
        try {
            parsed = JSON.parse(await (0, promises_1.readFile)(path, 'utf8'));
        }
        catch (error) {
            skipped.push({ file: name, reason: error instanceof Error ? error.message : 'unreadable' });
            continue;
        }
        const validated = validate(parsed, name);
        if (typeof validated === 'string') {
            skipped.push({ file: name, reason: validated });
            continue;
        }
        // The doc comment above promises a bad file is skipped, never thrown —
        // but only the JSON parse and the shape check were guarded. A record that
        // passes both and then fails at the database (an unbindable value, a
        // constraint) threw straight out of here and rolled back the transaction,
        // costing every other file in the batch. In CI that reads as history
        // simply never accumulating.
        try {
            await store.ingest(validated);
        }
        catch (error) {
            skipped.push({
                file: name,
                reason: `could not be stored: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
        }
        runsIngested += 1;
        attemptsIngested += validated.attempts.length;
    }
    return { filesRead: files.length, runsIngested, attemptsIngested, skipped };
}
//# sourceMappingURL=ingest.js.map