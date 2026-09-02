/**
 * The four operations the store needs from object storage.
 *
 * Narrow on purpose. `ContainerClient` has around forty methods, and a store
 * written against it can only be tested against a real account or an emulator
 * — which means in practice it is tested in CI, once, by the pipeline it was
 * supposed to make reliable. Everything interesting about this driver is the
 * naming scheme, the windowing and the merge semantics; none of that is Azure,
 * and all of it is exercised against an in-memory backend in unit tests.
 */
export interface BlobBackend {
  /** Blob names under `prefix`, in whatever order the service returns them. */
  list(prefix: string): AsyncIterable<string>;
  /** Blob bytes, or null when it does not exist. Absence is never an error. */
  get(name: string): Promise<Uint8Array | null>;
  put(name: string, body: Uint8Array, contentType: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** In-memory `BlobBackend`, for unit tests and dry-run store construction. */
export class MemoryBlobBackend implements BlobBackend {
  private readonly blobs = new Map<string, Uint8Array>();

  async *list(prefix: string): AsyncIterable<string> {
    // Sorted so a test asserting on ordering is asserting on the store's
    // ordering rather than on Map insertion order.
    for (const name of [...this.blobs.keys()].sort()) {
      if (name.startsWith(prefix)) yield name;
    }
  }

  async get(name: string): Promise<Uint8Array | null> {
    return this.blobs.get(name) ?? null;
  }

  async put(name: string, body: Uint8Array): Promise<void> {
    this.blobs.set(name, body);
  }

  async remove(name: string): Promise<void> {
    this.blobs.delete(name);
  }

  /** Test affordance: how many objects exist, without going through the store. */
  get size(): number {
    return this.blobs.size;
  }

  names(): string[] {
    return [...this.blobs.keys()].sort();
  }
}
