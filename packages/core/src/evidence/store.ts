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

const JSON_EXTENSION = '.json';

export interface EvidenceStoreOptions {
  readonly dir: string;
  readonly redactKeys: readonly string[];
  readonly retainRuns: number;
}

export interface SkippedBundle {
  readonly file: string;
  readonly reason: string;
}

export interface LoadRunBundlesResult {
  readonly runId: string | null;
  readonly bundles: readonly EvidenceBundle[];
  readonly skipped: readonly SkippedBundle[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isEvidenceBundle(value: unknown): value is EvidenceBundle {
  if (!isRecord(value)) return false;
  if (value['schemaVersion'] !== EVIDENCE_SCHEMA_VERSION) return false;
  if (typeof value['id'] !== 'string') return false;
  if (!isRecord(value['test']) || typeof value['test']['title'] !== 'string') return false;
  if (!isRecord(value['failure']) || typeof value['failure']['kind'] !== 'string') return false;
  return true;
}

export function parseEvidenceBundle(value: unknown): EvidenceBundle | null {
  return isEvidenceBundle(value) ? value : null;
}

function schemaVersionOf(value: unknown): unknown {
  return isRecord(value) ? value['schemaVersion'] : undefined;
}

async function latestRunDirectory(evidenceDir: string): Promise<string | null> {
  const entries = await readdir(evidenceDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  return dirs[dirs.length - 1] ?? null;
}

export async function loadRunBundles(
  evidenceDir: string,
  runId?: string | undefined,
): Promise<LoadRunBundlesResult> {
  const resolvedRunId = runId ?? (await latestRunDirectory(evidenceDir));
  if (resolvedRunId === null) return { runId: null, bundles: [], skipped: [] };

  const dir = join(evidenceDir, resolvedRunId);
  const files = (await readdir(dir).catch(() => [])).filter(file => file.endsWith(JSON_EXTENSION));
  const bundles: EvidenceBundle[] = [];
  const skipped: SkippedBundle[] = [];

  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8').catch(() => null);
    if (raw === null) {
      skipped.push({ file, reason: 'unreadable' });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skipped.push({ file, reason: 'unreadable' });
      continue;
    }

    const bundle = parseEvidenceBundle(parsed);
    if (bundle === null) {
      const version = schemaVersionOf(parsed);
      skipped.push({
        file,
        reason:
          typeof version === 'number'
            ? `schemaVersion ${version}, this build reads ${EVIDENCE_SCHEMA_VERSION}`
            : 'malformed',
      });
      continue;
    }

    bundles.push(bundle);
  }

  return { runId: resolvedRunId, bundles, skipped };
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
    const bundle = parseEvidenceBundle(parsed);
    if (bundle === null) {
      throw new SchemaVersionError(Number(schemaVersionOf(parsed)), EVIDENCE_SCHEMA_VERSION, path);
    }
    return bundle;
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
    return entries
      .filter(file => file.endsWith(JSON_EXTENSION))
      .map(file => file.slice(0, -JSON_EXTENSION.length) as EvidenceId);
  }

  /** Drop the oldest runs beyond the retention limit. Returns what it removed. */
  async prune(): Promise<string[]> {
    const runs = await this.listRuns();
    const doomed = runs.slice(this.options.retainRuns);
    await Promise.all(doomed.map(r => rm(join(this.options.dir, r), { recursive: true, force: true })));
    return doomed;
  }
}
