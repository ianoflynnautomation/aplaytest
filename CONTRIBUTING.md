# Contributing

Thanks for wanting to work on atest. The project is a TypeScript monorepo
(`packages/*`) with a dual ESM + CommonJS build — Playwright resolves reporters
with `require()`, so the CJS entry is load-bearing, not a courtesy.

## Prerequisites

- Node.js 22 or later
- npm 10+ (workspaces)

## Setup

```sh
git clone https://github.com/ianoflynnautomation/aplaytest.git
cd aplaytest
npm install
npm run build
npm test
npm run typecheck
```

Useful scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | Dual ESM + CJS across the workspace |
| `npm test` | Full vitest run (unit + integration) |
| `npm run test:unit` | Fast `@unit` tests only |
| `npm run test:integration` | Filesystem, SQLite, Azurite, Playwright |
| `npm run typecheck` | `tsc --build` plus scripts |
| `npm run pack` | Installable tarballs in `dist-pack/` |

Against a locally running app, see [docs/13-local-testing.md](./docs/13-local-testing.md).

## Design constraints that PRs must not break

1. **The LLM is never in the pass/fail path.** CI runs in `strict` mode. A
   change that lets a model turn a red test green without a reviewable diff
   will be rejected.
2. **Engines do not import one another.** They depend on `@aplaytest/core` only.
   `core` has no Playwright, no network, and no model.
3. **`@aplaytest/runner-playwright` must not depend on `@aplaytest/llm`.** The reporter
   loads in every test worker; a credential must never be there.
4. **A reporting failure must never become a test failure.** The reporter
   swallows its own errors to stderr.
5. **Kinds in `NEVER_HEAL` stay unhealable.** Schema violations, uncaught app
   errors, HTTP status, network, navigation, and infra are the bug.

## Tests

New behaviour needs a test. Prefer the existing given/when/then titles:

```ts
it('given a missing test id -> when classify runs -> then the kind is locator_not_found', …)
```

Tag tests `@unit` or `@integration` so CI can split them. Do not add `any`.
Do not leave `console.log` in source. Do not commit `.env`, evidence bundles,
or run records.

## Pull requests

- Keep the diff scoped to the problem.
- Match the surrounding comment style: explain *why*, not *what*.
- Public exports go through each package's `src/index.ts`.
- `npm run build && npm test && npm run typecheck` must pass.

## Publishing (maintainers)

Do this **before** making the repository public, then cut the first tag.

1. **npm.** Create a granular access token on npmjs.com with read-and-write
   for the `@aplaytest` scope (or a classic token with publish). Add it as the
   repository secret `NPM_TOKEN`. A tag without this secret fails the npm
   job — that is intentional; a release that never reached npm is not a
   release.
2. **GHCR.** `docker-publish.yml` and `oci-publish.yml` try to mark
   `aplaytest`, `aplaytest-playwright`, and `aplaytest-packages` public after a
   successful push. GitHub often refuses that while the repo is still
   private. After you switch the repo to public, either re-run those
   workflows or set each package to Public under
   `https://github.com/users/<owner>/packages/container/<name>/settings`.
   Packages linked to this repository also inherit its visibility.
3. **First release.** `git tag v0.1.0 && git push origin v0.1.0`. That
   fires three independent workflows: npm, the OCI tarball bundle, and the
   container images. Until that tag exists, `atest-analyze.yml` defaults
   to image tag `main` (published on every merge). After `v0.1.0`, change
   `atest-tag`'s default in `.github/workflows/atest-analyze.yml` from
   `main` to `latest` (or `0.1.0`) and pin `examples/ci/atest-analyze.yml`
   to the same tag.

Publish workflows (independent; none `needs:` another):

| Workflow | Destination | When |
| --- | --- | --- |
| `npm-publish.yml` | registry.npmjs.org | `v*` tags |
| `oci-publish.yml` | `ghcr.io/…/aplaytest-packages` | `main` and tags |
| `docker-publish.yml` | `ghcr.io/…/aplaytest` (+ playwright on tags) | `main` and tags |

Reusable implementations live in this repository
(`docker-build-push.yml`, `oci-publish-tarballs.yml`). They do not call
another catalog.

## License

By contributing, you agree that your contributions are licensed under the MIT
License.
