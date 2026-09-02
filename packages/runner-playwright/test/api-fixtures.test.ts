import { describe, expect, it } from 'vitest';

import {
  atestApiFixtures,
  createApiCaptureFixture,
  recordingContext,
} from '../src/api-fixtures.js';
import { atestFixtures } from '../src/fixtures.js';

/**
 * Playwright decides which fixtures to instantiate by parsing the destructuring
 * pattern of a fixture's first parameter. So reading that pattern back is not a
 * proxy for the behaviour — it IS the mechanism.
 */
function declaredDependencies(fn: unknown): string[] {
  const source = String(fn);
  const match = /^[^(]*\(\s*\{([^}]*)\}/.exec(source);
  if (match?.[1] === undefined) return [];
  return match[1]
    .split(',')
    .map(s => (s.split(':')[0] ?? '').trim())
    .filter(Boolean);
}

describe('atestApiFixtures — must not pull in a browser', () => {
  /**
   * REGRESSION GUARD, measured against a real Playwright run.
   *
   * `atestCapture` is `auto: true` and declares `{ page }`, so Playwright
   * instantiates a page — and therefore launches a browser — for every test in
   * the project, including API tests that only touch `request`. Pointed at an
   * uninstalled browser, an API-only spec failed with
   * `browserType.launch: Executable doesn't exist` under the UI fixtures and
   * passed in 24ms under these. Across three API shards the UI fixtures are
   * pure cost, and a behaviour change to a pipeline that launched nothing.
   */
  it('given the API request fixture -> when its declared dependencies are read -> then page is absent, so no browser is launched', { tags: ['@unit', '@runner'] }, () => {
    expect(declaredDependencies(atestApiFixtures.request)).not.toContain('page');
  });

  it('given the API request fixture -> when its declared dependencies are read -> then it depends on request, which is what it wraps', { tags: ['@unit', '@runner'] }, () => {
    expect(declaredDependencies(atestApiFixtures.request)).toContain('request');
  });

  it('given the UI capture fixture -> when its declared dependencies are read -> then it does depend on page, so the two fixtures are not interchangeable', { tags: ['@unit', '@runner'] }, () => {
    // Stated as a test so the split cannot be quietly collapsed back into one.
    const [uiFixture] = atestFixtures.atestCapture;
    expect(declaredDependencies(uiFixture)).toContain('page');
  });

  it('given the API fixtures object -> when its keys are read -> then it overrides request alone rather than adding a fixture specs must name', { tags: ['@unit', '@runner'] }, () => {
    expect(Object.keys(atestApiFixtures)).toEqual(['request']);
  });
});

describe('recordingContext', () => {
  const stubResponse = (status: number) => ({ status: () => status }) as never;

  it('given a recording context wrapping a successful GET -> when a request is made -> then the method, url and status are recorded and the route drops its query string', { tags: ['@unit', '@runner'] }, async () => {
    const calls: Parameters<typeof recordingContext>[1] = [];
    const routes = new Set<string>();
    const ctx = recordingContext(
      { get: async () => stubResponse(200) } as never,
      calls,
      routes,
      100,
    );

    await ctx.get('http://api.test/gyms?county=Cork');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', status: 200 });
    // Route coverage drops the query string, so impact analysis groups calls
    // to one endpoint rather than treating each filter as its own route.
    expect([...routes]).toEqual(['/gyms']);
  });

  it('given a fetch call carrying a lowercase method option -> when the recording context records it -> then the method comes from the options, uppercased, not from the response', { tags: ['@unit', '@runner'] }, async () => {
    // A redirect would make the response report the final hop's method.
    const calls: Parameters<typeof recordingContext>[1] = [];
    const ctx = recordingContext(
      { fetch: async () => stubResponse(201) } as never,
      calls,
      new Set(),
      100,
    );

    await ctx.fetch('http://api.test/gyms', { method: 'post' });
    expect(calls[0]?.method).toBe('POST');
  });

  it('given a request that throws a transport error -> when the recording context wraps it -> then the failure is recorded and the error is rethrown', { tags: ['@unit', '@runner'] }, async () => {
    const calls: Parameters<typeof recordingContext>[1] = [];
    const ctx = recordingContext(
      {
        get: async () => {
          throw new Error('ECONNREFUSED');
        },
      } as never,
      calls,
      new Set(),
      100,
    );

    await expect(ctx.get('http://api.test/gyms')).rejects.toThrow('ECONNREFUSED');
    expect(calls[0]).toMatchObject({ status: null, failureText: 'ECONNREFUSED' });
  });

  it('given a recording context capped at two requests -> when five calls are made -> then only two are retained', { tags: ['@unit', '@runner'] }, async () => {
    const calls: Parameters<typeof recordingContext>[1] = [];
    const ctx = recordingContext({ get: async () => stubResponse(200) } as never, calls, new Set(), 2);
    for (let i = 0; i < 5; i += 1) await ctx.get(`http://api.test/${i}`);
    expect(calls).toHaveLength(2);
  });

  it('given a context method the wrapper does not record -> when it is called -> then it passes through unchanged', { tags: ['@unit', '@runner'] }, async () => {
    // The APIRequestContext surface grows between Playwright versions; a
    // wrapper that enumerates today's methods silently drops tomorrow's.
    const ctx = recordingContext(
      { dispose: async () => 'disposed', storageState: async () => ({ cookies: [] }) } as never,
      [],
      new Set(),
      100,
    );
    await expect((ctx as unknown as { dispose(): Promise<string> }).dispose()).resolves.toBe(
      'disposed',
    );
  });

  it('given a maxRequests option -> when createApiCaptureFixture builds the fixture -> then a fixture function is returned', { tags: ['@unit', '@runner'] }, () => {
    expect(typeof createApiCaptureFixture({ maxRequests: 5 })).toBe('function');
  });
});
