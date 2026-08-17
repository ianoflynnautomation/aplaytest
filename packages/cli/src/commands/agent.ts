/**
 * `atest agent author` — ground, plan, synthesize, gate.
 *
 * The orchestration lives in the CLI rather than in an engine package because
 * the CLI is the composition root: @atest/author must not import @atest/agent,
 * or the deterministic gate would drag the model tier in behind it and stop
 * being installable on its own.
 *
 * The safety property this command exists to guarantee:
 *
 *   A GENERATED TEST THAT FAILS THE GATE IS NOT LEFT IN THE WORKING TREE.
 *
 * A rejected candidate is a test that passes while asserting nothing. Leaving
 * one on disk is strictly worse than generating nothing at all — it is green,
 * it looks like coverage, and it will be committed by someone who assumes the
 * tool would not have written it if it were worthless.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { runAuthorAgent, type AuthorGrounding } from '@atest/agent';
import { falsifiabilityGate, ground } from '@atest/author';
import { BudgetGuard, createLlmClient, describeAvailability, type LlmClient } from '@atest/llm';

import { EXIT, PolicyError, UsageError, type ExitCode } from '../exit.js';
import { heading, line, style, warn } from '../ui/output.js';

export interface AgentFlags {
  readonly goal?: string | undefined;
  readonly feature?: string | undefined;
  readonly cwd?: string | undefined;
  readonly out?: string | undefined;
  readonly config?: string | undefined;
  readonly project?: string | undefined;
  readonly validate?: string | undefined;
  readonly apiPattern?: string | undefined;
  readonly planOnly: boolean;
  readonly keepRejected: boolean;
  readonly force: boolean;
  readonly noLlm: boolean;
  readonly json: boolean;
  readonly dryRun: boolean;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * Read the test title out of the generated spec.
 *
 * The gate greps Playwright by title, and the obvious assumption — that the
 * spec uses the plan's title verbatim — is wrong. Measured on a live run, the
 * plan said "Given the gyms directory, when a visitor searches for a gym by
 * name, then only that gym is listed" and the model wrote
 * `test('searching by name narrows the gyms directory to only that gym')`,
 * which is the better title for a spec file. The grep matched nothing, so a
 * genuinely good generated test was reported as an inconclusive gate run and
 * deleted.
 *
 * Reading the file is authoritative; the plan title is a fallback.
 */
export function extractTestTitle(spec: string): string | null {
  const match = /(?:^|\n)\s*test(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/.exec(spec);
  const title = match?.[2];
  if (title === undefined || title.trim() === '') return null;
  // A template literal with an interpolation cannot be grepped literally.
  return title.includes('${') ? null : title;
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path, 'utf8').then(
    () => true,
    () => false,
  );
}

export interface AgentDeps {
  /**
   * Injected client. The composition root builds the real one; tests supply a
   * scripted fake so the delete-on-reject path — the property this command
   * exists for — is verifiable without an API key.
   */
  readonly client?: LlmClient | undefined;
}

