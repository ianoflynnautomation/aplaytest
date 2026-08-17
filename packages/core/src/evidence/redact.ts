/**
 * Redaction.
 *
 * Evidence bundles are written to disk, uploaded as CI artifacts, and sent to
 * a model. A suite that authenticates — MSAL, OAuth, an API key header — WILL
 * capture bearer tokens in its request ledger. Scrubbing happens once, at the
 * boundary where a bundle is created, so that no downstream consumer has to
 * remember to do it.
 *
 * The rule is fail-safe: an unrecognised structure is traversed, not skipped.
 */

export const REDACTED = '[redacted]';

/**
 * Header and field names arrive in every casing and separator style —
 * `api-key`, `API_KEY`, `apiKey`, `x-api-key-header`. Comparing them
 * literally means a real credential slips through on a spelling difference,
 * so both sides are normalised to letters and digits before matching.
 */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, '');
}

/** Matches `authorization: Bearer xyz`, `"token": "xyz"`, `API_KEY=xyz`. */
function keyValuePattern(key: string): RegExp {
  // Allow any separator style between the key's own word parts.
  const flexible = key
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[-_\s]+/g, '[-_\\s]?');
  // The value group optionally swallows an auth scheme, so
  // `Authorization: Bearer <token>` redacts the token rather than the word
  // "Bearer".
  return new RegExp(
    `(["']?${flexible}["']?\\s*[:=]\\s*["']?)((?:Bearer|Basic|Token)\\s+)?([^"'\\s,;&}]+)`,
    'gi',
  );
}

/** Matches a bearer token anywhere, even without a recognisable key. */
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi;

/** Matches a JWT anywhere — three base64url segments. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

export function redactString(input: string, keys: readonly string[]): string {
  // ORDER IS LOAD-BEARING: value patterns run BEFORE key patterns.
  //
  // Running keys first leaks. On `Authorization: Bearer <token>` the key
  // pattern matches `Authorization: ` and captures only `Bearer` — its value
  // group stops at whitespace — so it rewrites the string to
  // `Authorization: [redacted] <token>`. The bearer pattern then finds no
  // `Bearer ` to anchor on, and the credential survives redaction entirely.
  let out = input;
  out = out.replace(BEARER_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(JWT_PATTERN, REDACTED);

  for (const key of keys) {
    out = out.replace(
      keyValuePattern(key),
      (_m, prefix: string, scheme: string | undefined) => `${prefix}${scheme ?? ''}${REDACTED}`,
    );
  }
  return out;
}

function keyMatches(key: string, keys: readonly string[]): boolean {
  const normalised = normaliseKey(key);
  return keys.some(k => normalised.includes(normaliseKey(k)));
}

/**
 * Deep-redact any JSON-shaped value. Keys matching `keys` have their values
 * replaced wholesale; every string is additionally scanned for embedded
 * credentials, because secrets do not always arrive under an obvious key.
 */
export function redact<T>(value: T, keys: readonly string[]): T {
  return redactValue(value, keys, new WeakSet()) as T;
}

function redactValue(value: unknown, keys: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value, keys);
  if (value === null || typeof value !== 'object') return value;

  // Cycles are possible in captured objects; degrade rather than blow the stack.
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map(v => redactValue(v, keys, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = keyMatches(k, keys) ? REDACTED : redactValue(v, keys, seen);
  }
  return out;
}

/** Redact a URL's query string while keeping the path readable. */
export function redactUrl(rawUrl: string, keys: readonly string[]): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (keyMatches(key, keys)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    // Not a parseable URL — fall back to string scrubbing rather than dropping it.
    return redactString(rawUrl, keys);
  }
}
