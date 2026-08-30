/**
 * The blob naming scheme — the whole concurrency story, encoded in a path.
 *
 * The store this replaces was one SQLite file on a blob: download it, ingest,
 * upload it back under an ETag precondition. That works exactly until two runs
 * overlap, at which point the loser either fails the step or discards the
 * winner's attempts, and it re-uploads the entire history to record thirty
 * seconds of it.
 *
 * Here a run record is an object and the container is an append-only log:
 *
 *   <prefix>v1/runs/2026/08/30/<runId>/<shard>.json.gz
 *
 * Three properties follow directly from the name, with no locking:
 *
 *   · IDEMPOTENT. A re-ingested shard computes the same name and overwrites
 *     itself. The scoped-delete and UPSERT gymnastics the SQL driver needs to
 *     avoid double-counting are a naming rule here.
 *   · CONCURRENT. Two shards of one run, and two overlapping main-branch runs,
 *     write different names. Nothing races, so nothing needs a precondition.
 *   · CHEAP TO WINDOW. The date is in the path, so a 90-day read filters the
 *     LISTING and downloads only what it will score, and the run id is in the
 *     path, so counting runs needs no downloads at all.
 *
 * All pure string work: no client, no credential, no network.
 */

/** Bumped only for a change no existing reader can parse. Old prefixes stay readable. */
export const LAYOUT_VERSION = 'v1';

const RUNS_ROOT = `${LAYOUT_VERSION}/runs`;
const SUFFIX = '.json.gz';

/**
 * Run ids come from `ATEST_RUN_ID`, which in CI is whatever the pipeline puts
 * there — `github.run_id`, a pipeline id, a branch name. A `/` in one would
 * silently add a directory level and break parsing; a space or a `#` would
 * survive one SDK and not the next. Encode to a conservative alphabet and keep
 * it reversible, so the run id can still be read back out of a listing.
 */
const SAFE = /^[A-Za-z0-9._-]$/;

export function encodeSegment(value: string): string {
  let out = '';
  for (const char of value) {
    if (SAFE.test(char)) {
      out += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) {
      out += `~${byte.toString(16).padStart(2, '0')}`;
    }
  }
  return out;
}

export function decodeSegment(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '~' && i + 2 < value.length) {
      bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(...new TextEncoder().encode(value[i] ?? ''));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The date partition a run belongs to, taken from `startedAt`.
 *
 * Thrown rather than defaulted. A record whose timestamp cannot be read has no
 * place in a time-windowed store: filed under today it would look current
 * forever and never prune, and filed under the epoch it would vanish from
 * every window. `ingestDirectory` catches this and reports the file as
 * skipped, which is the visible failure the silent ones are worth trading for.
 */
export function partitionOf(startedAt: string): string {
  const match = ISO_DATE.exec(startedAt ?? '');
  if (match === null) {
    throw new LayoutError(
      `startedAt "${String(startedAt)}" is not an ISO 8601 timestamp, so the run has no date partition.`,
    );
  }
  return `${match[1]}/${match[2]}/${match[3]}`;
}

export interface RunBlobName {
  readonly runId: string;
  readonly shardKey: string;
  /** `YYYY-MM-DD`, so it compares against an ISO timestamp with `<`. */
  readonly date: string;
}

export function runBlobName(
  prefix: string,
  startedAt: string,
  runId: string,
  shardKey: string,
): string {
  return `${prefix}${RUNS_ROOT}/${partitionOf(startedAt)}/${encodeSegment(runId)}/${encodeSegment(shardKey)}${SUFFIX}`;
}

/** Everything a listing needs to answer, so the common queries need no downloads. */
export function parseRunBlobName(prefix: string, name: string): RunBlobName | null {
  if (!name.startsWith(`${prefix}${RUNS_ROOT}/`) || !name.endsWith(SUFFIX)) return null;

  const rest = name.slice(`${prefix}${RUNS_ROOT}/`.length, -SUFFIX.length);
  const parts = rest.split('/');
  // YYYY / MM / DD / runId / shardKey. Anything else is not ours — a stray
  // upload or a future layout, and either way not something to guess at.
  if (parts.length !== 5) return null;

  const [year, month, day, runId, shardKey] = parts;
  if (year === undefined || month === undefined || day === undefined) return null;
  if (runId === undefined || shardKey === undefined) return null;

  return {
    runId: decodeSegment(runId),
    shardKey: decodeSegment(shardKey),
    date: `${year}-${month}-${day}`,
  };
}

/** Prefix every run blob shares, so a listing can skip anything else in the container. */
export function runsPrefix(prefix: string): string {
  return `${prefix}${RUNS_ROOT}/`;
}