export async function agentAuthor(flags: AgentFlags, deps: AgentDeps = {}): Promise<ExitCode> {
  if (flags.goal === undefined) {
    throw new UsageError('atest agent author requires --goal "<what to test>".');
  }
  const feature = flags.feature ?? slug(flags.goal).split('-')[0] ?? 'unknown';
  const cwd = resolve(flags.cwd ?? process.cwd());

  // ── Phase 1: Ground (deterministic, no model, no network) ──────────────
  const grounding = await ground({ cwd, feature });

  if (flags.dryRun) {
    // Worth its own flag: when a generation comes out wrong, the first
    // question is what the agent was actually shown, and this answers it
    // without spending anything.
    heading(`grounding for "${feature}"`);
    line(`  conventions   ${grounding.conventionsPath ?? style.yellow('not found')}`);
    line(`  page object   ${grounding.pageObjectPath ?? style.yellow('not found')}`);
    line(`  seeded data   ${grounding.seededDataPath ?? style.yellow('not found')}`);
    for (const exemplar of grounding.exemplars) {
      line(`  exemplar      ${exemplar.path} ${style.dim(`(${exemplar.reason})`)}`);
    }
    if (grounding.pageObjectApi.length > 0) {
      line();
      line(style.dim('  page object API'));
      for (const signature of grounding.pageObjectApi) line(style.dim(`    ${signature}`));
    }
    if (grounding.missing.length > 0) {
      line();
      warn('not found:');
      for (const item of grounding.missing) line(style.dim(`  ${item}`));
    }
    return EXIT.OK;
  }

  const llm = deps.client ?? createLlmClient({ disabled: flags.noLlm });
  if (!llm.available) {
    // Authoring is the one capability that genuinely cannot degrade: there is
    // no deterministic tier that writes a test. Say so plainly and exit 3
    // rather than pretending a fallback exists.
    warn('Authoring requires a model, and none is configured.');
    line(style.dim('  Set ANTHROPIC_API_KEY, or run with --dry-run to inspect the grounding.'));
    return EXIT.LLM_UNAVAILABLE;
  }

  heading(`authoring: ${flags.goal}`);
  line(style.dim(`  ${describeAvailability(llm, ['author'])}`));
  if (grounding.missing.length > 0) {
    line(style.dim(`  grounding gaps: ${grounding.missing.join('; ')}`));
  }

  // ── Phases 2–4: Plan and synthesize ────────────────────────────────────
  const authorGrounding: AuthorGrounding = {
    feature,
    conventions: grounding.conventions,
    pageObjectApi: grounding.pageObjectApi,
    pageObjectPath: grounding.pageObjectPath,
    seededData: grounding.seededData,
    exemplars: grounding.exemplars.map(e => ({ path: e.path, source: e.source, reason: e.reason })),
  };

  const outcome = await runAuthorAgent(
    llm,
    { goal: flags.goal, grounding: authorGrounding },
    { budget: new BudgetGuard(), planOnly: flags.planOnly },
  );

  if (outcome.status === 'unavailable' || outcome.status === 'declined') {
    line();
    warn(`${outcome.status}: ${outcome.reason}`);
    line(style.dim(`  spent $${outcome.costUsd.toFixed(4)}`));
    return outcome.status === 'declined' ? EXIT.POLICY_VIOLATION : EXIT.LLM_UNAVAILABLE;
  }

  const { plan } = outcome;
  line();
  line(style.bold(`  ${plan.title}`));
  for (const step of plan.steps) line(`    · ${step}`);
  line();
  line(`  expects to die from: ${style.cyan(plan.expectedToDieFrom)}`);
  if (plan.expectedToDieFrom === 'none' || plan.expectedToDieFrom === 'http-500') {
    // Said before the code exists, and usually right: the gate confirms it a
    // few minutes later at the cost of a full mutant sweep.
    warn('  the plan cannot name a data mutation that would break this test');
  }

  if (outcome.status === 'planned') {
    line();
    line(style.dim(`  plan only — no code generated. Spent $${outcome.costUsd.toFixed(4)}.`));
    return EXIT.OK;
  }

  const { draft } = outcome;
  if (draft.needsNewPageObjectMethod) {
    line();
    warn('the draft needs a page-object method that does not exist yet:');
    line(style.dim(`  ${draft.notes}`));
    line(style.dim('  Add the method, then re-run — the agent will not write raw locators around it.'));
    return EXIT.POLICY_VIOLATION;
  }

  // ── Write the candidate ────────────────────────────────────────────────
  const outPath = flags.out ?? join('tests', `${slug(plan.title)}.spec.ts`);
  const absolute = resolve(cwd, outPath);

  if (!flags.force && (await fileExists(absolute))) {
    throw new UsageError(`${outPath} already exists. Pass --force to overwrite, or --out <path>.`);
  }

  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, draft.spec, 'utf8');
  line();
  line(`  wrote ${outPath}`);

  const testTitle = extractTestTitle(draft.spec) ?? plan.title;
  if (testTitle !== plan.title) {
    line(style.dim(`  test title: ${testTitle}`));
  }

  // ── Phase 5: Verify (deterministic; the model cannot overrule it) ──────
  line(style.dim('  running the falsifiability gate…'));
  const gateResult = await falsifiabilityGate({
    cwd,
    specFile: outPath,
    testTitle,
    ...(flags.config === undefined ? {} : { config: flags.config }),
    ...(flags.project === undefined ? {} : { project: flags.project }),
    ...(flags.validate === undefined ? {} : { stabilityRuns: Number.parseInt(flags.validate, 10) }),
    ...(flags.apiPattern === undefined ? {} : { apiPattern: flags.apiPattern }),
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ plan, gate: gateResult, costUsd: outcome.costUsd }, null, 2)}\n`);
  } else {
    line();
    for (const check of gateResult.checks) {
      const mark = check.ok ? style.green('pass') : style.red('FAIL');
      line(`  ${mark}  ${check.name.padEnd(15)} ${check.detail}`);
    }
    line();
    line(`  ${gateResult.summary}`);

    // Score the prediction the plan made before the code existed. The agent
    // committing to a failure mode is only worth asking for if somebody checks
    // it — and a miss is informative about the APP, not just the agent: a test
    // that survives the mutation its author expected to kill it usually means
    // the behaviour under test is not where they thought it was.
    const predicted = gateResult.mutants.find(m => m.name === plan.expectedToDieFrom);
    if (predicted !== undefined && !predicted.killed) {
      line(
        style.yellow(
          `  prediction missed: the plan expected ${plan.expectedToDieFrom} to kill this, and it survived.`,
        ),
      );
      line(style.dim('  Worth a look — the behaviour may not be where the plan assumed.'));
    } else if (predicted !== undefined) {
      line(style.dim(`  prediction held: ${plan.expectedToDieFrom} killed it, as the plan said it would.`));
    }

    line(style.dim(`  spent $${outcome.costUsd.toFixed(4)}`));
  }

  if (!gateResult.passed) {
    // "It asserts nothing" is only true when FALSIFIABILITY failed. A gate that
    // could not interpret the run, or one that found the candidate unstable, is
    // a different verdict — and saying the wrong one sends the reader to debug
    // the wrong thing. Measured: a genuinely good generated test was reported
    // as "passed without asserting anything" when the run had not been read at
    // all.
    const vacuous = gateResult.checks.some(c => c.name === 'falsifiability' && !c.ok);
    const why = vacuous
      ? 'it passed without asserting anything'
      : 'the gate did not clear it';

    if (flags.keepRejected) {
      line();
      warn(`kept ${outPath} despite the gate rejecting it (--keep-rejected).`);
      if (vacuous) {
        line(style.dim('  Do not commit it as coverage: it passes without asserting anything.'));
      }
    } else {
      // Deleted, not left for review. A rejected candidate is green and
      // worthless, which is the combination most likely to be committed by
      // someone who trusts the tool.
      await unlink(absolute).catch(() => undefined);
      line();
      line(style.dim(`  removed ${outPath} — ${why}.`));
      line(style.dim('  Re-run with --keep-rejected to inspect it.'));
    }
    throw new PolicyError(gateResult.summary);
  }

  line();
  line(style.green(`  ${outPath} is ready for review.`));
  return EXIT.OK;
}
