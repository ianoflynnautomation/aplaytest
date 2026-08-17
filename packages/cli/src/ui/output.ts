/**
 * Terminal output.
 *
 * Colour and box-drawing appear only on a TTY; CI logs stay plain and
 * greppable. This is detected, never flagged — a tool that needs `--no-color`
 * passed in CI is a tool that got the default wrong.
 */

const ESC = '[';

const isTty = (): boolean => process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

const wrap =
  (code: string) =>
  (text: string): string =>
    isTty() ? `${ESC}${code}m${text}${ESC}0m` : text;

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
};

export function heading(text: string): void {
  process.stdout.write(`\n${style.bold(text)}\n`);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`${style.yellow('warning')} ${text}\n`);
}

export function error(text: string): void {
  process.stderr.write(`${style.red('error')} ${text}\n`);
}

export interface Column {
  readonly header: string;
  readonly align?: 'left' | 'right';
}

export function table(columns: readonly Column[], rows: readonly (readonly string[])[]): void {
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...rows.map(r => (r[i] ?? '').length)),
  );

  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        return columns[i]?.align === 'right' ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  line(style.dim(render(columns.map(c => c.header))));
  line(style.dim(render(widths.map(w => '─'.repeat(w)))));
  for (const row of rows) line(render(row));
}

/**
 * A minimal line diff: trim the common prefix and suffix, show what is left.
 *
 * Enough for a codemod, which edits one region. A full LCS diff would be more
 * general, and generality is not what makes this output trustworthy — seeing
 * the exact changed lines is.
 */
export function renderDiff(before: string, after: string, context = 2): string[] {
  const a = before.split('\n');
  const b = after.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const out: string[] = [];
  for (let i = Math.max(0, start - context); i < start; i++) out.push(style.dim(`  ${a[i] ?? ''}`));
  for (let i = start; i < endA; i++) out.push(style.red(`- ${a[i] ?? ''}`));
  for (let i = start; i < endB; i++) out.push(style.green(`+ ${b[i] ?? ''}`));
  for (let i = endA; i < Math.min(a.length, endA + context); i++) {
    out.push(style.dim(`  ${a[i] ?? ''}`));
  }
  return out;
}
