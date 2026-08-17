import { describe, expect, it } from 'vitest';

import { affectedSpecs, hubFiles, reachesOnlyViaHubs, unattributableSpecs, type ImportGraph } from '../src/graph.js';
import { DEFAULT_SELECTION_CONFIG, selectTests } from '../src/select.js';
import { normaliseRoute } from '../src/coverage.js';

/** Build a graph from `target → importers` edges. */
function graph(specs: string[], edges: Record<string, string[]>): ImportGraph {
  const importers = new Map<string, Set<string>>();
  for (const [target, list] of Object.entries(edges)) importers.set(target, new Set(list));
  return { specs, importers, fileCount: specs.length + Object.keys(edges).length };
}

const FEATURE_GRAPH = graph(['tests/gyms.spec.ts', 'tests/events.spec.ts'], {
  'src/gyms.constants.ts': ['src/gyms.page.ts'],
  'src/gyms.page.ts': ['tests/gyms.spec.ts'],
  'src/events.page.ts': ['tests/events.spec.ts'],
});

describe('affectedSpecs', () => {
  it('walks imports backwards to the specs', () => {
    const affected = affectedSpecs(FEATURE_GRAPH, ['src/gyms.constants.ts']);
    expect([...affected.keys()]).toEqual(['tests/gyms.spec.ts']);
  });

  it('records the chain that selected each spec', () => {
    // "Why did this run?" must be answerable from the output.
    const affected = affectedSpecs(FEATURE_GRAPH, ['src/gyms.constants.ts']);
    expect(affected.get('tests/gyms.spec.ts')).toEqual([
      'src/gyms.constants.ts',
      'src/gyms.page.ts',
      'tests/gyms.spec.ts',
    ]);
  });

  it('selects nothing for an unrelated file', () => {
    expect(affectedSpecs(FEATURE_GRAPH, ['README.md']).size).toBe(0);
  });
});

describe('selectTests — the guards', () => {
  it('runs everything when a trigger file changes', () => {
    const selection = selectTests(FEATURE_GRAPH, ['package.json']);
    expect(selection.mode).toBe('full');
    expect(selection.fullSuiteReason).toContain('package.json');
  });

  it('runs everything above the threshold rather than skipping a handful', () => {
    const wide = graph(['a.spec.ts', 'b.spec.ts', 'c.spec.ts'], {
      'src/shared.ts': ['a.spec.ts', 'b.spec.ts'],
    });
    const selection = selectTests(wide, ['src/shared.ts'], {
      ...DEFAULT_SELECTION_CONFIG,
      runUnattributable: false,
      fullSuiteThreshold: 0.6,
    });
    expect(selection.mode).toBe('full');
    expect(selection.fullSuiteReason).toContain('threshold');
  });

  it('never drops a spec the graph cannot attribute', () => {
    // Silently losing an accessibility sweep that reads its routes from an
    // array is the failure mode that makes teams distrust selection.
    const withOrphan = graph(['tests/gyms.spec.ts', 'tests/a11y.spec.ts'], {
      'src/gyms.page.ts': ['tests/gyms.spec.ts'],
    });
    expect(unattributableSpecs(withOrphan)).toContain('tests/a11y.spec.ts');

    const selection = selectTests(withOrphan, ['src/gyms.page.ts'], {
      ...DEFAULT_SELECTION_CONFIG,
      fullSuiteThreshold: 1,
    });
    expect(selection.selected).toContain('tests/a11y.spec.ts');
  });

  it('honours always-run patterns', () => {
    const selection = selectTests(FEATURE_GRAPH, ['src/gyms.constants.ts'], {
      ...DEFAULT_SELECTION_CONFIG,
      alwaysRun: ['tests/events.spec.ts'],
      runUnattributable: false,
      fullSuiteThreshold: 1,
    });
    expect(selection.selected).toContain('tests/events.spec.ts');
    expect(selection.reasons.find(r => r.spec === 'tests/events.spec.ts')?.reason).toBe('always-run');
  });
});

