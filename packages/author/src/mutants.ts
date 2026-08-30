/**
 * Mutants — the machinery behind the falsifiability gate.
 *
 * A generated test that navigates to /gyms, asserts the page header, and calls
 * itself filtering coverage is the single most common failure of LLM-authored
 * tests. It passes, it looks reasonable in review, and it asserts nothing. The
 * only reliable way to catch it is to BREAK THE WORLD and check the test
 * notices.
 *
 * Mutation happens by temporarily injecting a `beforeEach` into the candidate
 * spec, then restoring the file — the same apply/run/restore discipline
 * `validateHeal` uses, for the same reason: a crash mid-run must leave a
 * recoverable file on disk, never a half-mutated repository.
 *
 * Two rejected alternatives, both worse:
 *   · An env var read by a cooperating fixture — needs the target repo to
 *     adopt an atest fixture, so the gate would not work on the suite it is
 *     most needed for.
 *   · An HTTP proxy in front of the app — cooperation-free, but a second
 *     network hop that changes timing, and timing changes are exactly what a
 *     stability check must not be confounded by.
 *
 * Injected code is transpiled by Playwright, never typechecked by it, so it
 * must be runtime-correct above all. It is written typed anyway: it is read by
 * humans debugging a gate failure.
 */

export type MutantName = 'empty-page' | 'unfiltered' | 'http-500';

/**
 * Not all mutants are equal evidence, and treating them as equal is how a
 * falsifiability gate ends up certifying a test that asserts nothing.
 *
 * `http-500` breaks the entire page render, so it kills almost any test that
 * loads a page — including one whose only assertion is that a header appeared.
 * Surviving it means the test does not touch the app at all; killing it proves
 * only LIVENESS. Measured against the live app, a deliberately vacuous test
 * ("navigate, assert the header") was killed by http-500 and by nothing else,
 * and a gate requiring one kill of any kind passed it.
 *
 * A test earns trust by dying to a mutant that changes DATA while leaving the
 * page perfectly renderable.
 */
export type MutantClass = 'liveness' | 'content' | 'discrimination';

export interface Mutant {
  readonly name: MutantName;
  readonly class: MutantClass;
  /** What a test must assert for this mutant to kill it. */
  readonly kills: string;
  /** Source injected as a `beforeEach` into the candidate spec. */
  readonly code: string;
}

/** Kills by these classes are evidence the test asserts something real. */
export const MEANINGFUL_CLASSES: ReadonlySet<MutantClass> = new Set(['content', 'discrimination']);

export interface MutantOptions {
  /** Glob matched against request URLs. Defaults to any /api/ route. */
  readonly apiPattern?: string | undefined;
}

const DEFAULT_API_PATTERN = '**/api/**';

/**
 * Wraps a route handler body so TEARDOWN CANNOT COUNT AS A KILL.
 *
 * A mutant may only kill a test by changing what the app returns. Killing one
 * by winning a race is not evidence about the test, and it is the worst
 * possible bug in a falsifiability gate: it certifies a vacuous test as
 * meaningful, which is the exact failure the gate exists to prevent.
 *
 * The race is structural, not hypothetical. A test whose last assertion reads
 * something already in the initial HTML — `expect(header).toBeVisible()`, the
 * canonical vacuous test — finishes while the handler is still inside
 * `route.fetch()`. Playwright then closes the page, the in-flight call
 * rejects, and an unhandled rejection in a route handler FAILS THE TEST. A
 * test that asserts on the response instead waits for the handler by
 * construction, so only the vacuous shape is affected — precisely the shape
 * that must not be certified.
 *
 * Measured: this failed 3 of 6 CI runs on a loaded runner and never once
 * locally, always with the same signature — the vacuous fixture killed by
 * `unfiltered` while surviving `http-500`, which breaks the API outright. A
 * kill that a total outage does not reproduce was never about data.
 *
 * Errors are swallowed ONLY once the page is gone. Anything else rethrows: a
 * handler that is genuinely broken must still be loud, because a mutant that
 * silently no-ops reports "killed 0/3" and blames the test.
 */
function guarded(body: string): string {
  return `    try {
${body}
    } catch (error) {
      // The page closed mid-flight because the test finished first. Not a
      // verdict about the test; rethrow anything that is.
      if (!page.isClosed()) throw error;
    }`;
}

