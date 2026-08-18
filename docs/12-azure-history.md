# 12 — Persisting run history on Azure

Flake detection is statistical. One run cannot tell you whether a test is
unstable, so the history has to outlive the run that produced it — and with the
default `--db :memory:` every CI run sees one attempt per test and reports
"insufficient data" forever. The engine looks like it works and never says
anything.

This is the store that fixes that. Proposed addition to
`bjjeire-terraform-azurerm-aks`; **not applied**, since it provisions live
infrastructure.

It reuses the patterns already in the repo: the AVM storage-account module from
`main.storage.tf`, and the `gha_pr_env` identity from `main.identity.tf` whose
federated credentials are already split `:pull_request` vs
`:ref:refs/heads/main`.

## Why one container and not a database

The store is a single SQLite file. Reads happen once per CI run, writes once per
main-branch run. There is no concurrent query load, no join across datasets, and
no retention beyond a rolling window that `atest history prune` trims. A managed
database would add cost, a private endpoint, and a backup policy for a workload
that is one `GET` and one conditional `PUT` per run.

## New file: `main.storage-atest.tf`

```hcl
# Test-history store for atest.
#
# Flake detection is statistical: one run cannot tell you whether a test is
# unstable, so the history has to outlive the run that produced it. This holds
# a single SQLite file of run records.
#
# WRITES COME ONLY FROM MAIN. The GitHub Actions identity federates separately
# for pull_request and for refs/heads/main, and only the main credential gets
# the Contributor role — pull requests read the baseline and never amend it.
# That removes the concurrent-write race, and it is also the semantics you
# want: a flake baseline should describe trunk, not a branch whose test code
# may itself be broken.
module "storage_atest_history" {
  source = "git::https://github.com/Azure/terraform-azurerm-avm-res-storage-storageaccount.git?ref=456bd88463bf63f08449644f60913c9523608b60" #v0.6.8

  name                = var.storage_atest_account_name
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location

  account_tier             = "Standard"
  account_replication_type = "LRS" # Derived data. Rebuildable by replaying runs.

  # No anonymous access, no shared keys — every caller authenticates with
  # Entra via OIDC, the same way the AKS workload identities do.
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  https_traffic_only_enabled      = true
  min_tls_version                 = "TLS1_2"
  public_network_access_enabled   = true

  enable_telemetry = var.vnet_enable_telemetry

  containers = {
    atest-history = {
      name = "atest-history"
    }
  }

  role_assignments = {
    # The single writer. Scoped to the main-branch federated credential.
    gha_main_blob_contributor = {
      role_definition_id_or_name = "Storage Blob Data Contributor"
      principal_id               = module.workload_identities.principal_ids["gha_pr_env"]
    }
  }
}
```

> **One thing to check before applying.** `gha_pr_env` is a single user-assigned
> identity carrying *both* federated credentials (PR and main), so an RBAC
> assignment on it grants both. The branch restriction in the generated workflow
> is therefore a workflow-level control, not an IAM one. If you want the
> guarantee enforced by Azure rather than by YAML, split it into a second
> identity federated only on `refs/heads/main` and give the Contributor role to
> that one, leaving `gha_pr_env` with `Storage Blob Data Reader`. I would do
> that — it is a few lines, and it makes "PRs cannot write history" true even
> if someone edits the workflow.

## Variables (`variables.storage.tf`)

```hcl
variable "storage_atest_account_name" {
  description = "Storage account holding the atest run-history database. Globally unique, 3-24 lowercase alphanumerics."
  type        = string
}
```

## GitHub configuration

Repository **variables** (not secrets — none of these are sensitive):

| Variable | Value |
| --- | --- |
| `ATEST_HISTORY_ACCOUNT` | the storage account name |
| `AZURE_CLIENT_ID` | client id of the `gha_pr_env` identity |
| `AZURE_TENANT_ID` | tenant id |
| `AZURE_SUBSCRIPTION_ID` | subscription id |

The generated workflow gates every history step on
`vars.ATEST_HISTORY_ACCOUNT != ''`, so leaving it unset simply disables
persistence — everything else keeps working.

## Cost

A few hundred KB of blob, one read and one write per run. Standard LRS hot
storage is ~$0.02/GB/month; transactions are fractions of a cent. Call it
noise against the AKS cluster.

## What this does not solve

**Time.** Scoring needs ten runs per test before it says anything
(`minRuns: 10`), and only main-branch runs write. Expect "insufficient data"
for the first week or two of adoption — that is the engine working, not
failing, and it is worth telling the team before someone reads it as broken.

`atest history stats --db <file>` reports the run count and warns while it is
below the threshold, so the wait is visible rather than mysterious.

Evidence egress is no longer a blocker: `extra-output-paths` on
`playwright-docker-tests.yml` mounts `.atest/` out of the test container.
Without that, run records were deleted with the container and this store would
have stayed empty.
