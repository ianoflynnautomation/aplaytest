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

export default async function globalSetup(): Promise<void> {
  await startFixtureApp(FIXTURE_PORT);
}
