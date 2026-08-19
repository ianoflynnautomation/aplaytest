/**
 * Start the fixture app from globalSetup, not from `webServer`.
 *
 * `webServer.command` is a shell command, and Playwright does not transpile
 * it — running a TypeScript server there would need `--experimental-strip-types`
 * (Node 22.6+ only) or a `tsx` dependency, both of which push a version
 * constraint onto every consumer for no benefit. globalSetup IS transpiled by
 * Playwright, so importing the server directly costs nothing and works on any
 * supported Node.
 */

import { startFixtureApp } from './server.js';

export const FIXTURE_PORT = 4321;

/**
 * Return a teardown so Playwright keeps this process alive for the run.
 *
 * A setup that starts a server and returns nothing lets the setup process
 * exit immediately — `server.unref()` made that exit legal, and then the
 * server died with it. Tests then hit ECONNREFUSED, every spec failed, and
 * the gate recorded those failures as mutant kills. A vacuous test looked
 * falsifiable and CI exited 0.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await startFixtureApp(FIXTURE_PORT);
  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  };
}
