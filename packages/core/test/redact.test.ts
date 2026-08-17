import { describe, expect, it } from 'vitest';

import { REDACTED, redact, redactString, redactUrl } from '../src/evidence/redact.js';

const KEYS = ['password', 'token', 'authorization', 'cookie', 'secret', 'api-key'];

describe('redactString', () => {
  it('scrubs a bearer token even when the key is not recognisable', () => {
    // Secrets do not always arrive under an obvious key, so the value shape
    // is scanned too.
    const out = redactString('Sent header Bearer abcdefghijklmnop1234', KEYS);
    expect(out).not.toContain('abcdefghijklmnop1234');
    expect(out).toContain(REDACTED);
  });

  it('scrubs a JWT anywhere in free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactString(`token was ${jwt} ok`, KEYS)).not.toContain(jwt);
  });

  it('scrubs key=value pairs', () => {
    expect(redactString('api-key=supersecretvalue', KEYS)).not.toContain('supersecretvalue');
  });

  it('leaves innocent text alone', () => {
    const text = 'Expected string: "Gyms" Received string: "BJJ Gyms"';
    expect(redactString(text, KEYS)).toBe(text);
  });
});

describe('redact (deep)', () => {
  it('replaces values under matching keys anywhere in the structure', () => {
    const out = redact(
      {
        network: {
          failed: [{ url: 'https://api/x', headers: { authorization: 'Bearer abc123def456' } }],
        },
      },
      KEYS,
    );
    expect(JSON.stringify(out)).not.toContain('abc123def456');
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  it('matches keys case-insensitively and as substrings', () => {
    const out = redact({ Authorization: 'x', X_API_KEY_HEADER: 'y' }, KEYS) as Record<string, string>;
    expect(out['Authorization']).toBe(REDACTED);
    expect(out['X_API_KEY_HEADER']).toBe(REDACTED);
  });

  it('survives a cyclic structure instead of blowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic, KEYS)).not.toThrow();
  });

  it('preserves non-secret data unchanged', () => {
    const input = { kind: 'locator_not_found', testIdsPresent: ['gym-card-title'], count: 3 };
    expect(redact(input, KEYS)).toEqual(input);
  });
});

describe('redactUrl', () => {
  it('scrubs sensitive query parameters but keeps the path readable', () => {
    const out = redactUrl('https://api.example.ie/gyms?county=Cork&access_token=abc123', KEYS);
    expect(out).toContain('county=Cork');
    expect(out).not.toContain('abc123');
  });

  it('falls back to string scrubbing for an unparseable URL', () => {
    expect(redactUrl('not a url token=abc123def', KEYS)).not.toContain('abc123def');
  });
});

describe('redactString — ordering', () => {
  it('redacts a bearer token that appears after a matching key', () => {
    // REGRESSION GUARD, found through the MCP layer: running key patterns
    // first rewrote `Authorization: Bearer <token>` to
    // `Authorization: [redacted] <token>` — destroying the anchor the bearer
    // pattern needed, and leaking the credential.
    const out = redactString('Authorization: Bearer secret-token-value-here', KEYS);
    expect(out).not.toContain('secret-token-value-here');
  });

  it('redacts the token, not the scheme word', () => {
    const out = redactString('authorization: Bearer abcdefghijklmnop', KEYS);
    expect(out).toContain('Bearer');
    expect(out).not.toContain('abcdefghijklmnop');
  });

  it('covers other auth schemes too', () => {
    expect(redactString('Authorization: Basic dXNlcjpwYXNzd29yZA==', KEYS)).not.toContain(
      'dXNlcjpwYXNzd29yZA',
    );
  });

  it('still redacts a plain key=value with no scheme', () => {
    expect(redactString('token=abcdef123456', KEYS)).not.toContain('abcdef123456');
  });
});