describe('hub detection', () => {
  // Found against a real suite: every spec transitively imports the shared
  // Playwright config, so a page-object change legitimately reaches all of
  // them and the graph cannot discriminate.
  const ALL = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts', 'e.spec.ts'];
  const HUBBED = graph(ALL, {
    'src/config.ts': ALL,
    'src/gyms.page.ts': ['src/config.ts'],
  });

  it('ignores a "hub" in a project too small for the notion to mean anything', () => {
    // In a two-spec project anything reaching one spec is 50%. Calling that a
    // hub would suppress selection entirely on tiny suites.
    const tiny = graph(['a.spec.ts', 'b.spec.ts'], { 'src/x.ts': ['a.spec.ts', 'b.spec.ts'] });
    expect(hubFiles(tiny)).toEqual([]);
  });

  it('finds the file nearly every spec depends on', () => {
    const hubs = hubFiles(HUBBED);
    expect(hubs[0]?.file).toBe('src/config.ts');
    expect(hubs[0]?.reach).toBe(1);
  });

  it('detects when a change reaches specs only through a hub', () => {
    const paths = affectedSpecs(HUBBED, ['src/gyms.page.ts']);
    expect(reachesOnlyViaHubs(paths, hubFiles(HUBBED))).toBe(true);
  });

  it('runs the full suite and SAYS WHY rather than reporting a hollow selection', () => {
    // Presenting "3/3 selected" as narrowing would be a number that looks
    // like insight and is not.
    const selection = selectTests(HUBBED, ['src/gyms.page.ts']);
    expect(selection.mode).toBe('full');
    expect(selection.fullSuiteReason).toContain('src/config.ts');
    expect(selection.fullSuiteReason).toContain('runtime coverage');
    expect(selection.hubs.length).toBeGreaterThan(0);
  });

  it('still narrows when the path avoids the hub', () => {
    const mixed = graph(ALL, {
      'src/config.ts': ALL,
      'tests/data.ts': ['a.spec.ts'],
    });
    const selection = selectTests(mixed, ['tests/data.ts'], {
      ...DEFAULT_SELECTION_CONFIG,
      runUnattributable: false,
      fullSuiteThreshold: 1,
    });
    expect(selection.mode).toBe('partial');
    expect(selection.selected).toEqual(['a.spec.ts']);
  });
});

describe('route-based selection — narrowing past a fixture barrel', () => {
  const ALL_SPECS = ['tests/gyms.spec.ts', 'tests/events.spec.ts'];
  // Every spec imports the barrel, so the import graph says each depends on
  // both features. That is true, and useless.
  const BARRELLED = graph(ALL_SPECS, {
    'src/fixtures.ts': ALL_SPECS,
    'src/gyms.page.ts': ['src/fixtures.ts'],
    'src/events.page.ts': ['src/fixtures.ts'],
  });

  const ownership = new Map([
    ['src/gyms.page.ts', new Set(['/gyms'])],
    ['src/events.page.ts', new Set(['/events'])],
  ]);
  const coverage = new Map([
    ['tests/gyms.spec.ts', new Set(['/gyms'])],
    ['tests/events.spec.ts', new Set(['/events'])],
  ]);

  it('narrows to the spec that visited the affected route', () => {
    const selection = selectTests(
      BARRELLED,
      ['src/gyms.page.ts'],
      { ...DEFAULT_SELECTION_CONFIG, fullSuiteThreshold: 1 },
      { ownership, coverage },
    );

    expect(selection.mode).toBe('partial');
    expect(selection.selected).toEqual(['tests/gyms.spec.ts']);
    expect(selection.reasons[0]?.reason).toBe('visited-route');
    expect(selection.reasons[0]?.via).toEqual(['/gyms']);
  });

  it('never selects a spec the suite does not contain', () => {
    // Coverage can name a deleted file or a path in another form. Selecting it
    // is how "3/2 specs selected" happens.
    const stale = new Map(coverage);
    stale.set('tests/deleted.spec.ts', new Set(['/gyms']));

    const selection = selectTests(
      BARRELLED,
      ['src/gyms.page.ts'],
      { ...DEFAULT_SELECTION_CONFIG, fullSuiteThreshold: 1 },
      { ownership, coverage: stale },
    );
    expect(selection.selected.length).toBeLessThanOrEqual(selection.totalSpecs);
    expect(selection.selected).not.toContain('tests/deleted.spec.ts');
  });

  it('always runs a spec with no recorded coverage', () => {
    const partial = new Map([['tests/gyms.spec.ts', new Set(['/gyms'])]]);
    const selection = selectTests(
      BARRELLED,
      ['src/gyms.page.ts'],
      { ...DEFAULT_SELECTION_CONFIG, fullSuiteThreshold: 1 },
      { ownership, coverage: partial },
    );
    expect(selection.selected).toContain('tests/events.spec.ts');
    expect(selection.reasons.find(r => r.spec === 'tests/events.spec.ts')?.reason).toBe('no-coverage');
  });

  it('falls back to the import graph when the diff owns no route', () => {
    // "No spec matched" and "this method does not apply" are different answers.
    const selection = selectTests(
      BARRELLED,
      ['src/util.ts'],
      DEFAULT_SELECTION_CONFIG,
      { ownership, coverage },
    );
    expect(selection.reasons.every(r => r.reason !== 'visited-route')).toBe(true);
  });
});

describe('normaliseRoute', () => {
  it('reduces a URL to its path', () => {
    expect(normaliseRoute('http://localhost:8080/gyms?q=x')).toBe('/gyms');
    expect(normaliseRoute('/gyms?q=1')).toBe('/gyms');
    expect(normaliseRoute('/gyms')).toBe('/gyms');
  });

  it('rejects non-http schemes rather than inventing a route', () => {
    // about:blank normalised to the pathname "blank" and was recorded as
    // though the test had visited a page by that name.
    expect(normaliseRoute('about:blank')).toBeNull();
    expect(normaliseRoute('data:text/html,<p>x</p>')).toBeNull();
  });
});
