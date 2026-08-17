/**
 * `atest doctor` — the first thing anyone runs when something is odd.
 *
 * Reports what it can actually verify and says plainly what it cannot, rather
 * than printing a wall of green ticks that mean nothing. Every warning carries
 * the command that fixes it.
 */

import { access, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { SqliteHistoryStore, ingestDirectory } from '@atest/core';
import { ground } from '@atest/author';

import { EXIT, type ExitCode } from '../exit.js';
import { heading, line, style } from '../ui/output.js';

interface Check {
  readonly label: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
  readonly fix?: string;
}

const ok = (label: string, detail: string): Check => ({ label, status: 'ok', detail });
const warn = (label: string, detail: string, fix?: string): Check =>
  fix === undefined ? { label, status: 'warn', detail } : { label, status: 'warn', detail, fix };

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function peerVersion(name: string, cwd: string): string | null {
  try {
    const require = createRequire(`${cwd}/package.json`);
    const pkg = require(`${name}/package.json`) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export async function doctor(flags: {
  runs: string;
  ledger: string;
  feature?: string | undefined;
  cwd?: string | undefined;
}): Promise<ExitCode> {
  const checks: Check[] = [];
  // Honour --cwd like every other command. Without it, `atest doctor --cwd
  // ../suite` silently diagnoses the wrong directory and reports everything
  // missing — the most misleading answer a diagnostic can give.
  const cwd = resolve(flags.cwd ?? process.cwd());

  checks.push(ok('node', process.version));

  const playwright = peerVersion('@playwright/test', cwd);
  checks.push(
    playwright === null
      ? warn(
          '@playwright/test',
          'not resolvable from this directory',
          'run atest from your test project, or npm install @playwright/test',
        )
      : ok('@playwright/test', playwright),
  );

  const runsDir = isAbsolute(flags.runs) ? flags.runs : join(cwd, flags.runs);
  const ledgerPath = isAbsolute(flags.ledger) ? flags.ledger : join(cwd, flags.ledger);

  if (await exists(runsDir)) {
    const files = (await readdir(runsDir)).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      checks.push(
        warn('run history', `${runsDir} is empty`, 'run a suite with the atest reporter'),
      );
    } else {
      // Actually ingest, rather than counting files: a directory full of
      // records this build cannot read is worse than an empty one, and only
      // parsing them reveals that.
      const store = new SqliteHistoryStore(':memory:');
      const result = await ingestDirectory(store, runsDir);
      await store.close();

      checks.push(
        result.skipped.length === 0
          ? ok('run history', `${result.runsIngested} runs · ${result.attemptsIngested} attempts`)
          : warn(
              'run history',
              `${result.runsIngested} readable, ${result.skipped.length} unreadable ` +
                `(${result.skipped[0]?.reason ?? ''})`,
              'regenerate with a matching atest version',
            ),
      );
    }
  } else {
    checks.push(
      warn('run history', `${runsDir} does not exist`, 'run a suite with the atest reporter'),
    );
  }

  // The gate, healing and bisect all SPAWN Playwright. Without a discoverable
  // config they fail with Playwright's own error, several layers from here,
  // and the user reasonably blames atest.
  const configs = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'];
  const foundConfig: string[] = [];
  for (const name of configs) if (await exists(join(cwd, name))) foundConfig.push(name);
  checks.push(
    foundConfig.length > 0
      ? ok('playwright config', foundConfig.join(', '))
      : warn(
          'playwright config',
          'none found in this directory',
          'run atest from your test project, or pass --config <path>',
        ),
  );

  if (await exists(ledgerPath)) {
    const size = (await stat(ledgerPath)).size;
    checks.push(ok('quarantine ledger', `${ledgerPath} (${size} bytes)`));
  } else {
    checks.push(ok('quarantine ledger', 'none — nothing quarantined'));
  }

  // Grounding quality is the strongest predictor of whether generated tests
  // are any good, and it is knowable before spending a cent. This runs the
  // SAME retrieval the author agent uses, so the answer is not an approximation
  // of what the agent would see — it is what the agent would see.
  const grounding = await ground({ cwd, feature: flags.feature ?? '' });
  checks.push(
    grounding.conventionsPath !== null
      ? ok('conventions', `${grounding.conventionsPath} — handed to the author agent verbatim`)
      : warn(
          'conventions',
          'no CLAUDE.md or AGENTS.md',
          'add one — conventions and exemplars are what make generated tests conventional',
        ),
  );

  if (flags.feature !== undefined) {
    checks.push(
      grounding.pageObjectPath !== null
        ? ok(
            `page object (${flags.feature})`,
            `${grounding.pageObjectPath} — ${grounding.pageObjectApi.length} exported methods`,
          )
        : warn(
            `page object (${flags.feature})`,
            'not found',
            `expected src/ui/pages/<dir>/${flags.feature}.page.ts`,
          ),
    );
    checks.push(
      grounding.exemplars.length >= 2
        ? ok(`exemplars (${flags.feature})`, grounding.exemplars.map(e => e.path).join(', '))
        : warn(
            `exemplars (${flags.feature})`,
            `${grounding.exemplars.length} found — two teach idiom, one only teaches vocabulary`,
            'grounding still works, but generated code will match the repo less closely',
          ),
    );
  }

  const hasKey =
    process.env['ANTHROPIC_API_KEY'] !== undefined && process.env['ANTHROPIC_API_KEY'] !== '';
  checks.push(
    hasKey
      ? ok('model access', 'ANTHROPIC_API_KEY present')
      : // Not a failure: every engine has a deterministic tier. But naming the
        // one capability that genuinely cannot degrade beats the older, vaguer
        // "deterministic features unaffected", which read as "nothing is lost".
        ok(
          'model access',
          'no API key — flaky, heal, impact, gate and report all work; ' +
            '`agent author` does not (nothing deterministic writes a test)',
        ),
  );

  heading('atest doctor');
  for (const check of checks) {
    const mark =
      check.status === 'ok'
        ? style.green('ok  ')
        : check.status === 'warn'
          ? style.yellow('warn')
          : style.red('fail');
    line(`  ${mark} ${check.label.padEnd(20)} ${check.detail}`);
    if (check.fix !== undefined) line(style.cyan(`       → ${check.fix}`));
  }

  const failures = checks.filter(c => c.status === 'fail').length;
  const warnings = checks.filter(c => c.status === 'warn').length;
  line(`\n${failures} error${failures === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);

  return failures > 0 ? EXIT.INTERNAL : EXIT.OK;
}
