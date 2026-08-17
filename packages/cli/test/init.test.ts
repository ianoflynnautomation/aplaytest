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
   * so it produced `['list',\n ['@atest/…'],],` — a config that no longer
   * parses, written to disk by --apply. An edit tool that corrupts the file it
   * was pointed at is worse than one that declines to edit.
   */
  it('appends after the LAST entry, not inside the first one', () => {
    const out = applied(CONFIG);
    expect(out).toContain("['list'],");
    expect(out).toContain("['html', { open: 'never' }],");
    expect(out).toContain("['@atest/runner-playwright/reporter'],");
    expect(out).not.toContain("['list',\n");
  });

  it('keeps the file syntactically valid', () => {
    const body = applied(CONFIG).replace(/^import.*$/m, '').replace('export default defineConfig', 'const c = (x=>x)');
    expect(() => new Function(body)).not.toThrow();
  });

  it('is not fooled by a bracket inside a string', () => {
    const tricky = CONFIG.replace("{ open: 'never' }", "{ outputFolder: 'reports/a[1]' }");
    const out = applied(tricky);
    expect(out).toContain("'reports/a[1]'");
    expect(out.indexOf('@atest')).toBeGreaterThan(out.indexOf('a[1]'));
  });

  it('promotes a single string reporter to an array', () => {
    const out = applied(`export default defineConfig({ reporter: 'list' });`);
    expect(out).toContain("[['list'], ['@atest/runner-playwright/reporter']]");
  });

  it('handles an empty reporter array', () => {
    expect(applied(`export default defineConfig({ reporter: [] });`)).toContain('@atest');
  });

  it('is idempotent — a second run is a no-op', () => {
    expect(addReporter(applied(CONFIG))).toBe('already present');
  });

  it('DECLINES a computed reporter rather than rewriting it', () => {
    // The shape real repos reach once they have several environments. Guessing
    // here produces a config that still parses and no longer does what its
    // author meant.
    const computed = `export default defineConfig({ reporter: activeReporters() });`;
    expect(addReporter(computed)).toContain('computed');
  });

  it('says so plainly when the file has no reporter key', () => {
    expect(addReporter(`export default defineConfig({ testDir: './tests' });`)).toContain(
      'no reporter key',
    );
  });

  it('declines an unterminated array instead of guessing', () => {
    expect(addReporter(`export default defineConfig({ reporter: [['list'],`)).toContain(
      'not closed',
    );
  });
});

describe('removeReporter', () => {
  it('round-trips exactly — undo must restore the original file', () => {
    expect(removeReporter(applied(CONFIG))).toBe(CONFIG);
  });

  /**
   * REGRESSION GUARD, and the more dangerous of the two init bugs.
   *
   * Undo dropped whole LINES containing the atest entry. That is fine for the
   * array form, where the entry owns its line. For a config that started as
   * `reporter: 'list'` — promoted on the way in to
   * `reporter: [['list'], ['@atest/…']],` — it deleted the whole line, taking
   * the user's own reporter with it and leaving a config with no reporter key.
   * Undo must never remove something the user wrote.
   */
  it('does not delete the user\'s own reporter when promoted inline', () => {
    const single = `export default defineConfig({ reporter: 'list' });`;
    const restored = removeReporter(applied(single));
    expect(restored).toContain("reporter: 'list'");
    expect(restored).toBe(single);
  });

  it('leaves an unrelated reporter on the same line alone', () => {
    const inline = `export default defineConfig({ reporter: [['list'], ['json']] });`;
    const out = removeReporter(applied(inline));
    expect(out).toContain("['list']");
    expect(out).toContain("['json']");
    expect(out).not.toContain('@atest');
  });

  it('leaves a config it never touched alone', () => {
    expect(removeReporter(CONFIG)).toBe(CONFIG);
  });
});

describe('matchingBracket', () => {
  it('finds the matching close across nesting', () => {
    const s = '[["a"], ["b"]]';
    expect(matchingBracket(s, 0)).toBe(s.length - 1);
  });

  it('ignores brackets inside strings', () => {
    const s = `['a]b', 'c']`;
    expect(matchingBracket(s, 0)).toBe(s.length - 1);
  });

  it('ignores brackets inside comments', () => {
    const s = "[\n  // ]\n  'a',\n  /* ] */\n]";
    expect(matchingBracket(s, 0)).toBe(s.length - 1);
  });

  it('handles an escaped quote inside a string', () => {
    const s = `['a\\'] b', 'c']`;
    expect(matchingBracket(s, 0)).toBe(s.length - 1);
  });

  it('returns -1 when unterminated', () => {
    expect(matchingBracket("[['a'],", 0)).toBe(-1);
  });
});
