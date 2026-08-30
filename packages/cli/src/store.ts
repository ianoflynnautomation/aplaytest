/**
 * One place that turns `--db` into a `HistoryStore`.
 *
 * Every command that reads history used to construct `new SqliteHistoryStore(
 * flags.db)` inline, which is how `--db` came to mean "a SQLite path" in six
 * files at once. Adding a second backend that way would have meant six copies
 * of the same switch, and the first one anybody forgot would be a command that
 * silently wrote a local file while the rest read Azure.
 *
 * The Azure driver is imported DYNAMICALLY and only when the URL asks for it.
 * `@azure/identity` and `@azure/storage-blob` are around 8 MB and start a
 * credential chain on construction; a developer running `atest flaky report`
 * against a local file should pay for neither, and `atest --help` in a repo
 * that never installed the package must not crash.
 */

import {
  MemoryHistoryStore,
  SqliteHistoryStore,
  describeHistoryTarget,
  parseHistoryUrl,
  type HistoryStore,
  type HistoryTarget,
} from '@atest/core';

import { UsageError } from './exit.js';

export interface OpenStoreResult {
  readonly store: HistoryStore;
  readonly target: HistoryTarget;
  /** One line naming what was opened. Printed by every command that opens one. */
  readonly description: string;
}

/**
 * `--db` beats `ATEST_HISTORY_URL` beats `:memory:`.
 *
 * The environment variable exists so a CI template can point a whole pipeline
 * at one store without threading a flag through every `npx atest` invocation —
 * and so that forgetting one invocation degrades to the same store as the rest
 * rather than to a throwaway.
 */
export function resolveHistoryUrl(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const fromFlag = flag?.trim();
  if (fromFlag !== undefined && fromFlag !== '') return fromFlag;

  const fromEnv = env['ATEST_HISTORY_URL']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  return ':memory:';
}

async function openBlobStore(target: Extract<HistoryTarget, { kind: 'azure-blob' }>) {
  let module: typeof import('@atest/store-azure');
  try {
    module = await import('@atest/store-azure');
  } catch {
    throw new UsageError(
      `${target.account}/${target.container} needs the Azure driver, which is not installed.\n` +
        '  Install it alongside the CLI:\n' +
        '    npm i -D @atest/store-azure\n' +
        '  It is a separate package so that a Playwright run, which loads @atest/core inside\n' +
        '  the test process, never pays for an SDK only the analyze job uses.',
    );
  }
  return module.openBlobHistoryStore(target);
}

export async function openHistoryStore(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenStoreResult> {
  const suffix = env['ATEST_BLOB_ENDPOINT_SUFFIX'];
  const target = parseHistoryUrl(url, suffix === undefined ? {} : { endpointSuffix: suffix });
  const description = describeHistoryTarget(target);

  switch (target.kind) {
    case 'memory':
      return { store: new MemoryHistoryStore(), target, description };
    case 'sqlite':
      return { store: new SqliteHistoryStore(target.path), target, description };
    case 'azure-blob':
      return { store: await openBlobStore(target), target, description };
  }
}

/**
 * Blobs the Azure driver listed but could not read.
 *
 * Reported by every command that opens a store, for the reason the driver
 * collects them rather than throwing: a store quietly reading less than it
 * holds is indistinguishable from a store that is simply young, and the
 * symptom — "insufficient data" — is what a correctly working engine says too.
 */
export function storeWarnings(store: HistoryStore): { name: string; reason: string }[] {
  const skipped = (store as { skipped?: readonly { name: string; reason: string }[] }).skipped;
  return skipped === undefined ? [] : [...skipped];
}
