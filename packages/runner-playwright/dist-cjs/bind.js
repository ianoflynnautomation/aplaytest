"use strict";
/**
 * Page-object binding with step instrumentation.
 *
 * A drop-in for the common `bindPage(module, page)` helper: it binds each
 * exported function's first `page` argument, and additionally wraps the call
 * in `test.step()` so the call trail reaches the reporter.
 *
 * That trail is the difference between a failure that says
 *
 *     locator getByTestId('gym-card-name') did not resolve
 *
 * and one that says
 *
 *     gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' }) failed
 *
 * The first states where the test looked; the second states what it WANTED,
 * and the domain values in it are what candidate generation matches against
 * the page's accessibility tree.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewValue = previewValue;
exports.previewArgs = previewArgs;
exports.bindPage = bindPage;
const test_1 = require("@playwright/test");
/** Values whose contents must never reach a step title. */
const SENSITIVE_KEYS = ['password', 'token', 'secret', 'authorization', 'apikey', 'api_key'];
const MAX_PREVIEW_LENGTH = 120;
const MAX_DEPTH = 2;
function isIdentifier(key) {
    return /^[A-Za-z_$][\w$]*$/.test(key);
}
function isSensitive(key) {
    const normalised = key.toLowerCase().replace(/[-_]/g, '');
    return SENSITIVE_KEYS.some(k => normalised.includes(k.replace(/[-_]/g, '')));
}
/**
 * Render arguments the way a developer would have written them —
 * `{ name: 'Blackwater Valley BJJ' }`, not `{"name":"Blackwater Valley BJJ"}`.
 *
 * The distinction is load-bearing, not cosmetic: domain-value extraction pulls
 * quoted literals out of this string, and JSON's quoted KEYS would arrive
 * looking exactly like values. `name` would then be matched against the ARIA
 * tree alongside the gym it labels.
 */
function previewValue(value, depth = 0) {
    if (value === null)
        return 'null';
    if (value === undefined)
        return 'undefined';
    switch (typeof value) {
        case 'string':
            return `'${value.replace(/'/g, "\\'")}'`;
        case 'number':
        case 'boolean':
        case 'bigint':
            return String(value);
        case 'function':
            return 'fn';
        case 'symbol':
            return value.toString();
        default:
            break;
    }
    if (depth >= MAX_DEPTH)
        return Array.isArray(value) ? '[…]' : '{…}';
    if (Array.isArray(value)) {
        return `[${value.map(v => previewValue(v, depth + 1)).join(', ')}]`;
    }
    if (value instanceof RegExp)
        return value.toString();
    if (value instanceof Date)
        return value.toISOString();
    const entries = Object.entries(value).map(([key, inner]) => {
        const renderedKey = isIdentifier(key) ? key : `'${key}'`;
        const renderedValue = isSensitive(key) ? "'[redacted]'" : previewValue(inner, depth + 1);
        return `${renderedKey}: ${renderedValue}`;
    });
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}
function previewArgs(args) {
    const rendered = args.map(a => previewValue(a)).join(', ');
    return rendered.length > MAX_PREVIEW_LENGTH
        ? `${rendered.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
        : rendered;
}
function isAsyncFunction(fn) {
    return typeof fn === 'function' && fn.constructor.name === 'AsyncFunction';
}
/**
 * Bind a page-object module to a page.
 *
 * `name` is what appears before the method in the step title, and should match
 * the fixture name the specs use (`gymsPage`) so a reader sees the same
 * vocabulary in the report as in the test.
 */
function bindPage(mod, page, name) {
    const bound = {};
    for (const [key, value] of Object.entries(mod)) {
        if (typeof value !== 'function') {
            bound[key] = value;
            continue;
        }
        const fn = value;
        // Only async functions are wrapped. `test.step` always returns a promise,
        // so wrapping a synchronous helper would silently change its contract and
        // make the mapped return type a lie.
        if (!isAsyncFunction(fn)) {
            bound[key] = (...args) => fn(page, ...args);
            continue;
        }
        const label = name === undefined ? key : `${name}.${key}`;
        bound[key] = (...args) => test_1.test.step(`${label}(${previewArgs(args)})`, () => fn(page, ...args));
    }
    return bound;
}
//# sourceMappingURL=bind.js.map