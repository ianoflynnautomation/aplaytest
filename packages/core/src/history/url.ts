/**
 * Where history lives, expressed as one string.
 *
 * `--db` was already the only knob naming the store, and every consumer — the
 * CLI, the generated workflows, `atest.config.ts` — passes it around as an
 * opaque path. Making it a URL rather than adding `--history-account`,
 * `--history-container` and `--history-prefix` means the blob backend needs no
 * new flag anywhere, and a repo switches from a local file to Azure by
 * changing one repository variable.
 *
 * Parsing lives in core because it is pure string work that the CLI, the
 * Azure driver and `doctor` all need, and because a typo in a container name
 * should fail with a readable message before any credential is acquired. The
 * network code that acts on the result lives in `@atest/store-azure`.
 */

export interface AzureBlobTarget {
  readonly kind: 'azure-blob';
  /** Base URL for `BlobServiceClient` — origin plus, on the emulator, the account. */
  readonly serviceUrl: string;
  readonly account: string;
  readonly container: string;
  /** Key prefix inside the container. Empty, or normalised to end with `/`. */
  readonly prefix: string;
  /**
   * Days of history to read. Bounds the download: a driver that fetches every
   * record ever written gets slower every week until someone disables it.
   */
  readonly windowDays: number | null;
  /**
   * Score against the store; never write to it. `?readonly=1`.
   *
   * This is the pull-request configuration, and it is a first-class mode
   * rather than an accident of RBAC. Azure already refuses the write — the PR
   * identity holds Reader — but "refused" arrives as a 403 per shard file
   * after four retries each, which turns a correct policy into a slow job and
   * a log full of red herrings. Saying it up front also documents the intent
   * where somebody reading the workflow will find it: a flake baseline
   * describes trunk, and a branch whose test code may itself be broken must
   * not enter it before anyone has decided to merge.
   */
  readonly readOnly: boolean;
}

export type HistoryTarget =
  | { readonly kind: 'memory' }
  | { readonly kind: 'sqlite'; readonly path: string }
  | AzureBlobTarget;

export interface ParseHistoryUrlOptions {
  /**
   * DNS suffix for the `azblob://` shorthand. Sovereign clouds differ
   * (`blob.core.usgovcloudapi.net`, `blob.core.chinacloudapi.cn`), and hard
   * coding the commercial one would silently resolve to a host that does not
   * exist rather than failing with a name anyone can act on.
   */
  readonly endpointSuffix?: string | undefined;
}

export const DEFAULT_BLOB_ENDPOINT_SUFFIX = 'blob.core.windows.net';

/** Azure's rule, enforced here so the failure names the field. */
const CONTAINER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ACCOUNT_NAME = /^[a-z0-9]{3,24}$/;

export class HistoryUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryUrlError';
  }
}

function parseWindowDays(params: URLSearchParams): number | null {
  const raw = params.get('window');
  if (raw === null) return null;
  const days = Number.parseInt(raw, 10);
  if (!Number.isInteger(days) || days < 1) {
    throw new HistoryUrlError(`?window= must be a positive integer number of days, got "${raw}".`);
  }
  return days;
}

function normalisePrefix(segments: readonly string[]): string {
  const joined = segments.filter(s => s !== '').join('/');
  return joined === '' ? '' : `${joined}/`;
}

function azureTarget(
  url: URL,
  serviceUrl: string,
  account: string,
  segments: readonly string[],
): AzureBlobTarget {
  const container = segments[0];
  if (container === undefined || container === '') {
    throw new HistoryUrlError(
      `"${url.href}" names no container. Expected azblob://<account>/<container>[/<prefix>].`,
    );
  }
  if (container.length < 3 || container.length > 63 || !CONTAINER_NAME.test(container)) {
    throw new HistoryUrlError(
      `"${container}" is not a valid container name — 3-63 chars, lowercase letters, digits and single dashes.`,
    );
  }
  if (!ACCOUNT_NAME.test(account)) {
    throw new HistoryUrlError(
      `"${account}" is not a valid storage account name — 3-24 lowercase alphanumerics.`,
    );
  }

  const readOnly = url.searchParams.get('readonly');

  return {
    kind: 'azure-blob',
    serviceUrl,
    account,
    container,
    prefix: normalisePrefix(segments.slice(1)),
    windowDays: parseWindowDays(url.searchParams),
    // Present-but-empty (`?readonly`) counts as on, because that is what
    // somebody typing it means. Only an explicit falsy value turns it off.
    readOnly: readOnly !== null && readOnly !== '0' && readOnly !== 'false',
  };
}

/**
 * Accepted forms:
 *
 *   :memory:                                        throwaway (not the config default)
 *   .atest/history.sqlite                           a local file
 *   azblob://<account>/<container>[/<prefix>]       Azure, via the DNS suffix
 *   https://<account>.blob.core.windows.net/<c>/<p> Azure, fully qualified
 *   http://127.0.0.1:10000/<account>/<c>/<p>        Azurite, account in path
 *
 * Anything unrecognised is a FILE PATH, not an error. `--db` has always taken
 * one, and a Windows path like `C:\atest\history.sqlite` parses as a URL with
 * scheme `c:` — rejecting unknown schemes would break the case the flag was
 * built for.
 */
export function parseHistoryUrl(url: string, options: ParseHistoryUrlOptions = {}): HistoryTarget {
  const trimmed = url.trim();
  if (trimmed === ':memory:' || trimmed === '') return { kind: 'memory' };

  if (trimmed.startsWith('azblob://')) {
    const suffix = options.endpointSuffix ?? DEFAULT_BLOB_ENDPOINT_SUFFIX;
    const parsed = new URL(trimmed);
    // `azblob://acct/container` puts the account in the authority, so it is
    // already lowercased and stripped of a path by the URL parser.
    const account = parsed.hostname;
    const segments = parsed.pathname.split('/').filter(s => s !== '');
    return azureTarget(parsed, `https://${account}.${suffix}`, account, segments);
  }

  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split('/').filter(s => s !== '');
    const subdomain = /^([a-z0-9]{3,24})\.blob\./.exec(parsed.hostname);

    if (subdomain !== null && subdomain[1] !== undefined) {
      return azureTarget(parsed, parsed.origin, subdomain[1], segments);
    }

    // Emulator convention: the account is the first path segment because
    // Azurite serves every account from one host.
    const account = segments[0];
    if (account === undefined) {
      throw new HistoryUrlError(
        `"${trimmed}" is not a blob endpoint. Expected <account>.${DEFAULT_BLOB_ENDPOINT_SUFFIX}/<container>, ` +
          `or an emulator URL with the account as the first path segment.`,
      );
    }
    return azureTarget(parsed, `${parsed.origin}/${account}`, account, segments.slice(1));
  }

  return { kind: 'sqlite', path: trimmed };
}

/** Short, log-safe description. Used by `doctor` and every "what am I reading?" line. */
export function describeHistoryTarget(target: HistoryTarget): string {
  switch (target.kind) {
    case 'memory':
      return 'in-memory (discarded when the process exits)';
    case 'sqlite':
      return `sqlite · ${target.path}`;
    case 'azure-blob':
      return (
        `azure blob · ${target.account}/${target.container}/${target.prefix}` +
        (target.readOnly ? ' (read-only)' : '')
      );
  }
}
