/**
 * `atest init` — wire atest into an existing Playwright repository.
 *
 * The whole design rests on one claim: **removing the reporter line fully
 * removes the framework**. So init's job is to add that line and almost
 * nothing else. Anything it writes that a user cannot trivially delete is a
 * lock-in they did not ask for.
 *
 * Three rules it follows, in priority order:
 *
 *   1. NEVER silently overwrite. It edits `playwright.config.ts` in place, so
 *      it reports what it would change and requires `--apply` to write it.
 *   2. Be reversible in one line. What it adds is a reporter entry and a
 *      gitignore block. `atest init --undo` removes both.
 *   3. Say what it could NOT do. A config it cannot parse, an API project that
 *      needs the other fixture — these are reported, not guessed at. Guessing
 *      produces a config that looks wired up and captures nothing.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { EXIT, UsageError, type ExitCode } from '../exit.js';
import { heading, line, style, warn } from '../ui/output.js';

export interface InitFlags {
  readonly cwd?: string | undefined;
  readonly config?: string | undefined;
  readonly apply: boolean;
  readonly undo: boolean;
  readonly json: boolean;
}

const CANDIDATE_CONFIGS = [
  'playwright.config.ts',
  'playwright.ui.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
];

const REPORTER_ENTRY = "['@atest/runner-playwright/reporter']";

const GITIGNORE_BLOCK = `
# atest working data — generated, never source. The quarantine ledger is the
# exception: it records which tests are waived and until when, which is policy.
**/.atest/runs/
**/.atest/evidence/
**/.atest/heals/
**/.atest/history.sqlite
`;

export interface ConfigEdit {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly reason: string;
}

/**
 * Add the reporter to an existing `reporter:` array, or introduce one.
 *
 * Deliberately conservative: it edits only a form it recognises. A config that
 * builds its reporter list conditionally, or spreads a shared constant, is
 * reported as "edit by hand" rather than rewritten — a regex that half-
 * understands a config produces a file that still parses and no longer does
 * what its author meant.
 */
export function addReporter(source: string): ConfigEdit['reason'] | { text: string } {
  if (source.includes('@atest/runner-playwright/reporter')) {
    return 'already present';
  }

  // `reporter: [ ... ]` — append as the last entry.
  //
  // The close bracket is found by COUNTING, not by regex. A non-greedy
  // `[\s\S]*?\]` stops at the first `]` it meets, which for
  // `reporter: [['list'], ['html']]` is the one closing `['list']`. That
  // produced `['list',\n ['@atest/...'],],` — a file that no longer parses,
  // written straight to disk by --apply. An edit tool that corrupts the config
  // it was pointed at is worse than one that declines to edit.
  const open = /\breporter\s*:\s*\[/.exec(source);
  if (open?.index !== undefined) {
    const start = open.index + open[0].length;
    const close = matchingBracket(source, start - 1);
    if (close === -1) return 'reporter array is not closed — edit by hand';

    const body = source.slice(start, close);
    const trimmed = body.trimEnd();
    const separator = trimmed === '' || trimmed.endsWith(',') ? '' : ',';
    const indent = /\n([ \t]+)/.exec(body)?.[1] ?? '    ';
    const closeIndent = indent.slice(0, Math.max(0, indent.length - 2));

    return {
      text:
        source.slice(0, start) +
        `${trimmed}${separator}\n${indent}${REPORTER_ENTRY},\n${closeIndent}` +
        source.slice(close),
    };
  }

  // `reporter: 'list'` — promote the single reporter to an array so the atest
  // entry can sit beside it rather than replacing it.
  const single = /(\breporter\s*:\s*)(['"][^'"]+['"])/.exec(source);
  if (single?.index !== undefined) {
    const next = `${single[1]}[[${single[2]}], ${REPORTER_ENTRY}]`;
    return {
      text: source.slice(0, single.index) + next + source.slice(single.index + single[0].length),
    };
  }

  // A reporter key exists but is not a literal we can safely edit — a function
  // call, a spread, a conditional. This is the shape real repositories reach
  // once they have more than one environment, and rewriting it with a regex
  // produces a file that still parses and no longer does what its author meant.
  if (/\breporter\s*:/.test(source)) {
    return 'reporter is computed, not a literal — add the entry where the list is built';
  }

  // No reporter key at all. Adding one changes the default output format, so
  // this is the other case worth not guessing at.
  return 'no reporter key in this file';
}

/**
 * Find where the reporter list is actually built.
 *
 * Measured against a real repository: the config under test declared no
 * `reporter` key at all, because five configs shared one
 * `src/shared/config/playwright.ts` that assembled the list conditionally.
 * "No reporter key found" was true and useless — the next question is always
 * "then where?", and the tool is holding the answer.
 */
export async function findReporterSites(cwd: string): Promise<string[]> {
  const roots = ['.', 'src/shared/config', 'src/config', 'config'];
  const hits: string[] = [];

  for (const root of roots) {
    const entries = await readdir(join(cwd, root), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(ts|js|mjs)$/.test(entry.name)) continue;
      const rel = root === '.' ? entry.name : `${root}/${entry.name}`;
      const source = await readIfPresent(join(cwd, rel));
      if (source === null) continue;
      // Several shapes, because real configs use all of them: a literal
      // `reporter: [...]`, a typed builder (`const reporters:
      // ReporterDescription[] = ...`), or a list assembled with push. An
      // earlier version required `[` immediately after the colon and matched
      // none of them — including the file it was written to find.
      if (
        /\bReporterDescription\b/.test(source) ||
        /\breporter\s*:\s*\[/.test(source) ||
        /\breporters\s*(:[^=]*)?=\s*\[/.test(source) ||
        /\breporters\.push\(/.test(source)
      ) {
        hits.push(rel);
      }
    }
  }
  return hits;
}

