import { describe, expect, it } from 'vitest';

import { quarantineCodemod, releaseCodemod } from '../src/codemod.js';

const FILE = 'tests/features/gyms/gyms.ui.acceptance.spec.ts';

describe('quarantineCodemod — the three tag shapes in the wild', () => {
  it('given a test carrying an existing tag array -> when quarantineCodemod applies -> then @quarantine is appended to that array', { tags: ['@unit', '@flaky'] }, () => {
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

  it('given a test whose tag is a single string -> when quarantineCodemod applies -> then the tag is widened into an array holding both', { tags: ['@unit', '@flaky'] }, () => {
    const source = `test('a test', { tag: '@acceptance' }, async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('applied');
    expect(result.after).toContain("tag: ['@acceptance', '@quarantine']");
  });

  it('given a test with no options object -> when quarantineCodemod applies -> then an options object is inserted between the title and the callback, leaving the body intact', { tags: ['@unit', '@flaky'] }, () => {
    const source = `test('a test', async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('applied');
    expect(result.after).toContain("{ tag: ['@quarantine'] }");
    // The body must survive intact — an options object is inserted between the
    // title and the callback, never over it.
    expect(result.after).toContain('async () => {}');
  });

  it('given a test whose options object carries no tag -> when quarantineCodemod applies -> then a tag property is added alongside the existing options', { tags: ['@unit', '@flaky'] }, () => {
    const source = `test('a test', { timeout: 5000 }, async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('applied');
    expect(result.after).toContain('timeout: 5000');
    expect(result.after).toContain("tag: ['@quarantine']");
  });
});

describe('quarantineCodemod — safety', () => {
  it('given a test already tagged @quarantine -> when quarantineCodemod applies -> then the status is already-tagged and nothing is rewritten', { tags: ['@unit', '@flaky'] }, () => {
    const source = `test('a test', { tag: ['@quarantine'] }, async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('already-tagged');
    expect(result.after).toBeNull();
  });

  it('given two tests sharing one title -> when quarantineCodemod applies -> then the status is ambiguous and a line number is requested', { tags: ['@unit', '@flaky'] }, () => {
    // Silently tagging the first match would quarantine the wrong test.
    const source = `
test('duplicate', async () => {});
test('duplicate', async () => {});
`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'duplicate' });

    expect(result.status).toBe('ambiguous');
    expect(result.message).toContain('line number');
  });

  it('given two tests sharing one title and a line number -> when quarantineCodemod applies -> then the test on that line is tagged', { tags: ['@unit', '@flaky'] }, () => {
    const source = `test('duplicate', async () => {});
test('duplicate', async () => {});
`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'duplicate', line: 2 });

    expect(result.status).toBe('applied');
    expect(result.line).toBe(2);
  });

  it('given a title matching a describe block rather than a test -> when quarantineCodemod applies -> then the status is not-found, so a whole suite is never silenced', { tags: ['@unit', '@flaky'] }, () => {
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

  it('given a title matching no test -> when quarantineCodemod applies -> then the status is not-found and nothing is rewritten', { tags: ['@unit', '@flaky'] }, () => {
    const source = `test('a different test', async () => {});`;
    const result = quarantineCodemod(source, { file: FILE, testTitle: 'missing' });

    expect(result.status).toBe('not-found');
    expect(result.after).toBeNull();
  });

  it('given a file holding several tagged tests -> when quarantineCodemod tags one -> then the imports and the sibling tests are left untouched', { tags: ['@unit', '@flaky'] }, () => {
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
  it('given comment lines describing the quarantine -> when quarantineCodemod applies -> then a block comment carrying them is written above the tagged test', { tags: ['@unit', '@flaky'] }, () => {
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

  it('given a test nested inside a describe block -> when quarantineCodemod writes the comment -> then the comment and the test keep the original indentation', { tags: ['@unit', '@flaky'] }, () => {
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

  it('given a test at the top level -> when quarantineCodemod writes the comment -> then the comment and the test stay at column zero', { tags: ['@unit', '@flaky'] }, () => {
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
  it('given a test tagged @quarantine alongside another tag -> when releaseCodemod applies -> then @quarantine is removed and the other tag survives', { tags: ['@unit', '@flaky'] }, () => {
    const source = `test('a test', { tag: ['@acceptance', '@quarantine'] }, async () => {});`;
    const result = releaseCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('applied');
    expect(result.after).toContain("'@acceptance'");
    expect(result.after).not.toContain('@quarantine');
  });

  it('given a test carrying no @quarantine tag -> when releaseCodemod applies -> then the status is not-found', { tags: ['@unit', '@flaky'] }, () => {
    const source = `test('a test', { tag: ['@acceptance'] }, async () => {});`;
    const result = releaseCodemod(source, { file: FILE, testTitle: 'a test' });

    expect(result.status).toBe('not-found');
  });

  it('given a test quarantined then released -> when both codemods have run -> then the source matches the original', { tags: ['@unit', '@flaky'] }, () => {
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

  it('given a title generated by a loop over a template literal -> when quarantineCodemod applies -> then the status is parameterised, naming the line, rather than a bogus not-found', { tags: ['@unit', '@flaky'] }, () => {
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

  it('given a parameterised test matched by title -> when quarantineCodemod applies -> then the message explains that tagging would quarantine every generated case', { tags: ['@unit', '@flaky'] }, () => {
    const result = quarantineCodemod(REAL_SHAPE, {
      file: 'tests/layout/footer.ui.acceptance.spec.ts',
      testTitle: 'Given the footer, when a visitor selects "Stores", then /stores is opened',
    });

    expect(result.message).toContain('quarantine all of them');
    expect(result.message).toContain('not the right lever');
  });

  it('given a title whose static fragments do not line up with any template -> when quarantineCodemod applies -> then the status is not-found', { tags: ['@unit', '@flaky'] }, () => {
    const result = quarantineCodemod(REAL_SHAPE, {
      file: 'tests/layout/footer.ui.acceptance.spec.ts',
      testTitle: 'Given a gym name, when a visitor searches, then the gym is displayed',
    });

    expect(result.status).toBe('not-found');
  });

  it('given a title written as a template literal with no substitutions -> when quarantineCodemod applies -> then the test is tagged', { tags: ['@unit', '@flaky'] }, () => {
    const source = 'test(`a plain title`, { tag: [`@acceptance`] }, async () => {});';
    const result = quarantineCodemod(source, { file: 'x.spec.ts', testTitle: 'a plain title' });
    expect(result.status).toBe('applied');
  });
});
