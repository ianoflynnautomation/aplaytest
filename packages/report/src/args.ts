/**
 * Render captured step arguments the way a developer would have written them.
 *
 * `StepRecord.args` is `unknown[]` — whatever the page object was called with,
 * already redacted. `args.join(', ')` typechecks and looks fine in a unit test
 * full of strings, then prints `[object Object]` against the real suite, where
 * the interesting calls take objects: `expectCardData({ name: '…' })`.
 *
 * JSON.stringify is the other tempting shortcut and it is worse in a subtler
 * way: it quotes keys, so `{"name":"Fitzgerald BJJ"}` shows a reader two
 * quoted strings and no signal about which one is the domain value they should
 * be looking for.
 */

const MAX_STRING = 60;

function formatValue(value: unknown, depth: number): string {
  if (typeof value === 'string') {
    const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}…` : value;
    return `'${clipped}'`;
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  // Depth-limited: a page object handed a Playwright locator or a whole DTO
  // would otherwise print a wall of nesting nobody reads.
  if (depth >= 2) return Array.isArray(value) ? '[…]' : '{…}';

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map(v => formatValue(v, depth + 1)).join(', ')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const inner = entries.map(([k, v]) => `${k}: ${formatValue(v, depth + 1)}`).join(', ');
    return `{ ${inner} }`;
  }

  return String(value);
}

export function formatArgs(args: readonly unknown[]): string {
  return args.map(arg => formatValue(arg, 0)).join(', ');
}
