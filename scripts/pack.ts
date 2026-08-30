/**
 * Produce installable tarballs for every package.
 *
 * atest is a workspace monorepo, and until this existed it was not installable
 * at all: `npm pack` on `@atest/runner-playwright` yields a tarball whose
 * `@atest/core@0.0.0` dependency resolves against the public registry, where
 * it does not exist. Measured, in a clean project:
 *
 *   npm error 404 Not Found - GET https://registry.npmjs.org/@atest%2fcore
 *
 * npm resolves that fine when every workspace tarball is installed in the same
 * command, so the answer is to emit all of them together rather than to publish
 * a registry or bundle core into the reporter.
 *
 * The consumer flow this enables, with no registry and no auth:
 *
 *   npm run pack                       # here
 *   cp dist-pack/*.tgz <repo>/vendor/  # there
 *   npm i ./vendor/atest-core-0.0.0.tgz ./vendor/atest-runner-playwright-0.0.0.tgz
 *
 * `file:` specifiers survive `npm ci`, so a Dockerfile that copies `vendor/`
 * before installing works unchanged — which is what the bjjeire-tests runner
 * image does.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'dist-pack');

/**
 * Only what a consumer installs into their own test process or CI job.
 *
 * `@atest/mcp` and `@atest/agent` are deliberately absent: the MCP server is
 * run from a checkout, and the agent is reached through the CLI. Shipping
 * fewer tarballs means fewer things whose versions have to agree.
 */
const PUBLISHABLE = [
  'core',
  'store-azure',
  'runner-playwright',
  'flaky',
  'heal',
  'impact',
  'report',
  'author',
  'llm',
  'agent',
  'cli',
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const name of PUBLISHABLE) {
  const dir = join(ROOT, 'packages', name);
  execFileSync('npm', ['pack', '--pack-destination', OUT], { cwd: dir, stdio: 'pipe' });
}

const produced = readdirSync(OUT).filter(f => f.endsWith('.tgz')).sort();

// A tarball that ships no build output installs cleanly and then fails at
// import time, which is a far worse failure than a missing tarball.
const empty = produced.filter(f => {
  const listing = execFileSync('tar', ['-tzf', join(OUT, f)], { encoding: 'utf8' });
  return !listing.includes('/dist/');
});
if (empty.length > 0) {
  console.error(`These tarballs contain no dist/ — run \`npm run build\` first:\n  ${empty.join('\n  ')}`);
  process.exit(1);
}

const reporterPkg = JSON.parse(
  readFileSync(join(ROOT, 'packages/runner-playwright/package.json'), 'utf8'),
) as { version: string };

console.log(`packed ${produced.length} tarballs → dist-pack/`);
for (const f of produced) console.log(`  ${f}`);
console.log(`
To consume from a test repository (no registry, no auth):

  cp dist-pack/*.tgz <repo>/vendor/
  cd <repo> && npm i \\
    ./vendor/atest-core-${reporterPkg.version}.tgz \\
    ./vendor/atest-runner-playwright-${reporterPkg.version}.tgz

Install BOTH in one command — core is not on any registry, so the reporter
tarball cannot resolve it on its own.`);
