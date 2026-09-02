# atest as a container.
#
# ── What this is for ──────────────────────────────────────────────────────────
# The analyze job. Today a consumer runs five steps to get one CLI onto a
# runner — setup-node, oras login, oras pull, untar, npm install — and
# bjjeire-java pays all of it to run `npx atest` in a repository that is
# otherwise entirely Java. An image collapses that to `container:`.
#
# It does NOT replace the tarball bundle published by npm-tarball-publish-oci.
# The two serve different consumers and both are needed:
#
#   tarballs → a Node repo that installs atest as a DEPENDENCY, because the
#              reporter has to load inside the Playwright process
#   image    → a CI job that only wants to RUN the CLI, in any language's repo
#
# ── Two targets, because atest is two things ──────────────────────────────────
#   cli         history · flaky · report · impact · doctor · ci generate
#               No browser. Small. This is what an analyze job wants.
#   playwright  adds gate · heal · flaky bisect · agent author, which SPAWN
#               Playwright and therefore need browsers and the consumer's spec
#               files on a volume. Measured: ~4 GB against ~0.5 GB — eight
#               times the pull for four commands most jobs never run, which is
#               why it is a separate target rather than a fatter default.
#
#   docker build --target cli        -t atest .
#   docker build --target playwright -t atest-playwright .
#
# @atest/runner-playwright is deliberately NOT a use case for either. The
# reporter is loaded by `require` from inside the test process; it belongs in
# the test suite's own image, installed from the tarballs.

# Declared BEFORE the first FROM on purpose: an ARG used in a FROM line must be
# in the global scope. Declared inside a stage it silently expands to empty,
# and the build fails resolving `playwright:v-noble` — a confusing error for
# what is only a scoping rule.
ARG PLAYWRIGHT_VERSION=1.61.0

# ── builder ───────────────────────────────────────────────────────────────────
# Builds and packs exactly the way CI does, so an image and a published bundle
# cannot be built from different code paths.
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Manifests first, so a source-only change does not re-resolve the dependency
# tree. The workspace package.json files are needed too — npm ci reads every
# one of them to build the workspace graph, and copying only the root lockfile
# gives "npm ci can only install with an existing package-lock.json".
COPY package.json package-lock.json ./
COPY packages/core/package.json                packages/core/
COPY packages/store-azure/package.json         packages/store-azure/
COPY packages/runner-playwright/package.json   packages/runner-playwright/
COPY packages/llm/package.json                 packages/llm/
COPY packages/agent/package.json               packages/agent/
COPY packages/flaky/package.json               packages/flaky/
COPY packages/heal/package.json                packages/heal/
COPY packages/impact/package.json              packages/impact/
COPY packages/report/package.json              packages/report/
COPY packages/author/package.json              packages/author/
COPY packages/mcp/package.json                 packages/mcp/
COPY packages/cli/package.json                 packages/cli/
COPY examples/smoke/package.json               examples/smoke/
COPY examples/fixture-app/package.json         examples/fixture-app/
COPY examples/bjjeire-live/package.json        examples/bjjeire-live/

# --ignore-scripts: nothing in this tree needs a postinstall, and a build that
# runs arbitrary install hooks is a supply-chain surface for no benefit.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig*.json ./
COPY packages/ packages/
COPY scripts/ scripts/

# Same two commands CI runs. `pack` re-runs the build and asserts every tarball
# carries a dist/, so a tarball that would install and then fail at import time
# never reaches the runtime stage.
RUN npm run build && npm run pack

# ── cli ───────────────────────────────────────────────────────────────────────
# Debian, not Alpine, and the 118 MB is bought deliberately.
#
# Alpine builds and runs fine — measured: 390 MB against 508 MB, every smoke
# test below passing, ingest and scoring byte-identical. What it does not do
# reliably is host a GitHub Actions `container:` job, which is this image's
# whole reason to exist: the runner mounts its own externals directory and
# executes a glibc-linked node from it, which musl cannot run. Trading the
# primary use case for 23% is a bad deal. Switch the base if you only ever
# `docker run` it.
FROM node:22-bookworm-slim AS cli

