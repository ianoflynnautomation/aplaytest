/**
 * Library version written into evidence bundles, run records, and MCP
 * handshake metadata.
 *
 * Must match `packages/core/package.json` — the unit test in `config.test.ts`
 * enforces that, because a drift here is how a consumer's `atest doctor`
 * reports a version nobody published.
 */
export const ATEST_VERSION = '0.1.0';

