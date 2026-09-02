/**
 * `HistoryStore` over an append-only log of run records in Azure Blob Storage.
 *
 * ── Why not the SQLite file that used to live here ──────────────────────────
 * The previous shape downloaded one `history.sqlite`, ingested into it, and
 * re-uploaded it under an `If-Match` precondition. It was small and it worked
 * for one writer. What it could not do:
 *
 *   · TOLERATE OVERLAP. Two main-branch runs finishing together meant one lost
 *     the conditional PUT. Failing is the good outcome; the workflow that
 *     retried without re-downloading silently discarded the other run.
 *   · STAY SMALL. Every run rewrote the whole database to append one record.
 *   · WINDOW. Scoring reads 90 days; the file was all of history or nothing.
 *
 * Objects fix all three by construction — see `layout.ts` for how the name
 * does the work. What is left is this: fetch a window, hand it to the shared
 * `HistoryIndex`, and let the query semantics be identical to the SQL driver's
 * because they are literally the same code.
 *
 * ── The read pattern this is shaped for ─────────────────────────────────────
 * `analyzeAll` calls `attempts()` twice per (test, project) — a few hundred
 * calls for a real suite. A store that went to the network per call would take
 * minutes and cost a fortune in transactions. So the window is downloaded ONCE,
 * lazily, on the first read, and every query after that is served from memory.
 * Writes do not trigger a load: ingesting a shard is one PUT.
 */

import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import {
  HistoryIndex,
  RUN_SCHEMA_VERSION,
  shardKeyOf,
  type AzureBlobTarget,
  type HistoricalAttempt,
  type HistoryQuery,
  type HistoryStore,
  type RunRecord,
  type TestKey,
} from '@atest/core';

import type { BlobBackend } from './backend.js';
import { StorageSharedKeyCredential } from '@azure/storage-blob';

import { AzureBlobBackend } from './azure-backend.js';
import { parseRunBlobName, runBlobName, runsPrefix, type RunBlobName } from './layout.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Default read window. Matches `history.retainDays`, so reads see what prune keeps. */
export const DEFAULT_WINDOW_DAYS = 90;

/**
 * Parallel downloads. Blob GETs are independent and mostly latency, so this is
 * the difference between a 4-second load and a 90-second one; past ~32 the
 * account starts throttling and the retries give the time back.
 */
export const DEFAULT_CONCURRENCY = 16;

export interface BlobHistoryStoreOptions {
  /** Key prefix inside the container. Normalised to end with `/`, or empty. */
  readonly prefix?: string;
  /** Days of history to read. `null` reads everything — slower every week. */
  readonly windowDays?: number | null;
  readonly concurrency?: number;
  /** Injectable clock, so the window boundary is testable. */
  readonly now?: () => number;
  /**
   * Score against the store; never write to it. See `AzureBlobTarget.readOnly`
   * for why this is a mode rather than a permission error.
   *
   * `ingest()` still indexes the record locally, so the run being analysed is
   * scored alongside the downloaded baseline — the PR sees its own results in
   * context, it just does not leave them behind.
   */
  readonly readOnly?: boolean;
}

/** A blob a read could not use. Reported, never thrown — see `skipped`. */
export interface SkippedBlob {
  readonly name: string;
  readonly reason: string;
}

interface Entry extends RunBlobName {
  readonly name: string;
}

const GZIP_MAGIC = [0x1f, 0x8b];

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/**
 * Run a bounded number of tasks at once, preserving nothing about order.
 *
 * `Promise.all` over 2,000 blobs opens 2,000 sockets and gets the account to
 * throttle; a sequential loop turns a 4-second load into a 20-minute one.
 */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await work(item);
    }
  });
  await Promise.all(workers);
}

function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['schemaVersion'] === RUN_SCHEMA_VERSION &&
    typeof record['runId'] === 'string' &&
    record['runId'] !== '' &&
    Array.isArray(record['attempts'])
  );
}

export class BlobHistoryStore implements HistoryStore {
  private readonly index = new HistoryIndex();
  private readonly prefix: string;
  private readonly windowDays: number | null;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly readOnly: boolean;

  /** Listing, once fetched. Answers `runCount` and `prune` with no downloads. */
  private entries: Entry[] | null = null;
  /** Whether the window's records are materialised in the index. */
  private materialised = false;

  private readonly skippedBlobs: SkippedBlob[] = [];

