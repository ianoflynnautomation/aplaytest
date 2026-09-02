/**
 * @atest/store-azure — run history in Azure Blob Storage.
 *
 * Split out of `@atest/core` deliberately. Core's contract is "no Playwright,
 * no network, no model", and it is the package every consumer installs,
 * including the reporter that loads inside the test process. Putting an 8 MB
 * SDK and a credential chain behind that import would make every Playwright
 * run pay for a feature only the analyze job uses.
 *
 * Install it alongside `atest` where history has to outlive the run:
 *
 *   npm i atest @atest/store-azure
 *   atest history ingest --db azblob://<account>/atest-history --runs .atest/runs
 */

export { BlobHistoryStore, openBlobHistoryStore, DEFAULT_WINDOW_DAYS, DEFAULT_CONCURRENCY } from './blob-store.js';
export type {
  BlobHistoryStoreOptions,
  OpenBlobHistoryStoreOptions,
  SkippedBlob,
} from './blob-store.js';

export { AzureBlobBackend } from './azure-backend.js';
export type { AzureBlobBackendOptions } from './azure-backend.js';

export { MemoryBlobBackend } from './backend.js';
export type { BlobBackend } from './backend.js';

export {
  LAYOUT_VERSION,
  LayoutError,
  encodeSegment,
  decodeSegment,
  partitionOf,
  runBlobName,
  parseRunBlobName,
  runsPrefix,
} from './layout.js';
export type { RunBlobName } from './layout.js';
