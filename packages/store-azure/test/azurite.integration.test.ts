/**
 * The blob driver against a REAL blob endpoint.
 *
 * blob-store.test.ts covers the logic — naming, windowing, read-only, the
 * merge across shards — against an in-memory backend, and deliberately never
 * touches an SDK. This file covers the half that cannot: whether the bytes,
 * the names and the concurrency claims survive contact with a service that
 * has its own opinions about content encoding, listing pagination and
 * simultaneous writers.
 *
 * ── Running it ────────────────────────────────────────────────────────────────
 *
 *   npm run test:integration
 *
 * Testcontainers starts a pinned Azurite image, hands back an endpoint on a
 * RANDOM port, and stops it afterwards. Three things follow from that, and
 * they are why this owns a container rather than expecting one on port 10000:
 *
 *   · no clash with an Azurite you are already running (the VS Code extension
 *     holds 10000, and a test suite that fights it for the port is a test
 *     suite people stop running)
 *   · no state between runs, so "the container is empty" is a fact rather than
 *     a hope about last week's leftovers
 *   · nothing to install or remember — the image is pinned here, so CI and a
 *     laptop exercise the same Azurite build
 *
 * WITHOUT DOCKER, EVERY TEST HERE SKIPS. `npm test` stays green on a machine
 * with no daemon and in a CI job that has not opted in. A suite that fails
 * because of a missing local service teaches people to ignore it.
 *
 * Set ATEST_AZURITE_URL to point at an emulator you are already running (the
 * VS Code extension, say) and no container is started at all. That is the
 * fast local loop; the container is the reproducible one.
 *
 * ── Seeing what it wrote ──────────────────────────────────────────────────────
 * The whole concurrency design of this store is encoded in the blob NAMES, so
 * looking at them is a real check:
 *
 *   v1/runs/2026/08/30/<runId>/2-of-4.json.gz
 *
 * `KEEP_CONTAINER=1` leaves the data in place and prints the endpoint. With
 * ATEST_AZURITE_URL that is your own emulator, so Azure Storage Explorer can
 * open it directly (Local & Attached → Storage Accounts → Emulator). Against a
 * Testcontainers instance, attach Storage Explorer to the printed port with a
 * custom connection — the container is torn down when the process exits either
 * way, so the external emulator is the friendlier route for browsing.
 */

import { AzuriteContainer, type StartedAzuriteContainer } from '@testcontainers/azurite';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RUN_SCHEMA_VERSION, parseHistoryUrl, type AttemptRecord, type RunRecord } from '@atest/core';

import { AzureBlobBackend } from '../src/azure-backend.js';
import { BlobHistoryStore } from '../src/blob-store.js';

/**
 * Pinned, not `latest`. The point of a container here is that CI and a laptop
 * run the same Azurite; floating the tag gives that up for nothing, and an
 * emulator behaviour change would land as a mystery failure on whoever pulled
 * next.
 */
const AZURITE_IMAGE = 'mcr.microsoft.com/azure-storage/azurite:3.37.0';

/**
 * Azurite's well-known development account — what the Testcontainers module
 * configures by default. Published in Microsoft's docs and identical in every
 * install: a fixture, not a secret, and a scanner flagging it is a false
 * positive.
 */
const EMULATOR_ACCOUNT = 'devstoreaccount1';
const EMULATOR_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

interface Emulator {
  readonly serviceUrl: string;
  readonly accountName: string;
  readonly accountKey: string;
  readonly container?: StartedAzuriteContainer;
}

/**
 * Resolved at module load rather than in `beforeAll`, because `describe.skipIf`
 * needs the answer at COLLECTION time — a hook cannot retroactively skip a
 * suite that has already been collected.
 */
