# fixture-app

A deliberately tiny app for testing **atest itself**. No Docker, no minikube, no
network, no dependencies — a ~150-line Node HTTP server started from Playwright's
`globalSetup`.

```sh
npm install
npx playwright install chromium
cd examples/fixture-app && npx playwright test      # ~1s
```

## Why it exists

The falsifiability gate's central claim is that mutating the API kills tests that
depend on the data. Neither other example can check that claim:

| Example | Has an API? | Runs in CI? | Can prove a mutant kills? |
| --- | --- | --- | --- |
| `smoke` | no — `page.setContent` | yes | **no** — every mutant is a no-op |
| `bjjeire-live` | yes, real | no — needs minikube | partly |
| `fixture-app` | yes, fixed | yes | **yes** |

Before this existed, CI could only prove the gate *restored* the spec it mutated.
It could not prove the gate *rejected* anything, because a test with no network
survives every mutant for uninteresting reasons.

## Two properties that are load-bearing

**Filtering happens server-side.** The `unfiltered` mutant strips the query string
and re-requests, so a page that fetches everything and filters in the browser
survives it untouched. Measured against the real BjjEire app, that is exactly what
happened: a correct search test survived `unfiltered` because the narrowing never
depended on the server. Here the server filters, so the mutant has something to
break — and `unfiltered` killing a filtering test is asserted in CI.

**The dataset is fixed.** Gate outcomes are reproducible: "did `unfiltered` kill
this?" has the same answer on every machine, instead of depending on whatever the
live environment currently holds. Treat `GYMS` in `server.ts` as a contract —
changing it changes gate outcomes.

## Keep it dumb

This is a fixture, not a replica. If it grows toward mirroring the real app it
becomes a second thing to maintain, it drifts, and a green run here stops telling
you anything about there. Anything needing real application behaviour belongs in
`examples/bjjeire-live`, against the real stack.