  constructor(
    private readonly backend: BlobBackend,
    options: BlobHistoryStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? '';
    this.windowDays = options.windowDays === undefined ? DEFAULT_WINDOW_DAYS : options.windowDays;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.now = options.now ?? Date.now;
    this.readOnly = options.readOnly ?? false;
  }

  /**
   * Blobs that exist but could not be read: truncated uploads, records written
   * by a newer atest, anything hand-edited into the container.
   *
   * Surfaced rather than thrown, for the same reason `ingestDirectory` skips a
   * bad file instead of failing the batch — one unreadable object among two
   * thousand must not cost you the other 1,999. The CLI prints these, because
   * a store that silently reads less than it should looks exactly like a store
   * with nothing in it.
   */
  get skipped(): readonly SkippedBlob[] {
    return this.skippedBlobs;
  }

  /** `YYYY-MM-DD` before which blobs are outside the read window. */
  private windowStart(): string | null {
    if (this.windowDays === null) return null;
    return new Date(this.now() - this.windowDays * 86_400_000).toISOString().slice(0, 10);
  }

  private async ensureListing(): Promise<Entry[]> {
    if (this.entries !== null) return this.entries;

    const start = this.windowStart();
    const found: Entry[] = [];
    for await (const name of this.backend.list(runsPrefix(this.prefix))) {
      const parsed = parseRunBlobName(this.prefix, name);
      if (parsed === null) continue;
      if (start !== null && parsed.date < start) continue;
      found.push({ ...parsed, name });
    }

    // Sorted by name, which sorts by date then run id then shard. Metadata
    // merging is last-writer-wins, so a stable order is the difference between
    // a reproducible report and one that changes with the listing's paging.
    found.sort((a, b) => a.name.localeCompare(b.name));
    this.entries = found;
    return found;
  }

  private async ensureMaterialised(): Promise<void> {
    if (this.materialised) return;
    const entries = await this.ensureListing();

    const pending = entries.filter(entry => !this.index.has(entry.runId, entry.shardKey));
    await pool(pending, this.concurrency, async entry => {
      const bytes = await this.backend.get(entry.name);
      // Pruned between the listing and the download. Not an error.
      if (bytes === null) return;

      let record: unknown;
      try {
        const json = isGzip(bytes)
          ? (await gunzipAsync(bytes)).toString('utf8')
          : new TextDecoder().decode(bytes);
        record = JSON.parse(json);
      } catch (error) {
        this.skippedBlobs.push({
          name: entry.name,
          reason: error instanceof Error ? error.message : 'unreadable',
        });
        return;
      }

      if (!isRunRecord(record)) {
        this.skippedBlobs.push({
          name: entry.name,
          reason: `not a schemaVersion ${RUN_SCHEMA_VERSION} run record`,
        });
        return;
      }
      this.index.add(record);
    });

    this.materialised = true;
  }

  /**
   * One PUT. No read, no lock, no precondition — the name is derived from the
   * run id and the shard, so a re-ingest overwrites exactly itself and two
   * concurrent writers cannot collide.
   */
  async ingest(run: RunRecord): Promise<void> {
    const shardKey = shardKeyOf(run.shard);
    const name = runBlobName(this.prefix, run.startedAt, run.runId, shardKey);

    // Indexed either way: a pull request scores its own run against the trunk
    // baseline. Read-only decides whether the record outlives the job.
    this.index.add(run);
    if (this.readOnly) return;

    const body = await gzipAsync(Buffer.from(JSON.stringify(run), 'utf8'));
    await this.backend.put(name, new Uint8Array(body), 'application/json');

    // Keep an already-fetched listing honest, so `runCount()` right after an
    // ingest does not have to re-list to see what this process just wrote.
    if (this.entries !== null && !this.entries.some(entry => entry.name === name)) {
      const parsed = parseRunBlobName(this.prefix, name);
      if (parsed !== null) this.entries.push({ ...parsed, name });
    }
  }

  async attempts(query: HistoryQuery = {}): Promise<HistoricalAttempt[]> {
    await this.ensureMaterialised();
    return this.index.attempts(query);
  }

  async testKeys(): Promise<TestKey[]> {
    await this.ensureMaterialised();
    return this.index.testKeys();
  }

  /** Answered from the listing alone: the run id is in the blob name. */
  async runCount(): Promise<number> {
    const entries = await this.ensureListing();
    return new Set(entries.map(entry => entry.runId)).size;
  }