async function resolveEmulator(): Promise<Emulator | null> {
  const external = process.env['ATEST_AZURITE_URL'];
  if (external !== undefined && external !== '') {
    return { serviceUrl: external, accountName: EMULATOR_ACCOUNT, accountKey: EMULATOR_KEY };
  }

  try {
    const container = await new AzuriteContainer(AZURITE_IMAGE)
      // Nothing here outlives the process, so persisting to a disk inside the
      // container only buys teardown work.
      .withInMemoryPersistence()
      // Azurite refuses any storage API version newer than the one it shipped
      // with, and REAL AZURE DOES NOT — it is an emulator restriction, not a
      // behaviour worth reproducing. Pinning the image against a moving SDK
      // therefore breaks this suite on an unrelated `@azure/storage-blob`
      // bump, with an error about a date that has nothing to do with the
      // change: 3.35.0 rejected the SDK's 2026-06-06 outright. Skipping the
      // check keeps the emulator behaving like the service it stands in for,
      // and keeps the pin from becoming a recurring chore.
      .withSkipApiVersionCheck()
      .start();

    return {
      // Already the account-in-the-path form the emulator uses, which is
      // exactly what parseHistoryUrl expects.
      serviceUrl: container.getBlobEndpoint(),
      accountName: container.getAccountName(),
      accountKey: container.getAccountKey(),
      container,
    };
  } catch {
    // No daemon, no image, no network. Skip rather than fail.
    return null;
  }
}

const emulator = await resolveEmulator();
const up = emulator !== null;
const SERVICE_URL = emulator?.serviceUrl ?? '(no emulator)';

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    testId: 'test-1',
    title: 'Given a gym name, when a visitor searches, then only that gym is displayed',
    titlePath: ['Gyms'],
    file: 'tests/gyms.spec.ts',
    line: 47,
    project: 'chromium-desktop',
    tags: ['@acceptance'],
    retry: 0,
    outcome: 'passed',
    failureKind: null,
    durationMs: 1200,
    workerIndex: 0,
    shard: null,
    traceId: null,
    evidenceId: null,
    coScheduled: [],
    routes: ['/gyms'],
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: 'run-1',
    startedAt: '2026-08-30T10:00:00.000Z',
    finishedAt: '2026-08-30T10:02:00.000Z',
    commit: 'abc123',
    branch: 'main',
    appEnv: 'ci',
    ci: true,
    workers: 6,
    shard: null,
    atestVersion: '0.0.0',
    playwrightVersion: '1.62.1',
    attempts: [attempt()],
    ...overrides,
  };
}

