# Security policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub security advisories](https://github.com/ianoflynnautomation/atest/security/advisories/new).
Do not open a public issue for a vulnerability that is still unfixed.

## What this project is careful about

- **The test job never holds a model API key.** `atest ci generate` emits
  workflows where the job that executes specs and the job that holds
  `ANTHROPIC_API_KEY` are different jobs. A pull request that edits a spec,
  a fixture, or `playwright.config.ts` can run arbitrary code in the test
  environment — a key there is one commit from exfiltration.
- **Evidence is redacted on the write path.** Bearer tokens, passwords, and
  configured keys are scrubbed before anything is persisted or sent to a
  model. See `evidence.redact` in `atest.config.ts`.
- **The MCP server is read-only by default.** Mutating tools require both
  `ATEST_MCP_WRITE=1` and `confirm: true` on the call.
- **Shared storage keys are an emulator affordance.** Production Azure
  accounts should disable shared keys; the blob driver uses
  `DefaultAzureCredential`.

## Secrets this repository itself uses

Publishing to npm needs `NPM_TOKEN` as a GitHub Actions secret. That workflow
(`npm-publish.yml`) fails closed when the token is absent. OCI and container
image publish are separate workflows and do not need it, so a fork can still
cut a tag and get GHCR artifacts.
