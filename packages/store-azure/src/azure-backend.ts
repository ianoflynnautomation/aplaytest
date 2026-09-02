/**
 * `BlobBackend` over Azure Blob Storage.
 *
 * Error translation lives here because this is where SDK `RestError`s surface.
 * The three things that go wrong in practice — no credential, a role
 * assignment that has not propagated, a container nobody created — all arrive
 * as a bare status code, and a CI job that prints "403" tells whoever is on
 * call nothing about which of the three it is or what to do next.
 */

import type { TokenCredential } from '@azure/core-auth';
import { DefaultAzureCredential } from '@azure/identity';
import {
  AnonymousCredential,
  BlobServiceClient,
  RestError,
  StorageSharedKeyCredential,
  type ContainerClient,
} from '@azure/storage-blob';

import type { BlobBackend } from './backend.js';

/**
 * The credentials this driver accepts — deliberately the same union
 * `BlobServiceClient`'s own constructor takes, no narrower.
 *
 * `TokenCredential` rather than `DefaultAzureCredential`: the concrete class
 * is one implementation of the interface, and typing the parameter as it would
 * reject `ManagedIdentityCredential` and `WorkloadIdentityCredential` — which
 * is what you reach for inside AKS when you want to pin the credential instead
 * of relying on the chain to pick it. Narrowing a parameter to a subtype of
 * what the thing underneath accepts buys nothing and costs callers.
 *
 * `@azure/core-auth` is declared as a dependency rather than imported off the
 * back of `@azure/identity`. It is already in the tree — both `identity` and
 * `storage-blob` depend on it — so declaring it adds nothing to an install and
 * removes the failure where a differently hoisted tree turns a type nobody
 * touched into an error.
 */
export type BlobCredential = TokenCredential | StorageSharedKeyCredential | AnonymousCredential;

export interface AzureBlobBackendOptions {
  readonly serviceUrl: string;
  readonly container: string;
  /**
   * Overrides the default credential chain. Left unset, `DefaultAzureCredential`
   * picks up — in order — the env vars set by `azure/login`, a workload
   * identity token inside AKS, and finally the signed-in `az` CLI. All three of
   * the places atest actually runs are covered without configuration.
   *
   * WIDE ON PURPOSE, and specifically wide enough for a shared key. That looks
   * like it undoes `shared_access_key_enabled = false` on the production
   * account and does not: keys are refused by the STORAGE ACCOUNT, so what a
   * client is willing to construct is irrelevant there. Narrowing this type to
   * `DefaultAzureCredential` would enforce nothing in production while making
   * the driver untestable against Azurite, which authenticates with the
   * well-known emulator key — buying an imaginary control at the cost of a
   * real one.
   */
  readonly credential?: BlobCredential | undefined;
}

/** How long a call may take before it is a hung job rather than a slow network. */
const REQUEST_TIMEOUT_MS = 30_000;

function describe(error: unknown, action: string, target: string): Error {
  if (!(error instanceof RestError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const detail = `${action} ${target}`;
  switch (error.statusCode) {
    case 403:
      return new Error(
        `Azure denied ${detail} (403).\n` +
          '  The identity authenticated but is not authorised. Two usual causes:\n' +
          '    · the role assignment is missing — history needs "Storage Blob Data Reader"\n' +
          '      to score and "Storage Blob Data Contributor" to write\n' +
          '    · the assignment was just created; RBAC takes up to 5 minutes to propagate\n' +
          '  Note that on a pull request READ-ONLY is the intended configuration: only\n' +
          '  main-branch runs may amend the baseline.',
      );
    case 401:
      return new Error(
        `Azure rejected the credential for ${detail} (401).\n` +
          '  No usable credential was found. In GitHub Actions run azure/login with\n' +
          '  id-token: write before this step; locally, run `az login`.',
      );
    case 404:
      return new Error(
        `${detail} — not found (404).\n` +
          '  The storage account or container does not exist. Provision the container out\n' +
          '  of band (Terraform, Bicep, or the Azure portal) — atest never creates it.\n' +
          '  A client that creates its own container needs account-level write, which is\n' +
          '  far more than reading history should ever require.',
      );
    default:
      return new Error(`Azure returned ${String(error.statusCode ?? '?')} for ${detail}: ${error.message}`);
  }
}

export class AzureBlobBackend implements BlobBackend {
  private readonly container: ContainerClient;

  constructor(options: AzureBlobBackendOptions) {
    const credential = options.credential ?? new DefaultAzureCredential();
    const service = new BlobServiceClient(options.serviceUrl, credential, {
      // Keys are disabled on the account by design, so every call is a token
      // call; retrying a throttled one is cheaper than failing the analysis.
      retryOptions: { maxTries: 4, tryTimeoutInMs: REQUEST_TIMEOUT_MS },
    });
    this.container = service.getContainerClient(options.container);
  }

  async *list(prefix: string): AsyncIterable<string> {
    try {
      for await (const blob of this.container.listBlobsFlat({ prefix })) {
        yield blob.name;
      }
    } catch (error) {
      throw describe(error, 'listing', `${this.container.containerName}/${prefix}`);
    }
  }

  async get(name: string): Promise<Uint8Array | null> {
    try {
      const buffer = await this.container.getBlockBlobClient(name).downloadToBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      // A missing blob is normal: the listing and the download are two calls,
      // and a prune between them is a race the caller should not see.
      if (error instanceof RestError && error.statusCode === 404) return null;
      throw describe(error, 'reading', name);
    }
  }

  async put(name: string, body: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.container.getBlockBlobClient(name).uploadData(body, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    } catch (error) {
      throw describe(error, 'writing', name);
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.container.getBlobClient(name).deleteIfExists();
    } catch (error) {
      throw describe(error, 'deleting', name);
    }
  }
}