  /**
   * Delete runs that started before the cutoff.
   *
   * DAY GRANULARITY. Blobs are partitioned by date, so this deletes whole days
   * strictly older than the cutoff's date and leaves the cutoff day alone. A
   * retention window is a rolling approximation — trimming to the hour would
   * mean downloading every record on the boundary day to read a timestamp
   * already encoded, less precisely, in its name.
   *
   * Consider leaving retention to the account's lifecycle-management policy
   * instead; terraform sets one up. This exists for the case where you want it
   * to happen now, and for stores without a policy.
   *
   * One known edge: a sharded run that crosses midnight has shards in two
   * partitions, and a cutoff landing between them prunes half of it. The run
   * is at the far edge of the window and about to age out entirely, so the
   * alternative — reading every record on the boundary day to recover a
   * timestamp already in the name — buys a day of precision for a download.
   */
  async prune(olderThanIso: string): Promise<number> {
    if (this.readOnly) {
      throw new Error(
        'This store is open read-only, so prune would delete nothing and report success.\n' +
          '  Retention is a main-branch operation: drop ?readonly=1 from the URL, and expect\n' +
          '  the identity to hold "Storage Blob Data Contributor".',
      );
    }

    const entries = await this.ensureListing();
    const cutoff = olderThanIso.slice(0, 10);

    const doomed = entries.filter(entry => entry.date < cutoff);
    await pool(doomed, this.concurrency, entry => this.backend.remove(entry.name));

    const removedNames = new Set(doomed.map(entry => entry.name));
    this.entries = entries.filter(entry => !removedNames.has(entry.name));
    this.index.prune(`${cutoff}T00:00:00.000Z`);

    return new Set(doomed.map(entry => entry.runId)).size;
  }

  async close(): Promise<void> {
    this.index.clear();
    this.entries = null;
    this.materialised = false;
  }
}

/** Build a store from a parsed `azblob://` URL. The path the CLI takes. */
export interface OpenBlobHistoryStoreOptions
  extends Omit<BlobHistoryStoreOptions, 'prefix' | 'windowDays' | 'readOnly'> {
  /**
   * Shared-key credential, for an EMULATOR. Unset — the normal case — the
   * driver uses `DefaultAzureCredential` and authenticates with Entra.
   *
   * This exists so the documented Azurite URL form is actually usable: the
   * emulator has no Entra to federate against, so without a key the CLI can
   * parse `http://127.0.0.1:10000/devstoreaccount1/…` and then fail to
   * authenticate against it — a supported-looking target that never works.
   *
   * It does NOT weaken production. Keys are refused by the STORAGE ACCOUNT
   * (`shared_access_key_enabled = false`), so what a client is willing to
   * construct is irrelevant there; a key passed at a real account fails at the
   * service. The control lives in Azure, not in this signature.
   */
  readonly accountKey?: string | undefined;
}

/**
 * Build a {@link BlobHistoryStore} from a parsed `azblob://` URL.
 *
 * This is the path the CLI takes. Authentication is `DefaultAzureCredential`
 * unless `accountKey` is set, which exists only so the Azurite emulator URL
 * is actually usable (the emulator has no Entra to federate against).
 *
 * @param target - Parsed Azure Blob target (`parseHistoryUrl` of an `azblob://` URL).
 * @param options - Optional emulator shared key and concurrency.
 * @returns A store that implements `HistoryStore`.
 *
 * @example
 * ```ts
 * const target = parseHistoryUrl('azblob://myaccount/atest-history?readonly=1');
 * if (target.kind !== 'azure-blob') throw new Error('expected azure-blob');
 * const store = openBlobHistoryStore(target);
 * const attempts = await store.attempts();
 * ```
 */
export function openBlobHistoryStore(
  target: AzureBlobTarget,
  options: OpenBlobHistoryStoreOptions = {},
): BlobHistoryStore {
  const backend = new AzureBlobBackend({
    serviceUrl: target.serviceUrl,
    container: target.container,
    ...(options.accountKey === undefined
      ? {}
      : { credential: new StorageSharedKeyCredential(target.account, options.accountKey) }),
  });
  return new BlobHistoryStore(backend, {
    ...options,
    prefix: target.prefix,
    // `?window=` on the URL wins; unset means the default, never "everything".
    windowDays: target.windowDays ?? DEFAULT_WINDOW_DAYS,
    readOnly: target.readOnly,
  });
}
