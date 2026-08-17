import { describe, expect, it } from 'vitest';

import { escapeForGrep } from '../src/spawn.js';

describe('escapeForGrep', () => {
  it('escapes regex metacharacters so a title matches literally', () => {
    // Playwright's -g takes a regex; test titles routinely contain parentheses
    // and dots, which would otherwise silently match the wrong tests.
    expect(escapeForGrep('a test (with parens) and a. dot')).toBe(
      'a test \\(with parens\\) and a\\. dot',
    );
  });

  it('leaves ordinary titles untouched', () => {
    const title = 'Given a gym name, when a visitor searches, then only that gym is displayed';
    expect(escapeForGrep(title)).toBe(title);
  });
});
