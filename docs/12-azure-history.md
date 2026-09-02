# 12 — Run history in Azure Blob Storage

Flake detection is statistical. One run cannot tell you whether a test is
unstable, so the history has to outlive the run that produced it — and with the
default `:memory:` store every CI run sees one attempt per test and reports
"insufficient data" forever. The engine looks like it works and never says
anything.

This is the store that fixes that.

---

## What changed, and why

The first design was **one SQLite file on a blob**: the analyze job downloaded
`history.sqlite`, ingested into it, and re-uploaded it under an `If-Match`
precondition. It was small, it worked for one writer, and it had three problems
that got worse with use.

| | The file design | This design |
| --- | --- | --- |
| Two overlapping main runs | One loses the ETag race. Failing is the *good* outcome; a retry without re-downloading silently discards the other run's attempts. | Different blob names. Nothing races. |
| Cost per run | Rewrites the entire database to append thirty seconds of it. | One PUT per shard, a few KB each. |
| Reading a window | All of history, or nothing. | The date is in the path, so a 90-day read filters the *listing*. |
| Idempotence | A scoped `DELETE` plus an `UPSERT`, both of which had to be got exactly right — and were got wrong twice, once collapsing three shard files carrying four attempts into zero. | A naming rule. |

The store is now an **append-only log of run records**: one immutable object per
run and shard.

```
atest-history/
└── v1/runs/2026/08/30/
    ├── 18234567890-1/1-of-4.json.gz
    ├── 18234567890-1/2-of-4.json.gz
    ├── 18234567890-1/3-of-4.json.gz
    ├── 18234567890-1/4-of-4.json.gz
    └── pw-a1b2c3d4e5f6/all.json.gz
```

Three properties follow directly from the name, with no locking:

- **Idempotent.** A re-ingested shard computes the same name and overwrites
  itself. CI re-runs and repeated artifact ingestion cannot double-count.
- **Concurrent.** Two shards of one run write different names; so do two
  overlapping main-branch runs. Nothing needs a lock or a precondition.
- **Cheap to window.** `runCount()` is answered from the listing with zero
  downloads, because the run id is in the path.

### What is *not* new

The query semantics. `SqliteHistoryStore` and `BlobHistoryStore` both answer
through the same `HistoryIndex` — shard-scoped replacement, earliest-shard
`startedAt`, ordering applied before the limit. Two implementations of "the
same history" that disagree would surface as a flake score that differs between
a laptop and CI, months later, with no obvious cause. `packages/core/test/
memory-index.test.ts` deliberately repeats `store.test.ts`'s assertions.

---

## Using it

`--db` takes a URL. That is the whole configuration surface — there is no
`--history-account`, `--history-container`, `--history-prefix` triple to keep in
sync, and a repo moves from a local file to Azure by changing one string.

```bash
# Local: unchanged.
aplaytest flaky report --db .atest/history.sqlite

# Azure.
aplaytest history ingest --db azblob://bjjeireatest/atest-history --runs .atest/runs
aplaytest flaky report   --db azblob://bjjeireatest/atest-history

# Or set it once for a whole pipeline. --db still wins where it is passed.
export ATEST_HISTORY_URL=azblob://bjjeireatest/atest-history
aplaytest flaky report
```

| Form | Means |
| --- | --- |
| `:memory:` | Throwaway. The default, and a footgun in CI — the history commands refuse it rather than reporting an empty store and succeeding. |
| `.atest/history.sqlite` | A local file. Anything unrecognised is a path, so Windows paths keep working. |
| `azblob://<account>/<container>[/<prefix>]` | Azure, via the standard DNS suffix. |
| `https://<account>.blob.core.windows.net/<container>` | Azure, fully qualified — sovereign clouds, or a custom endpoint. |
| `http://127.0.0.1:10000/devstoreaccount1/<container>` | Azurite. The account is the first path segment, matching the emulator's convention. |

Two modifiers:

- **`?readonly=1`** — score against the store, never write to it. The
  pull-request configuration. `ingest()` still indexes the run locally, so the
  branch is scored *alongside* the trunk baseline; it just leaves nothing
  behind.
- **`?window=<days>`** — days of history downloaded before scoring (default
  90). Bounds the read: unbounded, the job gets slower every week until
  somebody disables the feature.

`ATEST_BLOB_ENDPOINT_SUFFIX` overrides the DNS suffix used by the `azblob://`
shorthand, for sovereign clouds.

### Installing the driver

```bash
npm i -D @aplaytest/cli @aplaytest/store-azure
```

`@aplaytest/store-azure` is a separate package and an **optional peer** of the CLI.
`@aplaytest/core` is loaded inside the Playwright process by the reporter, and its
contract is "no Playwright, no network, no model" — an 8 MB SDK and a credential
chain behind that import would make every test run pay for a feature only the
analyze job uses. The CLI imports it dynamically and, when it is absent, says
so with the install command rather than crashing.

### Authentication

`DefaultAzureCredential`, which covers all three places atest actually runs with
no configuration:

