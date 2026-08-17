"use strict";
/**
 * The fixture → reporter channel.
 *
 * A Playwright reporter runs in the main process and cannot reach into the
 * browser. Anything only the worker knows — the ARIA snapshot, the request
 * ledger, console output — has to travel as a test ATTACHMENT, which is the
 * runner's own supported channel and needs no side files or IPC.
 *
 * Both ends import these schemas, and the reporter PARSES rather than casts.
 * A fixture that drifts from the contract fails loudly with a named error
 * instead of silently producing a bundle with an empty ARIA snapshot — the
 * same reasoning behind validating mocked response bodies against wire
 * schemas rather than trusting them.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SidecarParseError = exports.CoverageSidecarSchema = exports.IntentSidecarSchema = exports.ConsoleSidecarSchema = exports.NetworkSidecarSchema = exports.PageSidecarSchema = exports.SIDECAR = void 0;
exports.parseSidecar = parseSidecar;
const zod_1 = require("zod");
exports.SIDECAR = {
    page: 'atest:page',
    network: 'atest:network',
    console: 'atest:console',
    intent: 'atest:intent',
    coverage: 'atest:coverage',
};
exports.PageSidecarSchema = zod_1.z.object({
    url: zod_1.z.string(),
    title: zod_1.z.string(),
    ariaSnapshot: zod_1.z.string(),
    testIdsPresent: zod_1.z.array(zod_1.z.string()),
    htmlDigest: zod_1.z.string().nullable().default(null),
});
const RequestRecordSchema = zod_1.z.object({
    url: zod_1.z.string(),
    method: zod_1.z.string(),
    status: zod_1.z.number().nullable(),
    durationMs: zod_1.z.number(),
    failureText: zod_1.z.string().nullable().default(null),
    schemaError: zod_1.z.string().nullable().default(null),
});
exports.NetworkSidecarSchema = zod_1.z.object({
    failed: zod_1.z.array(RequestRecordSchema),
    slow: zod_1.z.array(RequestRecordSchema),
    statusCounts: zod_1.z.record(zod_1.z.string(), zod_1.z.number()),
});
exports.ConsoleSidecarSchema = zod_1.z.object({
    errors: zod_1.z.array(zod_1.z.string()),
    warnings: zod_1.z.array(zod_1.z.string()),
});
exports.IntentSidecarSchema = zod_1.z.object({
    selector: zod_1.z.string().nullable().default(null),
    selectorSource: zod_1.z
        .object({
        file: zod_1.z.string(),
        line: zod_1.z.number(),
        constantPath: zod_1.z.string(),
        aliases: zod_1.z.array(zod_1.z.string()).default([]),
    })
        .nullable()
        .default(null),
});
/**
 * Routes a test actually visited.
 *
 * The one signal that survives a fixture barrel. Static imports say every spec
 * depends on every feature (they compose one `test` object); what a test
 * VISITED is independent of that, and is the only thing that can narrow
 * selection in a suite built that way.
 */
exports.CoverageSidecarSchema = zod_1.z.object({
    routes: zod_1.z.array(zod_1.z.string()),
});
const SCHEMAS = {
    [exports.SIDECAR.page]: exports.PageSidecarSchema,
    [exports.SIDECAR.network]: exports.NetworkSidecarSchema,
    [exports.SIDECAR.console]: exports.ConsoleSidecarSchema,
    [exports.SIDECAR.intent]: exports.IntentSidecarSchema,
    [exports.SIDECAR.coverage]: exports.CoverageSidecarSchema,
};
class SidecarParseError extends Error {
    sidecar;
    issues;
    constructor(sidecar, issues) {
        super(`Attachment "${sidecar}" does not match its schema — the atest fixtures and ` +
            `reporter are out of sync.\n${issues}`);
        this.sidecar = sidecar;
        this.issues = issues;
        this.name = 'SidecarParseError';
    }
}
exports.SidecarParseError = SidecarParseError;
/**
 * Parse a sidecar payload. Absent is fine (the fixtures are optional);
 * PRESENT-BUT-WRONG is not, and throws.
 */
function parseSidecar(name, raw) {
    if (raw === undefined)
        return null;
    let json;
    try {
        json = JSON.parse(raw);
    }
    catch (error) {
        throw new SidecarParseError(name, error instanceof Error ? error.message : String(error));
    }
    const result = SCHEMAS[name].safeParse(json);
    if (!result.success) {
        const issues = result.error.issues
            .map(i => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n');
        throw new SidecarParseError(name, issues);
    }
    return result.data;
}
//# sourceMappingURL=sidecar.js.map