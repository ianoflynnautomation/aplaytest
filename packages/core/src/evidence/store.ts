/**
 * The evidence store: plain JSON on disk, one directory per run.
 *
 *   <dir>/<runId>/<evidenceId>.json
 *
 * Deliberately not a binary format and not a database. A human with `jq` must
 * be able to read a bundle, and a CI job must be able to upload the directory
 * as an artifact with no export step. Every bundle carries `schemaVersion` so
 * a reader can refuse politely rather than mis-parse.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { redact } from './redact.js';
import { EVIDENCE_SCHEMA_VERSION, type EvidenceBundle, type EvidenceId } from './types.js';

export interface EvidenceStoreOptions {
  readonly dir: string;
  readonly redactKeys: readonly string[];
  readonly retainRuns: number;
}

export class SchemaVersionError extends Error {
  constructor(
    readonly found: number,
    readonly expected: number,
    readonly path: string,
  ) {
    super(
      `Evidence bundle at ${path} is schemaVersion ${found}, this build reads ${expected}. ` +
        `Re-run the suite to regenerate, or use a matching atest version.`,
    );
    this.name = 'SchemaVersionError';
  }
}

export class EvidenceStore {
  constructor(private readonly options: EvidenceStoreOptions) {}

  private bundlePath(runId: string, id: EvidenceId): string {
    return join(this.options.dir, runId, `${id}.json`);
  }

  /**
   * Redaction happens HERE, on the write path, so there is exactly one place
   * that can forget to do it.
   */
  async write(bundle: EvidenceBundle): Promise<string> {
    const safe = redact(bundle, this.options.redactKeys);
    const path = this.bundlePath(bundle.runId, bundle.id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
    return path;
  }

  async read(runId: string, id: EvidenceId): Promise<EvidenceBundle> {
    const path = this.bundlePath(runId, id);
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    const version =
      typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed
        ? (parsed as { schemaVersion: unknown }).schemaVersion
        : undefined;

    if (version !== EVIDENCE_SCHEMA_VERSION) {
      throw new SchemaVersionError(Number(version), EVIDENCE_SCHEMA_VERSION, path);
    }
    return parsed as EvidenceBundle;
  }

  /** Run ids, newest first by directory mtime. */
  async listRuns(): Promise<string[]> {
    const entries = await readdir(this.options.dir, { withFileTypes: true }).catch(() => []);
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    const withTime = await Promise.all(
      dirs.map(async name => ({
        name,
        mtime: await stat(join(this.options.dir, name))
          .then(s => s.mtimeMs)
          .catch(() => 0),
      })),
    );
    return withTime.sort((a, b) => b.mtime - a.mtime).map(e => e.name);
  }

  async listBundles(runId: string): Promise<EvidenceId[]> {
    const entries = await readdir(join(this.options.dir, runId)).catch(() => []);
    return entries.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5) as EvidenceId);
  }

  /** Drop the oldest runs beyond the retention limit. Returns what it removed. */
  async prune(): Promise<string[]> {
    const runs = await this.listRuns();
    const doomed = runs.slice(this.options.retainRuns);
    await Promise.all(doomed.map(r => rm(join(this.options.dir, r), { recursive: true, force: true })));
    return doomed;
  }
}