/**
 * Index of the `]` matching the `[` at `openIndex`, or -1.
 *
 * Skips brackets inside strings and comments, because a reporter entry like
 * `['json', { outputFile: 'a[1].json' }]` would otherwise close the array
 * early — the same class of bug as the regex this replaced, just rarer.
 */
export function matchingBracket(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 1; }
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }

    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Remove the atest entry — the ENTRY, not the line it happens to sit on.
 *
 * Dropping whole lines is fine for the array form, where the entry has a line
 * to itself, and destructive for the promoted form. Measured: a config that
 * started as `reporter: 'list'` was rewritten to
 * `reporter: [['list'], ['@atest/…']],` on the way in, and undo deleted that
 * entire line — silently taking the user's own reporter with it and leaving a
 * config with no `reporter` key at all. Undo must never remove something the
 * user wrote.
 *
 * A promotion is reverted where it can be recognised, so `reporter: 'list'`
 * comes back as it started rather than as a one-element array.
 */
export function removeReporter(source: string): string {
  // Revert the exact promotion this tool performs.
  const promoted = new RegExp(
    `(\\breporter\\s*:\\s*)\\[\\[(['"][^'"]+['"])\\],\\s*${escapeRegExp(REPORTER_ENTRY)}\\]`,
  );
  if (promoted.test(source)) return source.replace(promoted, '$1$2');

  // Otherwise drop only the entry, plus a trailing comma and the blank line it
  // leaves behind if it owned one.
  const entry = new RegExp(`\\n?[ \\t]*${escapeRegExp(REPORTER_ENTRY)}\\s*,?`, 'g');
  return source.replace(entry, '');
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readIfPresent(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

export async function init(flags: InitFlags): Promise<ExitCode> {
  const cwd = resolve(flags.cwd ?? process.cwd());

  let configPath: string | null = null;
  let configSource: string | null = null;
  for (const name of flags.config === undefined ? CANDIDATE_CONFIGS : [flags.config]) {
    const source = await readIfPresent(join(cwd, name));
    if (source !== null) {
      configPath = name;
      configSource = source;
      break;
    }
  }

  if (configPath === null || configSource === null) {
    throw new UsageError(
      `No Playwright config found in ${cwd}.\n` +
        `  Looked for: ${CANDIDATE_CONFIGS.join(', ')}\n` +
        '  Run atest init from your test project, or pass --config <path>.',
    );
  }

  const gitignorePath = join(cwd, '.gitignore');
  const gitignore = (await readIfPresent(gitignorePath)) ?? '';

  if (flags.undo) {
    return undo(cwd, configPath, configSource, gitignorePath, gitignore, flags);
  }

  const result = addReporter(configSource);
  const gitignoreNeedsBlock = !gitignore.includes('.atest/runs');

  heading(`atest init · ${configPath}`);

  if (typeof result === 'string') {
    if (result === 'already present') {
      line(`  ${style.green('✓')} reporter already configured — nothing to do`);
    } else {
      warn(`  ${result}`);
      const sites = await findReporterSites(cwd);
      if (sites.length > 0) {
        line(style.dim('    The reporter list appears to be built in:'));
        for (const site of sites) line(style.cyan(`      ${site}`));
      }
      line(style.dim(`    Add this entry to it:`));
      line(style.dim(`      ${REPORTER_ENTRY}`));
    }
  } else if (!flags.apply) {
    line(`  would add ${REPORTER_ENTRY} to the reporter array`);
  } else {
    await writeFile(join(cwd, configPath), result.text, 'utf8');
    line(`  ${style.green('✓')} added the reporter to ${configPath}`);
  }

  if (gitignoreNeedsBlock) {
    if (!flags.apply) line('  would add atest working data to .gitignore');
    else {
      await writeFile(gitignorePath, `${gitignore.trimEnd()}\n${GITIGNORE_BLOCK}`, 'utf8');
      line(`  ${style.green('✓')} ignored atest working data`);
    }
  }

  line();
  if (!flags.apply) {
    line(style.cyan('  Nothing written. Re-run with --apply.'));
    return EXIT.OK;
  }

  // The one thing init cannot do for you, stated every time rather than
  // buried in a doc: the capture fixtures are opt-in and project-specific,
  // and choosing the wrong one for an API project launches a browser per test.
  line(style.bold('  Next — capture fixtures (optional, and the part that must be chosen):'));
  line('    UI projects   import { atestFixtures }    from \'@atest/runner-playwright\'');
  line('    API projects  import { atestApiFixtures } from \'@atest/runner-playwright\'');
  line(style.dim('    Compose into your fixture barrel: base.extend({ ...atestFixtures, ...yours })'));
  line();
  line(style.dim('    An API project given atestFixtures still passes — and launches a'));
  line(style.dim('    browser for every test, because the capture fixture depends on `page`.'));
  line();
  line(style.dim('  Undo everything with: atest init --undo --apply'));
  return EXIT.OK;
}

async function undo(
  cwd: string,
  configPath: string,
  configSource: string,
  gitignorePath: string,
  gitignore: string,
  flags: InitFlags,
): Promise<ExitCode> {
  heading(`atest init --undo · ${configPath}`);

  const strippedConfig = removeReporter(configSource);
  const configChanged = strippedConfig !== configSource;
  const strippedIgnore = gitignore.replace(GITIGNORE_BLOCK, '').trimEnd();
  const ignoreChanged = strippedIgnore !== gitignore.trimEnd();

  if (!configChanged && !ignoreChanged) {
    line('  nothing to remove — atest is not wired into this project');
    return EXIT.OK;
  }

  if (!flags.apply) {
    if (configChanged) line(`  would remove the reporter line from ${configPath}`);
    if (ignoreChanged) line('  would remove the atest block from .gitignore');
    line();
    line(style.cyan('  Nothing written. Re-run with --apply.'));
    return EXIT.OK;
  }

  if (configChanged) {
    await writeFile(join(cwd, configPath), strippedConfig, 'utf8');
    line(`  ${style.green('✓')} removed the reporter from ${configPath}`);
  }
  if (ignoreChanged) {
    await writeFile(gitignorePath, `${strippedIgnore}\n`, 'utf8');
    line(`  ${style.green('✓')} removed the atest block from .gitignore`);
  }

  line();
  line(style.dim('  Fixtures composed into your own barrels are left alone — removing'));
  line(style.dim('  them is a decision about your code, not configuration atest owns.'));
  return EXIT.OK;
}
