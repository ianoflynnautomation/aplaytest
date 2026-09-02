import { describe, expect, it } from 'vitest';

import { escapeForGrep } from '../src/spawn.js';

describe('escapeForGrep', () => {
  it('given a test title containing regex metacharacters -> when escapeForGrep escapes it -> then the title matches literally', { tags: ['@unit', '@runner'] }, () => {
    // Playwright's -g takes a regex; test titles routinely contain parentheses
    // and dots, which would otherwise silently match the wrong tests.
    expect(escapeForGrep('a test (with parens) and a. dot')).toBe(
      'a test \\(with parens\\) and a\\. dot',
    );
  });

  it('given a title containing no metacharacters -> when escapeForGrep escapes it -> then the title is unchanged', { tags: ['@unit', '@runner'] }, () => {
    const title = 'Given a gym name, when a visitor searches, then only that gym is displayed';
    expect(escapeForGrep(title)).toBe(title);
  });
});
