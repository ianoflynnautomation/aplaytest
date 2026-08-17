# smoke — the integration check

Unit tests cover the parsing and assembly logic in isolation. This project is the
only thing that exercises the reporter against **real Playwright output**, and it
has already earned its place: the first live run surfaced two defects the unit
tests could not, because those fixtures were written from clean prose.

1. Playwright embeds **ANSI colour codes** in `error.message` even when stdout is
   not a TTY. They split the matcher name mid-word, so every pattern silently
   failed to match — and they are pure waste in a model's token budget.
2. Playwright **no longer emits `Received:`** for assertion failures. The observed
   value now arrives as a second `Error:` line.

Both are now regression-tested with verbatim captured strings.

## Run it

```sh
npm install
npm run setup      # downloads chromium
npm test           # exits 1 — two of the three tests fail on purpose
```

Then inspect what the reporter produced:

```sh
cat .atest/runs/*.json | jq '.attempts[] | {title, outcome, failureKind}'
jq '{kind: .failure.kind, intent: .intent.failingStep, selector: .intent.selector}' \
  .atest/evidence/*/*.json
```

## What it proves

| Invariant | How |
| --- | --- |
| The reporter never changes the verdict | Playwright still exits 1 |
| `ATEST=0` is a complete kill switch | `ATEST=0 npm test` writes no `.atest/` at all |
| A missing browser is `infra`, not a locator bug | Run before `npm run setup` — all failures classify as `infra` and none reach healing |
| Domain intent survives to the bundle | The renamed-testid failure records `gymsPage.expectCardData(['Blackwater Valley BJJ'])` |

No server is needed — the tests use `page.setContent`, so nothing here touches a
real application.