- GitHub Actions, via a federated token file (below)
- inside AKS, via workload identity
- a developer laptop, via `az login`

**In CI there is no `azure/login` and no `az` CLI.** That action exists to leave
the Azure CLI authenticated, so using it would mean shipping az — Python and
~300 MB — into a container image whose point is being small. It is also
unnecessary: `WorkloadIdentityCredential` is already in the default chain and
needs exactly three things, the third of which GitHub will mint on request.

```bash
# audience api://AzureADTokenExchange — what the terraform credential declares
AZURE_CLIENT_ID=<the identity>
AZURE_TENANT_ID=<tenant>
AZURE_FEDERATED_TOKEN_FILE=/tmp/azure-federated-token   # the GitHub OIDC JWT
```

This is the same mechanism AKS workload identity uses, so the image
authenticates identically in a cluster and in CI. Verified end to end: with a
deliberately malformed token, Entra answers `AADSTS50027 — JWT token is invalid
or malformed`, which is proof the exchange was attempted rather than skipped.

Shared keys are disabled on the account, so there is no key path to fall back
to and no key to leak.

`AzureBlobBackend` accepts any `TokenCredential` — deliberately the same union
`BlobServiceClient` itself takes — so you can pin `ManagedIdentityCredential`
or `WorkloadIdentityCredential` instead of relying on the chain to pick, and
the integration tests can pass the emulator's shared key. Note that accepting
a shared-key type in the CLIENT does not re-enable one on the ACCOUNT: keys are
refused server-side by `shared_access_key_enabled = false`, which is where that
control belongs. A narrower type would enforce nothing in production while
making the driver untestable.

---

## Testing it locally

The driver's logic — naming, windowing, read-only, the merge across shards — is
unit-tested against an in-memory backend, so most of it needs no emulator. What
only a real blob endpoint can settle is whether the bytes, the names and the
concurrency claims survive contact with a service. That is
`packages/store-azure/test/azurite.integration.test.ts`.

```bash
npm run test:integration
```

**Testcontainers owns the emulator.** `@testcontainers/azurite` starts a pinned
Azurite image, hands the test an endpoint on a random port, and stops it
afterwards. Three things follow, and they are why this owns a container rather
than expecting one on port 10000:

- no clash with an Azurite you are already running — the VS Code extension
  holds 10000, and a suite that fights it for the port is a suite people stop
  running
- no state between runs, so "the container is empty" is a fact rather than a
  hope about last week's leftovers
- nothing to install or remember; the image tag lives in the test file, so CI
  and a laptop exercise the same Azurite build

**Without Docker every test skips and `npm test` stays green.** A suite that
fails because of a missing local service teaches people to ignore it.

Already have an emulator running and want the faster loop? Point at it and no
container is started at all:

```bash
ATEST_AZURITE_URL=http://127.0.0.1:10000/devstoreaccount1 npm run test:integration
```

> **The image is pinned but the API-version check is off.** Azurite refuses any
> storage API version newer than the one it shipped with, and real Azure does
> not — it is an emulator restriction, not a behaviour worth reproducing. Left
> on, an unrelated `@azure/storage-blob` bump breaks this suite with an error
> about a date: 3.35.0 rejected the SDK's `2026-06-06` outright, which is how
> this was found. `withSkipApiVersionCheck()` keeps the emulator behaving like
> the service it stands in for.

### Looking at what it wrote

Azure Storage Explorer cannot *run* the tests — it is a GUI with no scriptable
surface, and it ships no emulator — but it is a good inspector, and worth using
here because this store's entire concurrency argument is encoded in blob
*names*.

`KEEP_CONTAINER=1` skips the cleanup and prints the endpoint. Pair it with
`ATEST_AZURITE_URL` so the data lands in an emulator that outlives the test
run — a Testcontainers instance is destroyed when the process exits, so there
is nothing left to browse:

```bash
ATEST_AZURITE_URL=http://127.0.0.1:10000/devstoreaccount1 \
  KEEP_CONTAINER=1 npm run test:integration
```

What you should see, and what each part is evidence of:

```
v1/runs/2026/08/30/concurrent-0/all.json.gz     ┐ eight writers at once,
...                                             │ all eight survived
v1/runs/2026/08/30/concurrent-7/all.json.gz     ┘
v1/runs/2026/08/30/sharded/1-of-4.json.gz       ┐ four shards of ONE run
...                                             │ coexisting, counted as
v1/runs/2026/08/30/sharded/4-of-4.json.gz       ┘ one run
v1/runs/2026/08/30/idem/1-of-1.json.gz            ingested twice, ONE object
v1/runs/2026/08/30/refs~2fheads~2fmain~20~232/…   a run id needing encoding,
                                                  still decodable from the name
```

The two most informative things in that listing are **absences**: no blob from
the read-only pull-request run, and no `2025/` partition after prune — proof
that read-only really writes nothing and that prune deletes from the service
rather than only from the local index.

---

## Why one container and not a database

One listing and a few hundred small GETs per CI run; a handful of PUTs. No
concurrent query load, no joins across datasets, no retention beyond a rolling
window. A managed database would add cost, a private endpoint and a backup
policy for a workload that is a listing and some object reads.

