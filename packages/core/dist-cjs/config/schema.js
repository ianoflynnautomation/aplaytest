"use strict";
/**
 * Configuration: one file, fully typed, Zod-validated at load, every field
 * optional with a documented default.
 *
 * The defaults encode the project's core stance — `mode: 'strict'`,
 * `heal.apply: 'propose'`, quarantine expiry ON — so that a consumer who
 * writes `export default defineAtestConfig({})` gets the safe system rather
 * than an unconfigured one.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGGRESSIVENESS_PRESETS = exports.AtestConfigSchema = exports.AggressivenessSchema = exports.ExecutionModeSchema = void 0;
exports.defineAtestConfig = defineAtestConfig;
const zod_1 = require("zod");
const stability_js_1 = require("../locator/stability.js");
exports.ExecutionModeSchema = zod_1.z.enum(['strict', 'assisted', 'agentic']);
exports.AggressivenessSchema = zod_1.z.enum(['off', 'conservative', 'balanced', 'aggressive']);
const PlaywrightSchema = zod_1.z.object({
    /** Named Playwright configs this project can drive. */
    configs: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).prefault({}),
    defaultConfig: zod_1.z.string().default('playwright.config.ts'),
});
const HistorySchema = zod_1.z.object({
    driver: zod_1.z.enum(['sqlite', 'postgres']).default('sqlite'),
    url: zod_1.z.string().default('.atest/history.sqlite'),
    /** Attempts older than this are pruned by `atest history prune`. */
    retainDays: zod_1.z.number().int().positive().default(90),
});
const EvidenceSchema = zod_1.z.object({
    dir: zod_1.z.string().default('.atest/evidence'),
    retainRuns: zod_1.z.number().int().positive().default(50),
    /**
     * Header/body/console keys scrubbed before anything is written to disk or
     * sent to a model. A suite with MSAL auth WILL capture bearer tokens.
     */
    redact: zod_1.z
        .array(zod_1.z.string())
        .default(['password', 'token', 'authorization', 'cookie', 'secret', 'api-key']),
    /** Token ceiling for the ARIA snapshot before truncation (marked explicitly). */
    ariaMaxTokens: zod_1.z.number().int().positive().default(6_000),
});
const LlmSchema = zod_1.z.object({
    provider: zod_1.z.enum(['anthropic', 'openai', 'ollama', 'none']).default('anthropic'),
    models: zod_1.z
        .object({
        classify: zod_1.z.string().default('claude-haiku-4-5'),
        heal: zod_1.z.string().default('claude-sonnet-5'),
        author: zod_1.z.string().default('claude-opus-5'),
        vision: zod_1.z.string().default('claude-sonnet-5'),
    })
        .prefault({}),
    /**
     * Effort replaces temperature: sampling parameters are rejected outright by
     * current Opus/Sonnet models. See docs/10-recommendations.md.
     */
    effort: zod_1.z
        .object({
        classify: zod_1.z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
        heal: zod_1.z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
        author: zod_1.z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('xhigh'),
    })
        .prefault({}),
    budget: zod_1.z
        .object({
        perFailureUsd: zod_1.z.number().positive().default(0.05),
        perRunUsd: zod_1.z.number().positive().default(2.0),
    })
        .prefault({}),
});
const HealSchema = zod_1.z.object({
    aggressiveness: exports.AggressivenessSchema.default('balanced'),
    strategies: zod_1.z.array(zod_1.z.enum(['selector', 'assertion', 'flow'])).default(['selector']),
    /** Re-runs required before a proposal is considered validated. */
    validationRuns: zod_1.z.number().int().min(1).default(3),
    /** Also re-run the rest of the spec file, to catch collateral damage. */
    validateCollateral: zod_1.z.boolean().default(true),
    /** Reject candidates weaker than this rank. 4 = text; excludes css/xpath. */
    minStabilityRank: zod_1.z.number().int().min(0).max(stability_js_1.MAX_STABILITY_RANK).default(4),
    allowedStrategies: zod_1.z.array(zod_1.z.enum(stability_js_1.LOCATOR_STRATEGIES)).default(['testid', 'role', 'label', 'text']),
    apply: zod_1.z.enum(['propose', 'pr', 'local']).default('propose'),
    /** Glob patterns a heal patch is permitted to touch. */
    targets: zod_1.z.array(zod_1.z.string()).default(['src/**/*.constants.ts', 'src/**/*.page.ts']),
});
const FlakySchema = zod_1.z.object({
    window: zod_1.z
        .object({
        runs: zod_1.z.number().int().positive().default(50),
        days: zod_1.z.number().int().positive().default(14),
    })
        .prefault({}),
    /** Recency weighting: a failure this old counts half as much as one today. */
    halfLifeDays: zod_1.z.number().positive().default(7),
    threshold: zod_1.z.number().min(0).max(1).default(0.15),
    minRuns: zod_1.z.number().int().positive().default(10),
    quarantine: zod_1.z
        .object({
        policy: zod_1.z.enum(['off', 'propose', 'auto']).default('propose'),
        expiryDays: zod_1.z.number().int().positive().default(14),
        maxTests: zod_1.z.number().int().nonnegative().default(5),
        maxRatio: zod_1.z.number().min(0).max(1).default(0.02),
        tag: zod_1.z.string().default('@quarantine'),
    })
        .prefault({}),
});
const ImpactSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().default(true),
    /** Changing any of these runs the whole suite, no questions asked. */
    fullSuiteTriggers: zod_1.z
        .array(zod_1.z.string())
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
    alwaysRunTags: zod_1.z.array(zod_1.z.string()).default(['@smoke']),
    /** Above this share of the suite, just run everything. */
    fullSuiteThreshold: zod_1.z.number().min(0).max(1).default(0.6),
});
const ConventionsSchema = zod_1.z.object({
    titlePattern: zod_1.z.string().default('^Given .+, when .+, then .+$'),
    requiredTags: zod_1.z.array(zod_1.z.string()).default([]),
    seededDataDir: zod_1.z.string().default('tests/testdata/seeded'),
    /**
     * Paths no agent may write to, ever. The seeded data is the oracle: an
     * agent that can edit expected values can make any test pass.
     */
    forbidWriteTo: zod_1.z
        .array(zod_1.z.string())
        .default([
        'tests/testdata/seeded/**',
        '**/__screenshots__/**',
        '**/__aria__/**',
        '.env*',
        '.github/workflows/**',
        'atest.config.ts',
    ]),
    pageObjectDir: zod_1.z.string().default('src/ui/pages'),
    /** Run against generated code before it is ever proposed. */
    verifyCommands: zod_1.z.array(zod_1.z.string()).default(['npm run typecheck', 'npm run lint']),
});
const IntegrationsSchema = zod_1.z.object({
    github: zod_1.z
        .object({
        autoComment: zod_1.z.boolean().default(true),
        autoIssue: zod_1.z.boolean().default(false),
        healBranchPrefix: zod_1.z.string().default('atest/heal/'),
    })
        .prefault({}),
    otel: zod_1.z
        .object({
        endpoint: zod_1.z.string().nullable().default(null),
        queryUrl: zod_1.z.string().nullable().default(null),
    })
        .prefault({}),
});
exports.AtestConfigSchema = zod_1.z.object({
    mode: exports.ExecutionModeSchema.default('strict'),
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
/**
 * Validate and apply defaults. Throws with a readable message on invalid
 * config — a misconfigured run must fail at startup, not halfway through.
 */
function defineAtestConfig(input = {}) {
    const { identity, ...rest } = input;
    const parsed = exports.AtestConfigSchema.safeParse(rest);
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
exports.AGGRESSIVENESS_PRESETS = {
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
//# sourceMappingURL=schema.js.map