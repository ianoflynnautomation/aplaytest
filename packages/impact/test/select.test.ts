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
  it('given a changed constants file two imports below a spec -> when affectedSpecs walks the graph -> then that spec is selected', { tags: ['@unit', '@impact'] }, () => {
    const affected = affectedSpecs(FEATURE_GRAPH, ['src/gyms.constants.ts']);
    expect([...affected.keys()]).toEqual(['tests/gyms.spec.ts']);
  });

  it('given a changed constants file two imports below a spec -> when affectedSpecs walks the graph -> then the import chain that selected the spec is recorded', { tags: ['@unit', '@impact'] }, () => {
    // "Why did this run?" must be answerable from the output.
    const affected = affectedSpecs(FEATURE_GRAPH, ['src/gyms.constants.ts']);
    expect(affected.get('tests/gyms.spec.ts')).toEqual([
      'src/gyms.constants.ts',
      'src/gyms.page.ts',
      'tests/gyms.spec.ts',
    ]);
  });

  it('given a changed file no spec imports -> when affectedSpecs walks the graph -> then nothing is selected', { tags: ['@unit', '@impact'] }, () => {
    expect(affectedSpecs(FEATURE_GRAPH, ['README.md']).size).toBe(0);
  });
});

describe('selectTests — the guards', () => {
  it('given a change to a trigger file such as package.json -> when selectTests runs -> then the mode is full and the reason names that file', { tags: ['@unit', '@impact'] }, () => {
    const selection = selectTests(FEATURE_GRAPH, ['package.json']);
    expect(selection.mode).toBe('full');
    expect(selection.fullSuiteReason).toContain('package.json');
  });

  it('given a change affecting more specs than the full-suite threshold -> when selectTests runs -> then the mode is full and the reason names the threshold', { tags: ['@unit', '@impact'] }, () => {
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

  it('given a spec the import graph cannot attribute -> when selectTests runs -> then that spec is still selected', { tags: ['@unit', '@impact'] }, () => {
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

  it('given an always-run pattern naming an unaffected spec -> when selectTests runs -> then that spec is selected with reason always-run', { tags: ['@unit', '@impact'] }, () => {
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

  it('given a two-spec project where one file reaches both -> when hubFiles looks for hubs -> then none is reported, because the notion is meaningless at that size', { tags: ['@unit', '@impact'] }, () => {
    // In a two-spec project anything reaching one spec is 50%. Calling that a
    // hub would suppress selection entirely on tiny suites.
    const tiny = graph(['a.spec.ts', 'b.spec.ts'], { 'src/x.ts': ['a.spec.ts', 'b.spec.ts'] });
    expect(hubFiles(tiny)).toEqual([]);
  });

  it('given a config file every spec transitively imports -> when hubFiles looks for hubs -> then that file is reported with full reach', { tags: ['@unit', '@impact'] }, () => {
    const hubs = hubFiles(HUBBED);
    expect(hubs[0]?.file).toBe('src/config.ts');
    expect(hubs[0]?.reach).toBe(1);
  });

  it('given a change reaching every spec only through the config hub -> when reachesOnlyViaHubs checks the paths -> then it reports true', { tags: ['@unit', '@impact'] }, () => {
    const paths = affectedSpecs(HUBBED, ['src/gyms.page.ts']);
    expect(reachesOnlyViaHubs(paths, hubFiles(HUBBED))).toBe(true);
  });

  it('given a change reaching every spec only through a hub -> when selectTests runs -> then the mode is full and the reason names the hub and runtime coverage', { tags: ['@unit', '@impact'] }, () => {
    // Presenting "3/3 selected" as narrowing would be a number that looks
    // like insight and is not.
    const selection = selectTests(HUBBED, ['src/gyms.page.ts']);
    expect(selection.mode).toBe('full');
    expect(selection.fullSuiteReason).toContain('src/config.ts');
    expect(selection.fullSuiteReason).toContain('runtime coverage');
    expect(selection.hubs.length).toBeGreaterThan(0);
  });

  it('given a change reaching one spec without passing through the hub -> when selectTests runs -> then the mode is partial and only that spec is selected', { tags: ['@unit', '@impact'] }, () => {
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

  it('given a fixture barrel every spec imports and route coverage per spec -> when selectTests runs -> then it narrows to the spec that visited the affected route', { tags: ['@unit', '@impact'] }, () => {
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

  it('given coverage naming a spec the suite no longer contains -> when selectTests runs -> then that spec is not selected and the count stays within the suite', { tags: ['@unit', '@impact'] }, () => {
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

  it('given a spec with no recorded route coverage -> when selectTests runs -> then it is selected with reason no-coverage', { tags: ['@unit', '@impact'] }, () => {
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

  it('given a changed file owning no route -> when selectTests runs -> then no spec is selected by visited-route and the import graph decides', { tags: ['@unit', '@impact'] }, () => {
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
  it('given absolute and relative URLs carrying query strings -> when normaliseRoute reads them -> then each reduces to its path', { tags: ['@unit', '@impact'] }, () => {
    expect(normaliseRoute('http://localhost:8080/gyms?q=x')).toBe('/gyms');
    expect(normaliseRoute('/gyms?q=1')).toBe('/gyms');
    expect(normaliseRoute('/gyms')).toBe('/gyms');
  });

  it('given about:blank or a data URL -> when normaliseRoute reads it -> then the result is null rather than an invented route', { tags: ['@unit', '@impact'] }, () => {
    // about:blank normalised to the pathname "blank" and was recorded as
    // though the test had visited a page by that name.
    expect(normaliseRoute('about:blank')).toBeNull();
    expect(normaliseRoute('data:text/html,<p>x</p>')).toBeNull();
  });
});
