/**
 * Capture for API projects — the same job as `atestFixtures`, minus a browser.
 *
 * WHY THIS EXISTS, measured rather than assumed: `atestCapture` is registered
 * `auto: true` and declares `{ page }`. Playwright reads fixture dependencies
 * from that destructuring pattern, so an auto fixture naming `page` forces a
 * browser for EVERY test in the project — including tests that only ever touch
 * `request`. An API-only spec still passed, and still launched six Chromium
 * processes. In a suite with three API shards that is pure cost, and it is a
 * behaviour change to a pipeline that previously launched nothing.
 *
 * So the split is not cosmetic. The rule is simple and worth stating plainly:
 *
 *   UI projects  → atestFixtures      (needs a page)
 *   API projects → atestApiFixtures   (must never mention one)
 *
 * What is capturable without a browser is narrower, but not nothing. The
 * reporter already records the failure, the matcher, and the page-object
 * intent. What it cannot see is which HTTP calls the test actually made — and
 * on an API failure that is usually the whole question. So this wraps the
 * `request` fixture and records the ledger.
 */

import { type APIRequestContext, type APIResponse, type TestInfo } from '@playwright/test';

import { SIDECAR } from './sidecar.js';

export interface ApiCaptureOptions {
  readonly slowRequestMs?: number;
  readonly maxRequests?: number;
}

const DEFAULTS = {
  slowRequestMs: 2_000,
  maxRequests: 200,
} as const;

interface Call {
  readonly url: string;
  readonly method: string;
  readonly status: number | null;
  readonly durationMs: number;
  readonly failureText: string | null;
  readonly schemaError: null;
}

/** Verb helpers plus the generic one. Everything else passes straight through. */
const RECORDED = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

function routeOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

async function attach(testInfo: TestInfo, name: string, payload: unknown): Promise<void> {
  try {
    await testInfo.attach(name, {
      body: JSON.stringify(payload),
      contentType: 'application/json',
    });
  } catch (error) {
    // Priority one, same as the UI fixture: a capture failure is a warning,
    // never an exception. Diagnostics that can fail a suite are worse than no
    // diagnostics.
    process.stderr.write(`[atest] could not attach ${name}: ${String(error)}\n`);
  }
}

/**
 * Wrap an APIRequestContext so every call is recorded.
 *
 * A Proxy rather than a hand-written class: `APIRequestContext` gains methods
 * across Playwright versions, and a class that enumerates today's surface
 * silently drops whatever is added next. Anything not in `RECORDED` is
 * forwarded untouched, so the wrapper cannot change behaviour it does not
 * understand.
 */
export function recordingContext(
  context: APIRequestContext,
  calls: Call[],
  routes: Set<string>,
  max: number,
): APIRequestContext {
  return new Proxy(context, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;

      if (typeof value !== 'function' || typeof prop !== 'string' || !RECORDED.has(prop)) {
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      }

      const original = value as (...args: unknown[]) => Promise<APIResponse>;
      return async (...args: unknown[]): Promise<APIResponse> => {
        const url = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '');
        const started = Date.now();
        try {
          const response = await original.apply(target, args);
          if (calls.length < max) {
            calls.push({
              url,
              // `fetch` takes the method in options; the verb helpers are the
              // method. Reading it back off the response is wrong — a redirect
              // would report the final hop.
              method: prop === 'fetch' ? readMethod(args[1]) : prop.toUpperCase(),
              status: response.status(),
              durationMs: Date.now() - started,
              failureText: null,
              schemaError: null,
            });
          }
          routes.add(routeOf(url));
          return response;
        } catch (error) {
          if (calls.length < max) {
            calls.push({
              url,
              method: prop === 'fetch' ? readMethod(args[1]) : prop.toUpperCase(),
              status: null,
              durationMs: Date.now() - started,
              failureText: error instanceof Error ? error.message : String(error),
              schemaError: null,
            });
          }
          routes.add(routeOf(url));
          // Rethrown unchanged. A capture layer that swallows a transport
          // error would turn a real failure into a confusing assertion one.
          throw error;
        }
      };
    },
  });
}

function readMethod(options: unknown): string {
  if (typeof options === 'object' && options !== null && 'method' in options) {
    const method = (options as { method?: unknown }).method;
    if (typeof method === 'string') return method.toUpperCase();
  }
  return 'GET';
}

/**
 * Override for Playwright's `request` fixture.
 *
 * Depends on `request` and nothing else — in particular NOT on `page`, which
 * is the entire point. Adding `page` here would reintroduce the browser launch
 * this file exists to remove, so the guard in the tests asserts the dependency
 * pattern directly.
 */
export function createApiCaptureFixture(options: ApiCaptureOptions = {}) {
  const config = { ...DEFAULTS, ...options };

  return async (
    { request }: { request: APIRequestContext },
    use: (value: APIRequestContext) => Promise<void>,
    testInfo: TestInfo,
  ): Promise<void> => {
    const calls: Call[] = [];
    const routes = new Set<string>();

    await use(recordingContext(request, calls, routes, config.maxRequests));

    // Route coverage is recorded for every test, pass or fail — it is what
    // lets impact analysis narrow past a shared fixture barrel.
    if (routes.size > 0) {
      await attach(testInfo, SIDECAR.coverage, { routes: [...routes].sort() });
    }

    // Everything else only on failure, so a green run pays nothing.
    if (testInfo.status === testInfo.expectedStatus) return;

    const failed = calls.filter(c => c.status === null || c.status >= 400);
    const slow = calls.filter(c => c.durationMs >= config.slowRequestMs);
    const statusCounts: Record<string, number> = {};
    for (const call of calls) {
      const key = call.status === null ? 'error' : String(call.status);
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    }

    await attach(testInfo, SIDECAR.network, { failed, slow, statusCounts });
  };
}

/**
 * Compose into an API project's fixture barrel:
 *
 *   export const test = base.extend({ ...atestApiFixtures, ...apiFixtures });
 *
 * Unlike the UI fixtures this replaces `request` rather than adding a new
 * fixture, so it is still a one-line change and specs never mention it.
 */
export const atestApiFixtures = {
  request: createApiCaptureFixture(),
};
