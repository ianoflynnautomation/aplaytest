import { describe, expect, it } from 'vitest';

import { addReporter, matchingBracket, removeReporter } from '../src/commands/init.js';

const CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
});
`;

const applied = (source: string): string => {
  const result = addReporter(source);
  if (typeof result === 'string') throw new Error(`expected an edit, got: ${result}`);
  return result.text;
};

describe('addReporter', () => {
  /**
   * REGRESSION GUARD. The first implementation used a non-greedy
   * `[\s\S]*?\]` to find the end of the reporter array. For
   * `reporter: [['list'], ['html']]` that stops at the `]` closing `['list']`,
   * so it produced `['list',\n ['@aplaytest/…'],],` — a config that no longer
   * parses, written to disk by --apply. An edit tool that corrupts the file it
   * was pointed at is worse than one that declines to edit.
   */
  it('given a reporter array holding several entries -> when addReporter appends -> then the entry lands after the last one rather than inside the first', { tags: ['@unit', '@cli'] }, () => {
    const out = applied(CONFIG);
    expect(out).toContain("['list'],");
    expect(out).toContain("['html', { open: 'never' }],");
    expect(out).toContain("['@aplaytest/runner-playwright/reporter'],");
    expect(out).not.toContain("['list',\n");
  });

  it('given a Playwright config carrying a reporter array -> when addReporter appends -> then the file stays syntactically valid', { tags: ['@unit', '@cli'] }, () => {
    const body = applied(CONFIG).replace(/^import.*$/m, '').replace('export default defineConfig', 'const c = (x=>x)');
    expect(() => new Function(body)).not.toThrow();
  });

  it('given a reporter array whose strings contain brackets -> when addReporter appends -> then the real array end is found', { tags: ['@unit', '@cli'] }, () => {
    const tricky = CONFIG.replace("{ open: 'never' }", "{ outputFolder: 'reports/a[1]' }");
    const out = applied(tricky);
    expect(out).toContain("'reports/a[1]'");
    expect(out.indexOf('@aplaytest')).toBeGreaterThan(out.indexOf('a[1]'));
  });

  it('given a reporter declared as a single string -> when addReporter appends -> then the reporter is promoted to an array holding both', { tags: ['@unit', '@cli'] }, () => {
    const out = applied(`export default defineConfig({ reporter: 'list' });`);
    expect(out).toContain("[['list'], ['@aplaytest/runner-playwright/reporter']]");
  });

  it('given an empty reporter array -> when addReporter appends -> then the entry is added', { tags: ['@unit', '@cli'] }, () => {
    expect(applied(`export default defineConfig({ reporter: [] });`)).toContain('@aplaytest');
  });

  it('given a config where the reporter is already present -> when addReporter runs again -> then nothing changes', { tags: ['@unit', '@cli'] }, () => {
    expect(addReporter(applied(CONFIG))).toBe('already present');
  });

  it('given a reporter built by a computed expression -> when addReporter runs -> then it declines rather than rewriting it', { tags: ['@unit', '@cli'] }, () => {
    // The shape real repos reach once they have several environments. Guessing
    // here produces a config that still parses and no longer does what its
    // author meant.
    const computed = `export default defineConfig({ reporter: activeReporters() });`;
    expect(addReporter(computed)).toContain('computed');
  });

  it('given a config carrying no reporter key -> when addReporter runs -> then it reports that plainly', { tags: ['@unit', '@cli'] }, () => {
    expect(addReporter(`export default defineConfig({ testDir: './tests' });`)).toContain(
      'no reporter key',
    );
  });

  it('given a config whose reporter array is unterminated -> when addReporter runs -> then it declines rather than guessing where it ends', { tags: ['@unit', '@cli'] }, () => {
    expect(addReporter(`export default defineConfig({ reporter: [['list'],`)).toContain(
      'not closed',
    );
  });
});

describe('removeReporter', () => {
  it('given a config with the reporter added -> when removeReporter undoes it -> then the original file is restored exactly', { tags: ['@unit', '@cli'] }, () => {
    expect(removeReporter(applied(CONFIG))).toBe(CONFIG);
  });

  /**
   * REGRESSION GUARD, and the more dangerous of the two init bugs.
   *
   * Undo dropped whole LINES containing the atest entry. That is fine for the
   * array form, where the entry owns its line. For a config that started as
   * `reporter: 'list'` — promoted on the way in to
   * `reporter: [['list'], ['@aplaytest/…']],` — it deleted the whole line, taking
   * the user's own reporter with it and leaving a config with no reporter key.
   * Undo must never remove something the user wrote.
   */
  it('given a promoted inline array holding a user reporter -> when removeReporter runs -> then only the atest entry is removed', { tags: ['@unit', '@cli'] }, () => {
    const single = `export default defineConfig({ reporter: 'list' });`;
    const restored = removeReporter(applied(single));
    expect(restored).toContain("reporter: 'list'");
    expect(restored).toBe(single);
  });

  it('given an unrelated reporter sharing the line -> when removeReporter runs -> then that reporter is left alone', { tags: ['@unit', '@cli'] }, () => {
    const inline = `export default defineConfig({ reporter: [['list'], ['json']] });`;
    const out = removeReporter(applied(inline));
    expect(out).toContain("['list']");
    expect(out).toContain("['json']");
    expect(out).not.toContain('@aplaytest');
  });

  it('given a config the tool never modified -> when removeReporter runs -> then the config is unchanged', { tags: ['@unit', '@cli'] }, () => {
    expect(removeReporter(CONFIG)).toBe(CONFIG);
  });
});

describe('matchingBracket', () => {
  it('given nested brackets -> when matchingBracket scans them -> then the matching close is found across the nesting', { tags: ['@unit', '@cli'] }, () => {
    const s = '[["a"], ["b"]]';
    expect(matchingBracket(s, 0)).toBe(s.length - 1);
  });

  it('given brackets inside string literals -> when matchingBracket scans them -> then those brackets are ignored', { tags: ['@unit', '@cli'] }, () => {
    const s = `['a]b', 'c']`;
    expect(matchingBracket(s, 0)).toBe(s.length - 1);
  });

  it('given brackets inside comments -> when matchingBracket scans them -> then those brackets are ignored', { tags: ['@unit', '@cli'] }, () => {
    const s = "[\n  // ]\n  'a',\n  /* ] */\n]";
    expect(matchingBracket(s, 0)).toBe(s.length - 1);
  });

  it('given a string containing an escaped quote -> when matchingBracket scans it -> then the escaped quote does not end the string', { tags: ['@unit', '@cli'] }, () => {
    const s = `['a\\'] b', 'c']`;
    expect(matchingBracket(s, 0)).toBe(s.length - 1);
  });

  it('given an unterminated bracket -> when matchingBracket scans it -> then it returns -1', { tags: ['@unit', '@cli'] }, () => {
    expect(matchingBracket("[['a'],", 0)).toBe(-1);
  });
});