describe.skipIf(!up)(`BlobHistoryStore against ${SERVICE_URL}`, () => {
  /**
   * EVERYTHING BELOW IS LAZY, and that is load-bearing.
   *
   * `describe.skipIf` still RUNS this callback at collection time — it has to,
   * in order to register the tests it then marks skipped. So anything
   * evaluated directly in the body executes on a machine with no Docker, where
   * `emulator` is null. An eager `const { serviceUrl } = emulator as Emulator`
   * turned "skip cleanly" into "Cannot destructure property of null", and the
   * `as` cast is precisely what stopped the compiler from saying so.
   *
   * Hence an accessor rather than a cast: nothing touches the emulator until a
   * test body runs, and if the skip condition ever regresses the failure names
   * the actual problem.
   */
  const required = (): Emulator => {
    if (emulator === null) {
      throw new Error('No emulator; this suite should have been skipped before reaching a test.');
    }
    return emulator;
  };

  const container = `atest-it-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const credential = (): StorageSharedKeyCredential =>
    new StorageSharedKeyCredential(required().accountName, required().accountKey);
  const service = (): BlobServiceClient =>
    new BlobServiceClient(required().serviceUrl, credential());

  const backend = () =>
    new AzureBlobBackend({ serviceUrl: required().serviceUrl, container, credential: credential() });

  const store = (options: Record<string, unknown> = {}) =>
    new BlobHistoryStore(backend(), { now: () => Date.parse('2026-08-30T12:00:00Z'), ...options });

  beforeAll(async () => {
    // Created here, not by the driver. The driver deliberately cannot create a
    // container — that needs account-level write, far more than reading
    // history should ever require — so terraform does it in production and the
    // test does it here. Same split, exercised.
    await service().getContainerClient(container).createIfNotExists();
  });

  afterAll(async () => {
    if (process.env['KEEP_CONTAINER'] === '1') {
      // eslint-disable-next-line no-console
      console.log(`\nKept container "${container}" at ${required().serviceUrl}\n`);
    } else {
      // Only meaningful against an EXTERNAL emulator. A Testcontainers
      // instance is about to be destroyed wholesale, but deleting anyway keeps
      // the two paths behaving the same, so a test cannot pass only because it
      // happened to run against a throwaway.
      await service().getContainerClient(container).deleteIfExists();
    }
    await emulator?.container?.stop();
  });

  it('given a run written to a real blob endpoint -> when it is read back -> then the metadata and routes survive the gzip round trip with nothing skipped', { tags: ['@integration', '@store-azure'] }, async () => {
    const writer = store();
    await writer.ingest(run({ runId: 'roundtrip' }));
    await writer.close();

    const reader = store();
    const attempts = await reader.attempts({ testId: 'test-1' });

    expect(attempts.map(a => a.runId)).toContain('roundtrip');
    expect(attempts[0]).toMatchObject({ ci: true, commit: 'abc123', workers: 6 });
    // Nothing was quietly dropped on the way through gzip and back.
    expect(attempts[0]?.routes).toEqual(['/gyms']);
    expect(reader.skipped).toEqual([]);
  });

  /**
   * The layout reaches the service unmangled — including a run id full of
   * characters that would otherwise add directory levels or be re-encoded by
   * an SDK. Asserted against a RAW listing, not through the store, because the
   * store would happily round-trip its own mistake.
   */
  it('given a run id containing slashes, spaces and a hash -> when it is written to the service -> then a raw listing shows the documented encoded name and the id decodes back', { tags: ['@integration', '@store-azure'] }, async () => {
    const writer = store();
    await writer.ingest(
      run({ runId: 'refs/heads/main #2', shard: { current: 2, total: 4 } }),
    );
    await writer.close();

    const names: string[] = [];
    for await (const blob of service()
      .getContainerClient(container)
      .listBlobsFlat({ prefix: 'v1/runs/2026/08/30/' })) {
      names.push(blob.name);
    }

    expect(names).toContain('v1/runs/2026/08/30/refs~2fheads~2fmain~20~232/2-of-4.json.gz');
    // And it decodes back, so a listing can still recover the run id.
    const reader = store();
    expect((await reader.attempts()).map(a => a.runId)).toContain('refs/heads/main #2');
  });

  /**
   * THE central claim of this refactor, against a real service.
   *
   * The design this replaced downloaded one history.sqlite, ingested, and
   * re-uploaded under an If-Match precondition. Two overlapping main-branch
   * runs meant one lost the ETag race — failing the step at best, silently
   * discarding the other run's attempts at worst. Different names cannot race,
   * and this is where that stops being an argument.
   */
  it('given eight writers ingesting at once -> when the container is read back -> then every attempt survives, because distinct names cannot race', { tags: ['@integration', '@store-azure'] }, async () => {
    const writers = Array.from({ length: 8 }, (_, i) => ({ store: store(), index: i }));
    await Promise.all(
      writers.map(w =>
        w.store.ingest(
          run({
            runId: `concurrent-${w.index}`,
            attempts: [attempt({ testId: `concurrent-test-${w.index}` })],
          }),
        ),
      ),
    );
    await Promise.all(writers.map(w => w.store.close()));

    const reader = store();
    const ids = (await reader.attempts())
      .map(a => a.testId)
      .filter(id => id.startsWith('concurrent-test-'));

    expect(new Set(ids).size).toBe(8);
  });

  it('given four shards of one run written concurrently -> when the container is read back -> then all four attempts accumulate under one run', { tags: ['@integration', '@store-azure'] }, async () => {
    const writer = store();
    await Promise.all(
      [1, 2, 3, 4].map(current =>
        writer.ingest(
          run({
            runId: 'sharded',
            shard: { current, total: 4 },
            attempts: [attempt({ testId: `shard-${current}` })],
          }),
        ),
      ),
    );
    await writer.close();

    const reader = store();
    const attempts = await reader.attempts();
    const shardIds = attempts.map(a => a.testId).filter(id => id.startsWith('shard-'));

    expect(new Set(shardIds).size).toBe(4);
    expect((await reader.attempts({ testId: 'shard-1' }))[0]?.runId).toBe('sharded');
  });

  it('given a shard re-ingested with different attempts -> when the container is read back -> then the newer attempt replaces the older one', { tags: ['@integration', '@store-azure'] }, async () => {
    const first = store();
    await first.ingest(
      run({ runId: 'idem', shard: { current: 1, total: 1 }, attempts: [attempt({ testId: 'v1' })] }),
    );
    await first.close();

    const second = store();
    await second.ingest(
      run({ runId: 'idem', shard: { current: 1, total: 1 }, attempts: [attempt({ testId: 'v2' })] }),
    );
    await second.close();

    const reader = store();
    const ids = (await reader.attempts()).map(a => a.testId);
    expect(ids).toContain('v2');
    expect(ids).not.toContain('v1');
  });

  /** The pull-request configuration, against a container that can be checked. */
  it('given a read-only store and an existing container -> when a branch run is ingested -> then the branch sees its own run and the blob listing is unchanged', { tags: ['@integration', '@store-azure'] }, async () => {
    const before: string[] = [];
    for await (const blob of service().getContainerClient(container).listBlobsFlat()) {
      before.push(blob.name);
    }

    const pr = store({ readOnly: true });
    await pr.ingest(
      run({ runId: 'from-a-pr', attempts: [attempt({ testId: 'branch-only' })] }),
    );
    // The branch sees its own run alongside the baseline it is scored against.
    expect((await pr.attempts()).map(a => a.testId)).toContain('branch-only');
    await pr.close();

    const after: string[] = [];
    for await (const blob of service().getContainerClient(container).listBlobsFlat()) {
      after.push(blob.name);
    }
    expect(after.sort()).toEqual(before.sort());
  });

  it('given runs already in the container -> when runCount is read -> then the count is recovered from the listing alone', { tags: ['@integration', '@store-azure'] }, async () => {
    // Cheap to assert here because a wrong answer means the run id is not
    // recoverable from the name, which would also break prune.
    const reader = store();
    expect(await reader.runCount()).toBeGreaterThan(0);
  });

  it('given an ancient run in the container -> when prune runs with a later cutoff -> then the blobs themselves are deleted from the service', { tags: ['@integration', '@store-azure'] }, async () => {
    const writer = store({ windowDays: null });
    await writer.ingest(run({ runId: 'ancient', startedAt: '2025-01-01T00:00:00.000Z' }));
    await writer.close();

    const pruner = store({ windowDays: null });
    expect(await pruner.prune('2025-06-01T00:00:00.000Z')).toBe(1);
    await pruner.close();

    const survivors: string[] = [];
    for await (const blob of service()
      .getContainerClient(container)
      .listBlobsFlat({ prefix: 'v1/runs/2025/' })) {
      survivors.push(blob.name);
    }
    expect(survivors).toEqual([]);
  });

  it('given the live emulator endpoint and container -> when parseHistoryUrl parses it -> then the account, container and service URL match the store configuration', { tags: ['@integration', '@store-azure'] }, async () => {
    // The account-in-the-path form exists precisely for this endpoint, so it
    // is worth checking against the endpoint rather than in isolation.
    const target = parseHistoryUrl(`${required().serviceUrl}/${container}`);
    expect(target).toMatchObject({
      kind: 'azure-blob',
      account: required().accountName,
      container,
      serviceUrl: required().serviceUrl,
    });
  });
});