**Cost.** A 271-test suite at ~20 runs/week produces roughly 1,500 objects per
quarter at a few KB gzipped — call it 50 MB. Standard LRS hot storage is
~$0.02/GB/month; a read is ~$0.0004 per 10,000 GETs. It is noise against the
AKS cluster.

**Read latency.** The window is downloaded once, on the first query, with 16
parallel GETs, and every query after that is served from memory. That matters
because `analyzeAll` calls `attempts()` twice per (test, project) — a few
hundred calls for a real suite. A store that went to the network per call would
take minutes and would be the reason somebody turned this off.

---

## MAIN WRITES, PULL REQUESTS READ

Two user-assigned identities, and the split is enforced by Entra rather than by
workflow YAML:

| Identity | Federated on | Role on the history account |
| --- | --- | --- |
| `gha_atest_history` | `refs/heads/main` only | Storage Blob Data **Contributor** |
| `gha_pr_env` | `pull_request` *and* main | Storage Blob Data **Reader** |

`gha_pr_env` carries both credentials, so granting *it* Contributor would have
let any pull request write — the branch restriction would have lived in a file
anyone can edit. A separate identity federated on main alone is what makes
"pull requests cannot write history" true regardless of the workflow.

The semantics matter as much as the concurrency control. A flake baseline
should describe **trunk**. A pull request that introduces an unstable test must
not enter the baseline before anyone has decided to merge it.

`?readonly=1` says the same thing on atest's side. Azure would refuse the write
anyway, but as a 403 per shard file after four retries each — a correct policy
that reads as a slow job and a log full of red herrings.

---

## Retention

Two mechanisms, deliberately:

- **`aplaytest history prune --keep-days 90`** runs on main after scoring. Day
  granularity: blobs are partitioned by date, so it trims whole days. Trimming
  to the hour would mean downloading every record on the boundary day to
  recover a timestamp already encoded, less precisely, in its name.
- **A lifecycle-management policy on the account**, set to a *longer* window
  (120 days by default). This is the backstop: a repo that stops merging for a
  quarter, or a workflow disabled while something else is debugged, would
  otherwise accrue history nobody reads. Set longer than the read window so the
  account never deletes a record the analysis was about to score.

Blob **versioning is off** and **soft delete is on**, which sounds inconsistent
and is not. Overwrites here are idempotent by construction — re-ingesting a
shard writes the same bytes to the same name — so versions would accumulate
identical content and bill for it, and the thing versioning protects against is
already handled by the records being reproducible from the pipeline. Soft
delete covers a different failure: a mistyped `--keep-days 1` removes months of
history in one call, and *that* is not something CI will rebuild.

---

## Terraform

Applied in `bjjeire-terraform-azurerm-aks`:

| File | Holds |
| --- | --- |
| `main.storage-atest.tf` | The account, container, lifecycle policy and both role assignments |
| `variables.storage-atest.tf` | Retention, soft delete, tier, replication, role names |
| `main.identity.tf` | `gha_atest_history`, federated on `refs/heads/main` alone |
| `outputs.tf` | `storage_atest_history_account_name`, `storage_atest_history_url` |

The whole feature is gated on `storage_atest_account_name`. **Empty disables
it** — no account, no identity, no policy. The root module is shared by every
environment, so a required variable here would have broken `terraform plan` in
staging and prod the moment dev opted in. Currently set in
`environments/dev/terraform.tfvars` only.

`terraform output -raw storage_atest_history_url` prints the exact value
`ATEST_HISTORY_URL` takes.

---

## GitHub configuration

Repository **variables** (not secrets — none of these are sensitive):

| Variable | Value |
| --- | --- |
| `ATEST_HISTORY_ACCOUNT` | the storage account name |
| `ATEST_VERSION` | tag of the atest bundle to install; unset means `latest` |

Repository **secrets**:

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` | as already configured |
| `AZURE_CLIENT_ID` | `gha_pr_env` — read-only on this account |
| `ATEST_HISTORY_CLIENT_ID` | `gha_atest_history` — the main-only writer |

Every history step is gated on `ATEST_HISTORY_ACCOUNT` being non-empty, so
leaving it unset disables persistence and changes nothing else. And if
`ATEST_HISTORY_CLIENT_ID` is missing the job falls back to the reader identity
— so the degraded outcome is "history was not written", never "a pull request
wrote history".

---

## What this does not solve

**Time.** Scoring needs ten runs per test before it says anything
(`minRuns: 10`), and only main-branch runs write. Expect "insufficient data"
for the first week or two of adoption — that is the engine working, not
failing, and it is worth telling the team before someone reads it as broken.

The generated step summary says so explicitly while the window fills, and
`aplaytest history stats` reports the run count with the same warning, so the wait
is visible rather than mysterious.

**Evidence egress** is no longer a blocker: `extra-output-paths` on
`playwright-docker-tests.yml` mounts `.atest/` out of the test container.
Without that, run records were deleted with the container and this store would
have stayed empty.
