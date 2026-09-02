/**
 * Configuration: one file, fully typed, Zod-validated at load, every field
 * optional with a documented default.
 *
 * The defaults encode the project's core stance — `mode: 'strict'`,
 * `heal.apply: 'propose'`, quarantine expiry ON — so that a consumer who
 * writes `export default defineAtestConfig({})` gets the safe system rather
 * than an unconfigured one.
 */

import { z } from 'zod';
import { LOCATOR_STRATEGIES, MAX_STABILITY_RANK } from '../locator/stability.js';

export const ExecutionModeSchema = z.enum(['strict', 'assisted', 'agentic']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const AggressivenessSchema = z.enum(['off', 'conservative', 'balanced', 'aggressive']);
export type Aggressiveness = z.infer<typeof AggressivenessSchema>;

const PlaywrightSchema = z.object({
  /** Named Playwright configs this project can drive. */
  configs: z.record(z.string(), z.string()).prefault({}),
  defaultConfig: z.string().default('playwright.config.ts'),
});

const HistorySchema = z.object({
  /**
   * Chosen from `url`, not configured separately. Two fields naming one thing
   * can disagree, and `driver: 'sqlite'` beside an `azblob://` url has no
   * correct interpretation — so this is derived, and left here only because
   * `aplaytest doctor` and the report header print it.
   */
  driver: z.enum(['sqlite', 'azure-blob', 'memory']).default('sqlite'),
  /**
   * Where history lives. A path is a local SQLite file; `azblob://<account>/
   * <container>[/<prefix>]` is Azure Blob Storage; `:memory:` is a throwaway.
   *
   * `:memory:` is a footgun in CI and is deliberately NOT the default here —
   * with it, every run sees one attempt per test and flake scoring reports
   * "insufficient data" forever, which reads as the engine working.
   */
  url: z.string().default('.atest/history.sqlite'),
  /** Attempts older than this are pruned by `aplaytest history prune`. */
  retainDays: z.number().int().positive().default(90),
  /**
   * Days the blob driver downloads before scoring. Bounded on purpose: an
   * unbounded read gets slower every week until someone turns the feature off.
   * Keep it at or below `retainDays` — reading further back than prune keeps
   * only buys empty listings.
   */
  windowDays: z.number().int().positive().default(90),
});

const EvidenceSchema = z.object({
  dir: z.string().default('.atest/evidence'),
  retainRuns: z.number().int().positive().default(50),
  /**
   * Header/body/console keys scrubbed before anything is written to disk or
   * sent to a model. A suite with MSAL auth WILL capture bearer tokens.
   */
  redact: z
    .array(z.string())
    .default(['password', 'token', 'authorization', 'cookie', 'secret', 'api-key']),
  /** Token ceiling for the ARIA snapshot before truncation (marked explicitly). */
  ariaMaxTokens: z.number().int().positive().default(6_000),
});

const LlmSchema = z.object({
  /**
   * Model provider. Only `anthropic` is implemented; `none` disables the
   * model tier entirely. OpenAI and Ollama are not advertised here because
   * a config that parses and then silently uses a different provider is
   * worse than a config that fails at load.
   */
  provider: z.enum(['anthropic', 'none']).default('anthropic'),
  models: z
    .object({
      classify: z.string().default('claude-haiku-4-5'),
      heal: z.string().default('claude-sonnet-5'),
      author: z.string().default('claude-opus-5'),
      vision: z.string().default('claude-sonnet-5'),
    })
    .prefault({}),
  /**
   * Effort replaces temperature: sampling parameters are rejected outright by
   * current Opus/Sonnet models. See docs/10-recommendations.md.
   */
  effort: z
    .object({
      classify: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
      heal: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
      author: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('xhigh'),
    })
    .prefault({}),
  budget: z
    .object({
      perFailureUsd: z.number().positive().default(0.05),
      perRunUsd: z.number().positive().default(2.0),
    })
    .prefault({}),
});

const HealSchema = z.object({
  aggressiveness: AggressivenessSchema.default('balanced'),
  strategies: z.array(z.enum(['selector', 'assertion', 'flow'])).default(['selector']),
  /** Re-runs required before a proposal is considered validated. */
  validationRuns: z.number().int().min(1).default(3),
  /** Also re-run the rest of the spec file, to catch collateral damage. */
  validateCollateral: z.boolean().default(true),
  /** Reject candidates weaker than this rank. 4 = text; excludes css/xpath. */
  minStabilityRank: z.number().int().min(0).max(MAX_STABILITY_RANK).default(4),
  allowedStrategies: z.array(z.enum(LOCATOR_STRATEGIES)).default(['testid', 'role', 'label', 'text']),
  apply: z.enum(['propose', 'pr', 'local']).default('propose'),
  /** Glob patterns a heal patch is permitted to touch. */
  targets: z
    .array(z.string())
    .default([
      'src/**/*.constants.ts',
      'src/**/*.page.ts',
      'src/**/*.section.ts',
      'tests/**/*.spec.ts',
      'tests/**/*.test.ts',
    ]),
});

const FlakySchema = z.object({
  window: z
    .object({
      runs: z.number().int().positive().default(50),
      days: z.number().int().positive().default(14),
    })
    .prefault({}),
  /** Recency weighting: a failure this old counts half as much as one today. */
  halfLifeDays: z.number().positive().default(7),
  threshold: z.number().min(0).max(1).default(0.15),
  minRuns: z.number().int().positive().default(10),
  quarantine: z
    .object({
      policy: z.enum(['off', 'propose', 'auto']).default('propose'),
      expiryDays: z.number().int().positive().default(14),
      maxTests: z.number().int().nonnegative().default(5),
      maxRatio: z.number().min(0).max(1).default(0.02),
      tag: z.string().default('@quarantine'),
    })
    .prefault({}),
});

const ImpactSchema = z.object({
  enabled: z.boolean().default(true),
  /** Changing any of these runs the whole suite, no questions asked. */
  fullSuiteTriggers: z
    .array(z.string())
    .default([
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'playwright*.config.ts',
      'src/shared/**',
      'atest.config.ts',
      '.github/workflows/**',
      'Dockerfile',
    ]),
  /** Tags that always run regardless of impact selection. */
  alwaysRunTags: z.array(z.string()).default(['@smoke']),
  /** Above this share of the suite, just run everything. */
  fullSuiteThreshold: z.number().min(0).max(1).default(0.6),
});

const ConventionsSchema = z.object({
  titlePattern: z.string().default('^Given .+, when .+, then .+$'),
  requiredTags: z.array(z.string()).default([]),
  seededDataDir: z.string().default('tests/testdata/seeded'),
  /**
   * Paths no agent may write to, ever. The seeded data is the oracle: an
   * agent that can edit expected values can make any test pass.
   */
  forbidWriteTo: z
    .array(z.string())
    .default([
      'tests/testdata/seeded/**',
      '**/__screenshots__/**',
      '**/__aria__/**',
      '.env*',
      '.github/workflows/**',
      'atest.config.ts',
    ]),
  pageObjectDir: z.string().default('src/ui/pages'),
  /** Run against generated code before it is ever proposed. */
  verifyCommands: z.array(z.string()).default(['npm run typecheck', 'npm run lint']),
});

const IntegrationsSchema = z.object({
  github: z
    .object({
      autoComment: z.boolean().default(true),
      autoIssue: z.boolean().default(false),
      healBranchPrefix: z.string().default('atest/heal/'),
    })
    .prefault({}),
  otel: z
    .object({
      endpoint: z.string().nullable().default(null),
      queryUrl: z.string().nullable().default(null),
    })
    .prefault({}),
});

export const AtestConfigSchema = z.object({
  mode: ExecutionModeSchema.default('strict'),
  playwright: PlaywrightSchema.prefault({}),
  history: HistorySchema.prefault({}),
  evidence: EvidenceSchema.prefault({}),
  llm: LlmSchema.prefault({}),
  heal: HealSchema.prefault({}),
  flaky: FlakySchema.prefault({}),
  impact: ImpactSchema.prefault({}),
  conventions: ConventionsSchema.prefault({}),
  integrations: IntegrationsSchema.prefault({}),
});

export type AtestConfig = z.infer<typeof AtestConfigSchema>;
export type AtestConfigInput = z.input<typeof AtestConfigSchema>;

/**
 * Identity hooks. A consumer that already mints deterministic trace ids (an
 * OpenTelemetry reporter, for instance) passes them in here so history rows
 * join to existing app spans instead of inventing a parallel id space.
 */
export interface AtestIdentity {
  readonly runId?: () => string;
  readonly traceId?: (test: { id: string }, retry: number) => string;
}

export interface AtestUserConfig extends AtestConfigInput {
  readonly identity?: AtestIdentity;
}

export interface ResolvedAtestConfig extends AtestConfig {
  readonly identity: AtestIdentity;
}

/**
 * Validate user config and apply the safe defaults.
 *
 * An empty object yields `mode: 'strict'`, propose-only healing, and
 * quarantine expiry — a consumer who configures nothing must not get an
 * unguarded system. A misconfigured run fails here, at startup, not
 * halfway through a suite.
 *
 * @param input - Partial config plus optional identity hooks for run/trace ids.
 * @returns Every field filled, with `identity` attached (empty object if omitted).
 * @throws {Error} When a field fails Zod validation. The message is prefixed
 *   with `Invalid atest.config.ts:` and lists every issue.
 *
 * @example
 * ```ts
 * // atest.config.ts
 * import { defineAtestConfig } from '@aplaytest/core';
 *
 * export default defineAtestConfig({
 *   mode: 'strict',
 *   heal: { apply: 'propose' },
 * });
 * ```
 */
export function defineAtestConfig(input: AtestUserConfig = {}): ResolvedAtestConfig {
  const { identity, ...rest } = input;
  // Presets apply only when the user named an aggressiveness. Empty config
  // must stay propose-only — the balanced preset's `apply: 'pr'` would
  // otherwise override the safe default the rest of this function documents.
  const named = rest.heal?.aggressiveness;
  const preset = named === undefined ? undefined : AGGRESSIVENESS_PRESETS[named];
  const merged =
    preset === undefined
      ? rest
      : {
          ...rest,
          heal: { ...preset, ...rest.heal },
        };
  const parsed = AtestConfigSchema.safeParse(merged);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid atest.config.ts:\n${issues}`);
  }

  return { ...parsed.data, identity: identity ?? {} };
}

/**
 * Aggressiveness presets. Explicit fields in `heal` always win — the preset
 * only fills what the user did not state.
 */
export const AGGRESSIVENESS_PRESETS: Readonly<
  Record<Aggressiveness, Partial<z.infer<typeof HealSchema>>>
> = {
  off: { strategies: [], apply: 'propose' },
  conservative: {
    strategies: ['selector'],
    allowedStrategies: ['testid', 'role'],
    minStabilityRank: 1,
    validationRuns: 5,
    apply: 'propose',
  },
  balanced: {
    strategies: ['selector'],
    allowedStrategies: ['testid', 'role', 'label', 'text'],
    minStabilityRank: 4,
    validationRuns: 3,
    apply: 'pr',
  },
  aggressive: {
    strategies: ['selector', 'flow'],
    allowedStrategies: ['testid', 'role', 'label', 'text'],
    minStabilityRank: 4,
    validationRuns: 3,
    apply: 'local',
  },
};
