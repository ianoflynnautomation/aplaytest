import { describe, expect, it } from 'vitest';

import { quarantineCodemod, releaseCodemod } from '../src/codemod.js';

const FILE = 'tests/features/gyms/gyms.ui.acceptance.spec.ts';

describe('quarantineCodemod — the three tag shapes in the wild', () => {
  it('pushes onto an existing tag array', () => {
    const source = `
test(
  'Given a gym name, when a visitor searches, then only that gym is displayed',
  { tag: ['@smoke', '@acceptance'] },
  async ({ gymsPage }) => {},
);
`;
    const result = quarantineCodemod(source, {
      file: FILE,
      testTitle: 'Given a gym name, when a visitor searches, then only that gym is displayed',
    });

    expect(result.status).toBe('applied');
    expect(result.after).toContain("'@smoke', '@acceptance', '@quarantine'");
  });

  it('widens a single string tag into an array', () => {
    const source = `test('a test', { tag: '@acceptance' }, async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('applied');
    expect(result.after).toContain("tag: ['@acceptance', '@quarantine']");
  });

  it('creates an options object when the test has none', () => {
    const source = `test('a test', async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('applied');
    expect(result.after).toContain("{ tag: ['@quarantine'] }");
    // The body must survive intact — an options object is inserted between the
    // title and the callback, never over it.
    expect(result.after).toContain('async () => {}');
  });

  it('adds a tag property to an options object that has none', () => {
    const source = `test('a test', { timeout: 5000 }, async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('applied');
    expect(result.after).toContain('timeout: 5000');
    expect(result.after).toContain("tag: ['@quarantine']");
  });
});

describe('quarantineCodemod — safety', () => {
  it('is idempotent', () => {
    const source = `test('a test', { tag: ['@quarantine'] }, async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('already-tagged');
    expect(result.after).toBeNull();
  });

  it('refuses rather than guessing when a title is ambiguous', () => {
    // Silently tagging the first match would quarantine the wrong test.
    const source = `
test('duplicate', async () => {});
test('duplicate', async () => {});
`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'duplicate' });

    expect(result.status).toBe('ambiguous');
    expect(result.message).toContain('line number');
  });

  it('resolves ambiguity with a line number', () => {
    const source = `test('duplicate', async () => {});
test('duplicate', async () => {});
`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'duplicate', line: 2 });

    expect(result.status).toBe('applied');
    expect(result.line).toBe(2);
  });

  it('never tags a describe block', () => {
    // A request to quarantine one test must not silence a whole suite.
    const source = `
test.describe('Gyms UI acceptance', { tag: ['@gyms'] }, () => {
  test('a test', async () => {});
});
`;
    const result = quarantineCodemod(source, {
      file: FILE,
      testTitle: 'Gyms UI acceptance',
    });

    expect(result.status).toBe('not-found');
  });

  it('reports not-found instead of editing something else', () => {
    const source = `test('a different test', async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'missing' });

    expect(result.status).toBe('not-found');
    expect(result.after).toBeNull();
  });

  it('leaves the rest of the file untouched', () => {
    const source = `import { test } from '@ui/fixtures';

test('first', { tag: ['@acceptance'] }, async () => {});
test('second', { tag: ['@acceptance'] }, async () => {});
`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'second' });

    expect(result.after).toContain("import { test } from '@ui/fixtures';");
    expect(result.after).toContain("test('first', { tag: ['@acceptance'] }");
    expect(result.after).not.toContain("test('first', { tag: ['@acceptance', '@quarantine']");
  });
});

describe('quarantineCodemod — the comment', () => {
  it('writes a self-documenting block above the test', () => {
    const source = `test('a test', { tag: ['@acceptance'] }, async () => {});`;
    const result = quarantineCodemod(source, {
      file: FILE,
      testTitle: 'a test',
      comment: [
        'firefox nav race under parallel load',
        'flakeScore 0.34 · class resource-contention',
        'expires 2026-08-30  ·  https://example/issues/214',
      ],
    });

    expect(result.after).toContain('/**');
    expect(result.after).toContain('* firefox nav race under parallel load');
    expect(result.after).toContain('* expires 2026-08-30');
    // Comment above, tag on the test — both present.
    expect(result.after).toContain("'@acceptance', '@quarantine'");
  });

  it('indents the comment to match the test, and leaves the test indented', () => {
    // Asserted line-by-line, not with toContain: a substring check passes even
    // when the indentation is wrong, which is exactly how the first version of
    // this shipped with `test(` pushed to column zero.
    const source = `test.describe('suite', () => {
  test('a test', { tag: ['@acceptance'] }, async () => {});
});
`;
    const result = quarantineCodemod(source, {
      file: FILE,
      testTitle: 'a test',
      comment: ['quarantined'],
    });

    const lines = (result.after ?? '').split('\n');
    expect(lines[1]).toBe('  /**');
    expect(lines[2]).toBe('   * quarantined');
    expect(lines[3]).toBe('   */');
    expect(lines[4]).toBe("  test('a test', { tag: ['@acceptance', '@quarantine'] }, async () => {});");
  });

  it('keeps a top-level test at column zero', () => {
    const source = `test('a test', { tag: ['@acceptance'] }, async () => {});`;
    const result = quarantineCodemod(source, {
      file: FILE,
      testTitle: 'a test',
      comment: ['quarantined'],
    });

    const lines = (result.after ?? '').split('\n');
    expect(lines[0]).toBe('/**');
    expect(lines[1]).toBe(' * quarantined');
    expect(lines[2]).toBe(' */');
    expect(lines[3]).toBe("test('a test', { tag: ['@acceptance', '@quarantine'] }, async () => {});");
  });
});

describe('releaseCodemod', () => {
  it('removes the tag again', () => {
    const source = `test('a test', { tag: ['@acceptance', '@quarantine'] }, async () => {});`;
    const result = releaseCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('applied');
    expect(result.after).toContain("'@acceptance'");
    expect(result.after).not.toContain('@quarantine');
  });

  it('reports when there is nothing to remove', () => {
    const source = `test('a test', { tag: ['@acceptance'] }, async () => {});`;
    const result = releaseCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('not-found');
  });

  it('round-trips with the quarantine codemod', () => {
    const original = `test('a test', { tag: ['@acceptance'] }, async () => {});`;
    const quarantined = quarantineCodemod(original, { file: FILE, testTitle: 'a test' });
    const released = releaseCodemod(quarantined.after ?? '', { file: FILE, testTitle: 'a test' });

    expect(released.after?.replace(/\s+/g, ' ').trim()).toBe(
      original.replace(/\s+/g, ' ').trim(),
    );
  });
});

describe('quarantineCodemod — parameterised tests', () => {
  // Found by pointing the codemod at a real suite: the actual flaky test in
  // bjjeire-tests is generated in a for-loop with a template-literal title.
  const REAL_SHAPE = `
test.describe('Footer UI acceptance', { tag: ['@layout'] }, () => {
  for (const { name, path } of FOOTER_QUICK_LINKS) {
    test(
      \`Given the footer, when a visitor selects "\${name}", then \${path} is opened\`,
      { tag: '@acceptance' },
      async ({ page }) => {},
    );
  }
});
`;

  it('recognises a loop-generated title instead of reporting a bogus not-found', () => {
    // "not found" would read as "your title is wrong" and send someone hunting
    // a typo that does not exist.
    const result = quarantineCodemod(REAL_SHAPE, {
      file: 'tests/layout/footer.ui.acceptance.spec.ts',
      testTitle: 'Given the footer, when a visitor selects "Stores", then /stores is opened',
    });

    expect(result.status).toBe('parameterised');
    expect(result.after).toBeNull();
    expect(result.line).toBeGreaterThan(0);
  });

  it('explains that tagging would quarantine every generated case', () => {
    const result = quarantineCodemod(REAL_SHAPE, {
      file: 'tests/layout/footer.ui.acceptance.spec.ts',
      testTitle: 'Given the footer, when a visitor selects "Stores", then /stores is opened',
    });

    expect(result.message).toContain('quarantine all of them');
    expect(result.message).toContain('not the right lever');
  });

  it('does not claim a match when the static fragments do not line up', () => {
    const result = quarantineCodemod(REAL_SHAPE, {
      file: 'tests/layout/footer.ui.acceptance.spec.ts',
      testTitle: 'Given a gym name, when a visitor searches, then the gym is displayed',
    });

    expect(result.status).toBe('not-found');
  });

  it('still tags a plain template literal with no substitutions', () => {
    const source = 'test(`a plain title`, { tag: [`@acceptance`] }, async () => {});';
    const result = quarantineCodemod(source, { file: 'x.spec.ts', testTitle: 'a plain title' });
    expect(result.status).toBe('applied');
  });
});
