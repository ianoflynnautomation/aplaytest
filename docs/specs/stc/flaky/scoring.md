# Flaky scoring knobs

**Feature ID:** `flaky.scoring`  
**Package:** `@aplaytest/flaky`  
**Config:** `atest.config.ts` → `flaky.*`  
**Env:** `ATEST_FLAKY_*`  
**Workflow:** `.github/workflows/atest-analyze.yml` inputs `min-runs`, `half-life-days`, `flake-threshold`, `window-runs`

A (test, project) pair is scored only from recorded attempts. No model is in this path.

## Description

Flake scoring needs a minimum sample, a recency half-life, a threshold, and a history window. Those numbers used to be duplicated in the engine, the Zod schema, and a hardcoded `runs < 10` in the analyze job. They are one table of defaults. CI overrides them through environment variables because the analyze job does not check out the consumer repo.

## Acceptance criteria

### AC-01 — Insufficient data below minRuns

Given fewer than `minRuns` conclusive attempts for a (test, project) pair  
When `scoreTest` runs  
Then `insufficientData` is true, `score` is 0, and `isFlaky` is false.

Default `minRuns` is 10 (`FLAKY_DEFAULTS.minRuns`).

### AC-02 — Override precedence

Given CLI flags, `ATEST_FLAKY_*` environment variables, and engine defaults  
When `resolveAnalyzeConfig` runs  
Then CLI flags beat environment variables beat `FLAKY_DEFAULTS`.

The GitHub analyze workflow sets the env vars from workflow inputs so a caller can pass `min-runs: 5` without a config file in the container.

### AC-03 — Invalid overrides fail closed

Given a non-positive or non-numeric `ATEST_FLAKY_MIN_RUNS` (or `--min-runs`)  
When scoring is resolved  
Then the CLI exits usage (2) rather than silently using 10.

### AC-04 — Schema and engine share literals

Given `defineAtestConfig({})`  
When defaults are read  
Then `flaky.minRuns`, `flaky.halfLifeDays`, `flaky.threshold`, and `flaky.window.runs` equal `FLAKY_DEFAULTS`.

## Data contracts

| Knob | Type | Default | Config path | Env | CLI | Workflow input |
| --- | --- | --- | --- | --- | --- | --- |
| Minimum conclusive attempts | positive int | 10 | `flaky.minRuns` | `ATEST_FLAKY_MIN_RUNS` | `--min-runs` | `min-runs` |
| Recency half-life (days) | positive number | 7 | `flaky.halfLifeDays` | `ATEST_FLAKY_HALF_LIFE_DAYS` | `--half-life-days` | `half-life-days` |
| Flake score threshold | 0..1 | 0.15 | `flaky.threshold` | `ATEST_FLAKY_THRESHOLD` | `--threshold` | `flake-threshold` |
| Attempts pulled per pair | positive int | 50 | `flaky.window.runs` | `ATEST_FLAKY_WINDOW_RUNS` | `--window-runs` | `window-runs` |

## Edge cases

- Empty env string is "unset", not zero — otherwise a workflow that passes a blank input would score every test on one attempt.
- Infra / skipped / interrupted attempts do not count toward `minRuns`.
- Store-level "runs in history" in the job summary uses `report.config.minRuns`, not a second literal 10.
