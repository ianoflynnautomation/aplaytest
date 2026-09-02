/**
 * Produce installable tarballs for every package.
 *
 * These exist for the NO-REGISTRY path — an air-gapped runner, a fork that
 * cannot authenticate, a consumer pinning a build that was never released.
 * The normal path is `npm install @atest/runner-playwright`, because the
 * packages are published to npm under the `@atest` scope with real semver
 * dependencies on each other.
 *
 * Install every tarball in ONE command. Each declares `@atest/core@^0.1.0`,
 * and npm satisfies that from the other tarballs in the same invocation; ask
 * for one alone and — if the version is not yet on the registry — you get:
 *
 *   npm error 404 Not Found - GET https://registry.npmjs.org/@atest%2fcore
 *
 * The consumer flow this enables, with no registry and no auth:
 *
 *   npm run pack                       # here
 *   cp dist-pack/*.tgz <repo>/vendor/  # there
 *   npm i ./vendor/atest-core-0.1.0.tgz ./vendor/atest-runner-playwright-0.1.0.tgz
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
 * `@atest/mcp` is deliberately absent — the MCP server is run from a checkout —
 * and `packages/mcp/package.json` now carries `"private": true` so that
 * decision is enforced by npm rather than by this list staying in step with it.
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
