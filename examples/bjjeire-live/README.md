# bjjeire-live — capture against a real application

`examples/smoke` proves the reporter integrates with Playwright using
`page.setContent`. This example goes further: it runs the **capture fixtures**
against a real single-page app, so the evidence bundle contains a real
accessibility tree, the real test ids the app renders, and real network traffic.

That distinction matters. Every defect found in this package so far was found by
running against real output, not by reasoning about it.

## Prerequisites

A locally provisioned BjjEire environment on `http://localhost:8080`
(minikube — see `bjjeire-deploy/bjj-eire/artifact/LOCAL_DEVELOPMENT.md`).
Override with `BASE_URL` if yours differs.

```sh
npm install          # from the repo root
npm run build        # from the repo root — examples consume dist/
npm run setup        # downloads chromium
npm test             # exits 1: one test fails on purpose
```

## What it demonstrates

Three tests. Two pass; the third fails deliberately, referencing
`gym-card-name-v1` — a test id the application does not render. That simulates
the single most common real-world failure: **the app renamed a test id and the
suite has not caught up.**

The failing test produces this, with no model involved:

```
kind        locator_not_found
matcher     toBeVisible
selector    getByTestId('gym-card-name-v1').filter({ hasText: '011 Grappling' })

intent      gymsPage.goTo()
            gymsPage.searchFor('011 Grappling')
            gymsPage.expectCardDataStale('011 Grappling')   ← failing

page        /gyms?q=011+Grappling · 36 test ids present · 39 requests, all 200

candidates  0.10  getByTestId('gym-card-name')      ← the answer
            0.30  getByTestId('gym-card-address')
            0.30  getByTestId('gym-card-county')
            …
```

Read it yourself after a run:

```sh
jq '{kind: .failure.kind, intent: .intent.failingStep, candidates: .page.candidates}' \
  .atest/evidence/*/*.json
```

## Why each piece earns its place

| Piece | Without it |
| --- | --- |
| `bindPage(mod, page, 'gymsPage')` | The failure says a selector did not resolve. With it, the failure says what the test *wanted* — and the domain value `'011 Grappling'` is what candidate matching uses. |
| Capture fixtures (`auto: true`) | No ARIA tree and no test-id index, so "renamed or genuinely gone?" is unanswerable without opening a browser again. |
| Distance-ranked candidates | A real page carries ~36 test ids. Handing over all of them pushes the cost of choosing downstream; ranking puts the right one first at 0.10. |

## The composition

Adding capture is one spread in the fixture object — specs are untouched:

```ts
export const test = base.extend<{ gymsPage: BoundPageObject<typeof GymsPageMod> }>({
  ...atestFixtures,              // auto: true — no spec mentions it
  gymsPage: async ({ page }, use) => {
    await use(bindPage(GymsPageMod, page, 'gymsPage'));
  },
});
```
