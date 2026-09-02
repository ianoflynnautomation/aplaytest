import { describe, expect, it } from 'vitest';

import { REDACTED, redact, redactString, redactUrl } from '../src/evidence/redact.js';

const KEYS = ['password', 'token', 'authorization', 'cookie', 'secret', 'api-key'];

describe('redactString', () => {
  it('given free text carrying a bearer token under no recognised key -> when redactString runs -> then the token is replaced with the redaction marker', { tags: ['@unit', '@evidence-redact'] }, () => {
    // Secrets do not always arrive under an obvious key, so the value shape
    // is scanned too.
    const out = redactString('Sent header Bearer abcdefghijklmnop1234', KEYS);
    expect(out).not.toContain('abcdefghijklmnop1234');
    expect(out).toContain(REDACTED);
  });

  it('given free text carrying a JWT -> when redactString runs -> then the JWT is removed', { tags: ['@unit', '@evidence-redact'] }, () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactString(`token was ${jwt} ok`, KEYS)).not.toContain(jwt);
  });

  it('given an api-key=value pair -> when redactString runs -> then the value is removed', { tags: ['@unit', '@evidence-redact'] }, () => {
    expect(redactString('api-key=supersecretvalue', KEYS)).not.toContain('supersecretvalue');
  });

  it('given text carrying no secrets -> when redactString runs -> then the text is returned unchanged', { tags: ['@unit', '@evidence-redact'] }, () => {
    const text = 'Expected string: "Gyms" Received string: "BJJ Gyms"';
    expect(redactString(text, KEYS)).toBe(text);
  });
});

describe('redact (deep)', () => {
  it('given a nested structure holding an authorization header -> when redact walks it -> then the value under the matching key is replaced with the redaction marker', { tags: ['@unit', '@evidence-redact'] }, () => {
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

  it('given keys differing in case and carrying a secret name as a substring -> when redact walks them -> then both values are redacted', { tags: ['@unit', '@evidence-redact'] }, () => {
    const out = redact({ Authorization: 'x', X_API_KEY_HEADER: 'y' }, KEYS) as Record<string, string>;
    expect(out['Authorization']).toBe(REDACTED);
    expect(out['X_API_KEY_HEADER']).toBe(REDACTED);
  });

  it('given a structure containing a cycle -> when redact walks it -> then it returns without blowing the stack', { tags: ['@unit', '@evidence-redact'] }, () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic, KEYS)).not.toThrow();
  });

  it('given a structure holding no secrets -> when redact walks it -> then the structure is returned unchanged', { tags: ['@unit', '@evidence-redact'] }, () => {
    const input = { kind: 'locator_not_found', testIdsPresent: ['gym-card-title'], count: 3 };
    expect(redact(input, KEYS)).toEqual(input);
  });
});

describe('redactUrl', () => {
  it('given a URL carrying an access_token query parameter -> when redactUrl runs -> then the token is scrubbed and the other parameters stay readable', { tags: ['@unit', '@evidence-redact'] }, () => {
    const out = redactUrl('https://api.example.ie/gyms?county=Cork&access_token=abc123', KEYS);
    expect(out).toContain('county=Cork');
    expect(out).not.toContain('abc123');
  });

  it('given a string that does not parse as a URL -> when redactUrl runs -> then it falls back to string scrubbing and removes the token', { tags: ['@unit', '@evidence-redact'] }, () => {
    expect(redactUrl('not a url token=abc123def', KEYS)).not.toContain('abc123def');
  });
});

describe('redactString — ordering', () => {
  it('given an Authorization header whose bearer token follows the matched key -> when redactString runs -> then the token is removed rather than the anchor destroyed', { tags: ['@unit', '@evidence-redact'] }, () => {
    // REGRESSION GUARD, found through the MCP layer: running key patterns
    // first rewrote `Authorization: Bearer <token>` to
    // `Authorization: [redacted] <token>` — destroying the anchor the bearer
    // pattern needed, and leaking the credential.
    const out = redactString('Authorization: Bearer secret-token-value-here', KEYS);
    expect(out).not.toContain('secret-token-value-here');
  });

  it('given an authorization header with a bearer token -> when redactString runs -> then the token is removed and the Bearer scheme word is kept', { tags: ['@unit', '@evidence-redact'] }, () => {
    const out = redactString('authorization: Bearer abcdefghijklmnop', KEYS);
    expect(out).toContain('Bearer');
    expect(out).not.toContain('abcdefghijklmnop');
  });

  it('given an Authorization header using the Basic scheme -> when redactString runs -> then the encoded credential is removed', { tags: ['@unit', '@evidence-redact'] }, () => {
    expect(redactString('Authorization: Basic dXNlcjpwYXNzd29yZA==', KEYS)).not.toContain(
      'dXNlcjpwYXNzd29yZA',
    );
  });

  it('given a token=value pair carrying no auth scheme -> when redactString runs -> then the value is removed', { tags: ['@unit', '@evidence-redact'] }, () => {
    expect(redactString('token=abcdef123456', KEYS)).not.toContain('abcdef123456');
  });
});
