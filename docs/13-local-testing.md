# 13 — Local testing and development

How to exercise `atest` against a locally running app (typically
`http://localhost:8080`). Two loops: one for **changing atest**, one for
**proving it against the real suite**.

Unit tests (`npm test` in this repo) never talk to the app. They are not a
substitute for either loop below.

The falsifiability-gate contract that CI runs is local too, and does not need
the BjjEire app — it uses the bundled fixture server:

```sh
npm run build
npx playwright install chromium
npm run test:gate
```

That is the same check as the Integration job. A failure prints both the
meaningful and vacuous payloads; do not re-wrap it in bash.


The blob history store has a second local contract, and it needs no app either
— just an emulator on `127.0.0.1:10000`:

```sh
npm run test:integration
```

Testcontainers starts a pinned Azurite image on a random port and stops it
afterwards, so it never fights the VS Code extension for port 10000. Without
Docker those tests skip and `npm test` stays green. Set `ATEST_AZURITE_URL` to
use an emulator you already have instead of starting a container. See
[12 — Azure history](./12-azure-history.md#testing-it-locally), including how to
keep the container and open it in Azure Storage Explorer.

---

## Prerequisites

- Node 22+
- The app under test already running (minikube, Docker Compose, or a local
  process). This document assumes `http://localhost:8080`.
- Prefer `127.0.0.1` over `localhost` if anything is in Docker or a
  devcontainer — IPv6 `localhost` is a common miss.

Override the origin with `BASE_URL` (and `API_URL` in `bjjeire-tests`).

---

## 1. Developing atest (fastest)

`examples/bjjeire-live` hits the real app, captures a real accessibility tree
and test-id index, and one test fails on purpose (`gym-card-name-v1`) so you
always get evidence.

```sh
# terminal A — app already running on :8080

# terminal B
cd /path/to/atest
npm install
npm run build          # examples consume dist/, not src/
npx playwright install chromium

cd examples/bjjeire-live
BASE_URL=http://localhost:8080 npm test
# expected: 2 pass, 1 fail (stale test id)
```

Then exercise the control plane from the **repo root**, so you pick up the CLI
you just built:

```sh
cd /path/to/atest
npx atest doctor
npx atest heal --evidence examples/bjjeire-live/.atest/evidence \
  --spec examples/bjjeire-live/tests/gyms.spec.ts
```

`--constants` is optional. Omit it and heal walks `heal.targets` (constants,
page objects, specs). In this example the stale id lives in the page module.

Inspect what the reporter wrote:

```sh
jq '{kind: .failure.kind, selector: .intent.selector, ids: .page.testIdsPresent}' \
  examples/bjjeire-live/.atest/evidence/*/*.json
```

**Inner loop while editing packages:** rebuild (`npm run build`, or
`npx tsc --build --watch` from the root), then re-run the example.

See [examples/bjjeire-live/README.md](../examples/bjjeire-live/README.md) for
why each capture piece is there.

---

## 2. Developing against `bjjeire-tests` (acceptance)

That suite is the real attach surface. Point it at the same origin:

```sh
cd /path/to/bjjeire-tests
APP_ENV=local BASE_URL=http://localhost:8080 API_URL=http://localhost:8080 \
  npx playwright test tests/features/gyms/gyms.ui.acceptance.spec.ts \
  --project=chromium-desktop --headed
```

Smoke first if you just want a green check:

```sh
APP_ENV=local BASE_URL=http://localhost:8080 API_URL=http://localhost:8080 \
  npm run test:smoke
```

To use the atest you are editing (not a released version):

```sh
# in atest
npm run pack
mkdir -p /path/to/bjjeire-tests/vendor
cp dist-pack/*.tgz /path/to/bjjeire-tests/vendor/

# in bjjeire-tests — ALL of them in one command. Each declares
# @atest/core@^0.1.0, and npm satisfies that from its siblings in the same
# invocation. Ask for one alone and it resolves against the registry, which
# gives you the last RELEASED core rather than the one you just built.
npm i ./vendor/*.tgz
```

For anything other than testing local edits, install from npm instead — the
packages are published under the `@atest` scope with real semver between them:

```sh
npm i -D @atest/runner-playwright @atest/cli
```

The reporter is not wired until you add it. `src/shared/config/playwright.ts`
builds the reporter list in `activeReporters()`:

```ts
reporters.push(['@atest/runner-playwright/reporter']);
```

Then after a failing gyms run:

```sh
npx atest doctor
npx atest heal --evidence .atest/evidence
```

API-only history, no reporter required:

```sh
npx atest history ingest --db .atest/history.sqlite \
  --playwright-json test-results/results.json
```

If you later run tests in Docker, evidence written under `.atest/` is lost
unless that path is mounted. See [11 — Adoption](./11-adoption-bjjeire.md).

---

## What to run for each job

| You are changing… | Run this |
| --- | --- |
| Core / heal / flaky logic | `npm test` in atest (vitest) |
| Reporter, capture, heal against a real page | `examples/bjjeire-live` + `atest heal` |
| Attach, CLI flags, flake/history on the real suite | `bjjeire-tests` gyms spec + `atest` CLI |
| Model ranking | same as live example, with `ANTHROPIC_API_KEY` set |

---

## Notes

- Point **`BASE_URL` and `API_URL` at the same origin** for local
  (`http://127.0.0.1:8080`).
- Heal needs a **failure**. The live example always has one. Against
  `bjjeire-tests`, wait for a real miss or temporarily break a testid.
- `ATEST=0` disables the reporter if a run is noisy.
- Rebuild atest (`npm run build` or `npm run pack`) before expecting
  `bjjeire-tests` to see source edits.

For day-to-day atest work, stay in **`examples/bjjeire-live`**. Drop into
**`bjjeire-tests`** when you need to prove attach, constants-file resolution,
or API JSON ingest against the suite you actually ship.