/**
 * Empty every array in the response, whatever the payload shape.
 *
 * Shape-agnostic on purpose. Hard-coding `{ items: [] }` would work against
 * one API and silently no-op against the next one, and a mutant that no-ops is
 * worse than no mutant: it reports "killed 0/3" and blames the test.
 */
function emptyPageCode(pattern: string): string {
  return `test.beforeEach(async ({ page }) => {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return [];
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, strip(v)]),
      );
    }
    return value;
  };
  await page.route('${pattern}', async route => {
${guarded(`      // Bypass Playwright's APIResponse — its body can only be read once.
      const request = route.request();
      const upstream = await fetch(request.url(), {
        method: request.method(),
        headers: request.headers(),
      });
      const status = upstream.status;
      const headers = Object.fromEntries(upstream.headers.entries());
      const body = await upstream.text();
      try {
        const json: unknown = JSON.parse(body);
        await route.fulfill({ status, headers, json: strip(json) });
      } catch {
        await route.fulfill({ status, headers, body });
      }`)}
  });
});`;
}

/**
 * Re-request without the query string, so filters and search appear to do
 * nothing while the endpoint still returns real data.
 *
 * This is the mutant that enforces the "environments hold full datasets" data
 * policy mechanically. A test asserting a seeded card is on page 1 of an
 * unfiltered list passes locally on lucky ordering and dies here — which is
 * precisely the rule a human reviewer forgets to apply.
 */
function unfilteredCode(pattern: string): string {
  return `test.beforeEach(async ({ page }) => {
  await page.route('${pattern}', async route => {
${guarded(`      const url = new URL(route.request().url());
      if ([...url.searchParams.keys()].length === 0) {
        await route.continue();
        return;
      }
      const response = await route.fetch({ url: url.origin + url.pathname });
      await route.fulfill({ response });`)}
  });
});`;
}

function http500Code(pattern: string): string {
  return `test.beforeEach(async ({ page }) => {
  await page.route('${pattern}', async route => {
${guarded(`      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'atest falsifiability mutant' }),
      });`)}
  });
});`;
}

export function buildMutants(options: MutantOptions = {}): Mutant[] {
  const pattern = options.apiPattern ?? DEFAULT_API_PATTERN;
  return [
    {
      name: 'empty-page',
      class: 'content',
      kills: 'tests that assert content is present',
      code: emptyPageCode(pattern),
    },
    {
      name: 'unfiltered',
      class: 'discrimination',
      kills: 'tests that assert a filter or search narrows results',
      code: unfilteredCode(pattern),
    },
    {
      name: 'http-500',
      class: 'liveness',
      kills: 'tests that touch the app at all — weak evidence on its own',
      code: http500Code(pattern),
    },
  ];
}

const MARKER = '// __atest_mutant__';

/**
 * Insert the mutant after the candidate's imports.
 *
 * After, not before: the injected block references the spec's own `test`
 * binding, whichever fixture it was imported from. Placing it above the import
 * would reference a temporal-dead-zone binding and fail every mutant run with
 * a ReferenceError — which the gate would read as "killed", passing a test
 * that asserts nothing.
 */
export function applyMutant(source: string, mutant: Mutant): string {
  const lines = source.split('\n');

  let lastImport = -1;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('import ')) lastImport = i;
    // A multi-line import's closing brace, e.g. `} from './fixtures.js';`
    else if (lastImport !== -1 && /^\}\s*from\s+/.test(line)) lastImport = i;
  }

  const at = lastImport + 1;
  // Blank padding goes INSIDE the marker pair. Outside it, `stripMutant`
  // removes only the marked region and leaves the blank lines behind, so a
  // round-trip is not byte-identical — and "restored the file" stops being a
  // claim anyone can verify.
  const block = [`${MARKER} ${mutant.name}`, '', mutant.code, '', MARKER];
  return [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n');
}

/** Remove an injected mutant — used to assert round-tripping, not in the run path. */
export function stripMutant(source: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex(l => l.trimStart().startsWith(MARKER));
  if (start === -1) return source;
  const end = lines.findIndex((l, i) => i > start && l.trimStart() === MARKER);
  if (end === -1) return source;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
}

export function hasMutant(source: string): boolean {
  return source.includes(MARKER);
}