# APP_VERSION, not ATEST_VERSION, because docker-build-push.yml auto-injects
# that exact name from the tag docker/metadata-action resolved. Naming it
# anything else means the label silently keeps its default while the workflow
# passes a build arg nothing consumes — buildx warns and everyone ignores it.
#
# Read by anyone staring at a container wondering which commit produced it.
# Re-declared: a global ARG is visible to FROM lines, but a stage must ask for
# it again to use it in a RUN.
ARG PLAYWRIGHT_VERSION
ARG APP_VERSION=0.0.0
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="atest" \
      org.opencontainers.image.description="A control plane around Playwright: flake scoring, healing, impact analysis" \
      org.opencontainers.image.source="https://github.com/ianoflynnautomation/atest" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"

# Installed into a real project directory, NOT with `npm install -g`.
#
# A global install puts each package at the top of the global tree, where
# nothing can resolve its siblings: `require('@atest/runner-playwright/…')`
# fails from any cwd, and — the one that matters — the CLI's dynamic
# `import('@atest/store-azure')` fails too, because Node resolves it relative
# to the CLI's own location and there is no node_modules above it holding the
# driver. `--db azblob://…` would have degraded to "install the Azure driver"
# in an image built specifically to contain it.
#
# A flat node_modules is the layout every consumer already gets from
# `npm i ./*.tgz`, so the image exercises the same resolution the tarballs do.
#
# ALL of them in one command, for the reason `scripts/pack.ts` documents: the
# packages resolve each other by `file:` specifier and none is on a public
# registry, so installing any one alone 404s on @atest/core.
COPY --from=builder /build/dist-pack/*.tgz /tmp/atest/
# The directory must not be called `atest`: npm refuses to install a package
# into a project of the same name.
#
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is not decoration. `playwright` arrives
# transitively (the flaky engine spawns it) and its postinstall would pull
# ~400 MB of browsers into an image whose entire purpose is NOT needing them.
# It currently does not, because npm only runs the hook when the package tree
# says to — which is a property of the dependency graph, not a decision anyone
# made. Stating it means a future transitive change cannot quietly quadruple
# the image. The `playwright` target below wants browsers and gets them from
# its base, already installed.
#
# @playwright/test IS PINNED HERE, not just in package.json. This is a fresh
# `npm install` of tarballs with no lockfile, so it resolves
# @atest/runner-playwright's peer range (`>=1.55.0`) against the registry and
# takes the newest — 1.62.1 today, whatever ships tomorrow. The workspace pin
# governs the BUILD; only this governs the IMAGE. Without it the playwright
# target inherits a browser bundle its base does not have, and the version
# that lands in the image changes with the date rather than with a commit.
RUN mkdir -p /opt/atest-runtime \
    && printf '{"name":"atest-runtime","private":true,"version":"0.0.0"}\n' > /opt/atest-runtime/package.json \
    && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
       npm install --prefix /opt/atest-runtime --no-audit --no-fund --omit=dev \
       /tmp/atest/*.tgz "@playwright/test@${PLAYWRIGHT_VERSION}" \
    && rm -rf /tmp/atest /root/.npm /root/.cache

# NODE_PATH is for CommonJS callers only — a consumer whose script does
# `require('@atest/runner-playwright/reporter')` from the mounted workspace.
# IT DOES NOT AFFECT ESM: Node's ESM resolver ignores NODE_PATH entirely and
# resolves bare specifiers relative to the importing module's own URL. That is
# fine, and is why the install location matters more than this variable — the
# CLI's `import('@atest/store-azure')` works because the driver is its SIBLING
# in /opt/atest-runtime/node_modules, not because of anything set here.
ENV NODE_PATH=/opt/atest-runtime/node_modules \
    PATH=/opt/atest-runtime/node_modules/.bin:$PATH

# Non-root. GitHub Actions `container:` jobs run as root by default and will
# happily leave root-owned files in the workspace, which the next step then
# cannot clean up; `node` (uid 1000) matches the runner's user.
USER node
WORKDIR /workspace

# Fail the BUILD, not somebody's pipeline, if the image cannot do its job.
# Each of these has broken in a way `npm install` could not see: the built-in
# SQLite module, the CJS reporter entry, and the Azure driver's resolution.
#
# The ESM check runs from /opt/atest-runtime deliberately. Run from /workspace
# it fails with ERR_MODULE_NOT_FOUND even on a perfectly good image, because
# ESM ignores NODE_PATH — asserting from there would test the resolution rules,
# not the image, and the honest question is whether the CLI can reach the
# driver from where the CLI actually lives.
RUN atest --help > /dev/null \
    && node -e "require('node:sqlite')" \
    && node -e "const r=require('@atest/runner-playwright/reporter'); if (typeof r.default!=='function') throw new Error('CJS reporter did not load')" \
    && cd /opt/atest-runtime \
    && node --input-type=module -e "const m = await import('@atest/store-azure'); if (typeof m.BlobHistoryStore !== 'function') throw new Error('Azure driver did not load');" \
    && node --input-type=module -e "const { parseHistoryUrl } = await import('@atest/core'); if (parseHistoryUrl('azblob://acct/atest-history').kind !== 'azure-blob') throw new Error('history URL parsing broken');"

# `docker run atest history stats`. GitHub Actions overrides the entrypoint for
# `container:` jobs and runs steps through a shell, which this image has, so
# both usages work from one definition.
ENTRYPOINT ["atest"]
CMD ["--help"]

# ── playwright ────────────────────────────────────────────────────────────────
# Everything above plus browsers, for the commands that spawn Playwright.
#
# THE TAG AND THE npm VERSION ARE ONE DECISION. The base ships a specific
# browser build and the npm package demands exactly that build: v1.61.0-noble
# carries chromium-1228, and playwright 1.62.1 looks for chromium-1234 and
# refuses to start. This is pinned to 1.61.0 in package.json and
# packages/runner-playwright/package.json, exactly — a caret there would let a
# fresh install drift away from this tag.
#
# Keeping them together is not only about starting: a heal or a gate verdict
# validated against a different browser build than CI runs is not validated,
# and screenshot rendering changes between builds.
#
# The launch check at the end of this stage enforces the pairing at BUILD time,
# and Playwright's own error names the tag to move to. That is how the 1.62.1
# drift was found rather than shipped.
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS playwright

ARG APP_VERSION=0.0.0
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="atest-playwright" \
      org.opencontainers.image.description="atest plus browsers: gate, heal, bisect and authoring" \
      org.opencontainers.image.source="https://github.com/ianoflynnautomation/atest" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"

# COPIED from the cli stage, not installed again.
#
# It was a second `npm install -g` until it was caught: that layout cannot
# resolve `import('@atest/store-azure')` from the CLI, so this image shipped
# with the Azure driver unreachable — and its own smoke test, which only ran
# `atest --help`, passed anyway. Two stages installing "the same" thing two
# ways is how they drift; copying one tree makes drift impossible and gives
# both images provably identical atest bits.
COPY --from=cli /opt/atest-runtime /opt/atest-runtime

ENV NODE_PATH=/opt/atest-runtime/node_modules \
    PATH=/opt/atest-runtime/node_modules/.bin:$PATH

USER pwuser
WORKDIR /workspace

# The same checks the cli stage runs — the bug above existed because this
# stage checked less — plus the one thing that is only true here: a browser
# that actually launches. An image carrying 3 GB of browsers that cannot start
# one is worth catching at build time.
RUN atest --help > /dev/null \
    && node -e "require('node:sqlite')" \
    && cd /opt/atest-runtime \
    && node --input-type=module -e "const m = await import('@atest/store-azure'); if (typeof m.BlobHistoryStore !== 'function') throw new Error('Azure driver did not load');" \
    && node --input-type=module -e "const { chromium } = await import('playwright'); const b = await chromium.launch(); await b.close();"

ENTRYPOINT ["atest"]
CMD ["--help"]
