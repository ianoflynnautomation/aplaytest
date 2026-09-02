#!/usr/bin/env node
/**
 * The aplaytest binary.
 *
 * Argument parsing uses Node's built-in `util.parseArgs` — a CLI framework
 * would be a dependency, a version to keep current, and a supply-chain
 * surface, for a job the platform already does.
 */

import { parseArgs } from 'node:util';

import { EXIT, PolicyError, UsageError, type ExitCode } from './exit.js';
import { doctor } from './commands/doctor.js';
import { init, type InitFlags } from './commands/init.js';
import { flakyBisect, type BisectFlags } from './commands/bisect.js';
import { heal, healList, healRevert, type HealFlags } from './commands/heal.js';
import { impact, type ImpactFlags } from './commands/impact.js';
import { ciGenerate, type CiFlags } from './commands/ci.js';
import { report, type ReportFlags } from './commands/report.js';
import { gate, type GateFlags } from './commands/gate.js';
import { agentAuthor, type AgentFlags } from './commands/agent.js';
import {
  historyIngest,
  historyPrune,
  historyStats,
  type HistoryFlags,
} from './commands/history.js';
import {
  flakyExpire,
  flakyQuarantine,
  flakyRelease,
  flakyReport,
  type FlakyFlags,
} from './commands/flaky.js';
import { error, line, style } from './ui/output.js';

const USAGE = `
${style.bold('aplaytest')} — a control plane around Playwright

${style.bold('USAGE')}
  aplaytest <command> [options]

${style.bold('COMMANDS')}
  init                      Wire atest into an existing Playwright repo
  flaky report              Score and classify every test from run history
  flaky quarantine          Tag a test @quarantine, with expiry and a reason
  flaky release             Remove the tag again
  flaky bisect              Re-run under controlled perturbations to find the cause
  flaky expire              Fail if any quarantine is expired or over budget
  heal                      Propose selector heals from captured evidence
  heal list                 Show the heal ledger
  heal revert <id>          Restore a file to its state before a heal
  impact                    Which specs a diff could affect
  ci generate               Emit a CI workflow with the execute/analyze split
  report                    Merge shards; write the HTML report and PR comment
  gate                      Does a test actually assert anything? (falsifiability)
  agent author              Generate a test, then prove it asserts something
  history stats             What is in the history database
  history ingest            Add run records to it without scoring
  history prune             Drop runs older than --keep-days   [90]
  doctor                    Verify configuration, history, and versions

${style.bold('OPTIONS')}
  --runs <dir>              Run records written by the reporter  [.atest/runs]
  --db <target>             History store. A path is a local SQLite file;
                            azblob://<account>/<container>[/<prefix>] is Azure
                            Blob Storage. Add ?readonly=1 to score without
                            writing, ?window=<days> to bound the read.
                            Falls back to $ATEST_HISTORY_URL, then :memory:
  --ledger <path>           Quarantine ledger            [.atest/quarantine.json]
  --test "<title>"          Test title, exactly as written in the spec
  --file <path>             Spec file containing the test
  --project <name>          Restrict to one Playwright project
  --reason "<text>"         Why it is being quarantined
  --issue <url>             Tracking issue
  --suite-size <n>          Suite size, for the quarantine budget
  --repeat <n>              Repetitions per bisect probe            [10]
  --workers <list>          Worker levels to sweep, comma-separated [1,4,8]
  --config <path>           Playwright config to drive
  --cwd <dir>               Directory to run Playwright in
  --evidence <dir>          Evidence bundles              [.atest/evidence]
  --constants <path>        Selector file (heal). Optional — defaults to heal.targets
  --spec <path>             Spec file to validate against (heal)
  --validate <n>            Validation re-runs before accepting a heal  [3]
  --apply                   Write the heal to the working tree
  --no-collateral           Skip re-running the rest of the spec file
  --heal-ledger <dir>       Heal audit trail              [.atest/heals]
  --force                   Revert even if the file changed since
  --no-llm                  Deterministic tier only, even with a key present
  --from <ref>              Diff base for impact          [origin/main]
  --comment <path>          Write the PR comment here      [stdout]
  --report-url <url>        Link the comment to the hosted report
  --api-pattern <glob>      Routes the gate mutates          [**/api/**]
  --only <mutants>          Comma-separated subset of mutants to run
  --goal <text>             What to test, in plain language (agent author)
  --feature <name>          Feature slice to ground against
  --plan-only               Stop after the plan, before any code
  --keep-rejected           Keep a candidate the gate rejected
  --keep-days <n>           Retention for history prune            [90]
  --playwright-json <file>  Ingest a Playwright JSON report (API-only suites)
  --undo                    Remove what init added (with --apply)
  --to <ref>                Diff head                     [HEAD]
  --tsconfig <path>         tsconfig used to resolve imports
  --changed <list>          Explicit changed files, comma-separated
  --always-run <globs>      Specs that always run, comma-separated
  --provider <name>         github | gitlab                          [github]
  --out <path>              Where to write the workflow
  --shards <n>              Shard count                              [4]
  --node-version <v>        Node version for CI                      [22]
  --playwright-image <ref>  Container image; keep in step with your suite
  --dry-run                 Show the change without writing it
  --json                    Machine-readable output
  --ci                      Non-interactive; policy failures exit 4
  -h, --help

${style.bold('EXIT CODES')}
  0 ok · 1 test failures · 2 usage · 3 model unavailable · 4 policy · 5 internal

  For \`gate\`, 1 and 4 mean different things: 4 is a verdict (the test asserts
  nothing), 1 means the gate could not decide because a mutant run never
  executed the test. Treat 1 as an environment problem, not a test problem.
`;

const OPTIONS = {
  runs: { type: 'string', default: '.atest/runs' },
  // No default here, deliberately. `parseArgs` cannot distinguish "the user
  // passed :memory:" from "the user passed nothing" once a default is applied,
  // and that distinction is what lets ATEST_HISTORY_URL configure a whole
  // pipeline without threading --db through every invocation. The fallback
  // lives in resolveHistoryUrl.
  db: { type: 'string' },
  ledger: { type: 'string', default: '.atest/quarantine.json' },
  test: { type: 'string' },
  file: { type: 'string' },
  project: { type: 'string' },
  reason: { type: 'string' },
  issue: { type: 'string' },
  expires: { type: 'string' },
  'suite-size': { type: 'string' },
  repeat: { type: 'string' },
  workers: { type: 'string' },
  config: { type: 'string' },
  cwd: { type: 'string' },
  evidence: { type: 'string', default: '.atest/evidence' },
  constants: { type: 'string' },
  spec: { type: 'string' },
  run: { type: 'string' },
  validate: { type: 'string' },
  apply: { type: 'boolean', default: false },
  'no-collateral': { type: 'boolean', default: false },
  'heal-ledger': { type: 'string', default: '.atest/heals' },
  force: { type: 'boolean', default: false },
  'no-llm': { type: 'boolean', default: false },
  from: { type: 'string' },
  to: { type: 'string' },
  tsconfig: { type: 'string' },
  changed: { type: 'string' },
  'always-run': { type: 'string' },
  provider: { type: 'string' },
  out: { type: 'string' },
  shards: { type: 'string' },
  'node-version': { type: 'string' },
  'playwright-image': { type: 'string' },
  comment: { type: 'string' },
  'report-url': { type: 'string' },
  'api-pattern': { type: 'string' },
  only: { type: 'string' },
  goal: { type: 'string' },
  feature: { type: 'string' },
  'plan-only': { type: 'boolean', default: false },
  'keep-rejected': { type: 'boolean', default: false },
  'keep-days': { type: 'string' },
  'playwright-json': { type: 'string' },
  undo: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  ci: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/**
 * `parseArgs` rejects bad input by throwing a plain Error carrying an
 * `ERR_PARSE_ARGS_*` code. Left unhandled it reaches the generic catch and
 * exits 5 (internal) — reporting a user's typo as a crash in the tool, and
 * telling CI to page someone. Translate it to a usage error.
 */
function parseStrict(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    // Unknown flags are rejected rather than ignored: a misspelled --dry-run
    // that writes to disk anyway is the worst possible outcome.
    strict: true,
  });
}

// Inferred, never annotated: writing `ReturnType<typeof parseArgs>` here
// collapses the precise per-flag types into a string|boolean index signature
// and every `values.runs` becomes a cast.
type ParsedArgs = ReturnType<typeof parseStrict>;

function parseArgsOrUsageError(argv: readonly string[]): ParsedArgs {
  try {
    return parseStrict(argv);
  } catch (caught) {
    const code = (caught as { code?: string }).code ?? '';
    if (code.startsWith('ERR_PARSE_ARGS_')) {
      throw new UsageError(caught instanceof Error ? caught.message : String(caught));
    }
    throw caught;
  }
}

async function dispatch(argv: readonly string[]): Promise<ExitCode> {
  const { values, positionals } = parseArgsOrUsageError(argv);

  if (values.help === true || positionals.length === 0) {
    line(USAGE);
    return positionals.length === 0 && values.help !== true ? EXIT.USAGE : EXIT.OK;
  }

  const flags: FlakyFlags = {
    runs: values.runs,
    db: values.db,
    ledger: values.ledger,
    json: values.json,
    ci: values.ci,
    dryRun: values['dry-run'],
    test: values.test,
    file: values.file,
    project: values.project,
    reason: values.reason,
    issue: values.issue,
    expires: values.expires,
    suiteSize: values['suite-size'],
  };

  const bisectFlags: BisectFlags = {
    ...flags,
    repeat: values.repeat,
    workers: values.workers,
    config: values.config,
    cwd: values.cwd,
  };

  const healFlags: HealFlags = {
    evidence: values.evidence,
    run: values.run,
    constants: values.constants,
    spec: values.spec,
    config: values.config,
    project: values.project,
    cwd: values.cwd,
    validate: values.validate,
    apply: values.apply,
    dryRun: values['dry-run'],
    json: values.json,
    noCollateral: values['no-collateral'],
    healLedger: values['heal-ledger'],
    force: values.force,
    noLlm: values['no-llm'],
  };

  const reportFlags: ReportFlags = {
    runs: flags.runs,
    evidence: values.evidence,
    db: flags.db,
    json: flags.json,
    ...(values.out === undefined ? {} : { out: values.out }),
    ...(values.comment === undefined ? {} : { comment: values.comment }),
    ...(values['report-url'] === undefined ? {} : { reportUrl: values['report-url'] }),
  };

  const gateFlags: GateFlags = {
    json: flags.json,
    ci: flags.ci,
    ...(values.spec === undefined ? {} : { spec: values.spec }),
    ...(values.test === undefined ? {} : { test: values.test }),
    ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.project === undefined ? {} : { project: values.project }),
    ...(values.validate === undefined ? {} : { validate: values.validate }),
    ...(values['api-pattern'] === undefined ? {} : { apiPattern: values['api-pattern'] }),
    ...(values.only === undefined ? {} : { only: values.only }),
  };

  const agentFlags: AgentFlags = {
    planOnly: values['plan-only'],
    keepRejected: values['keep-rejected'],
    force: values.force,
    noLlm: values['no-llm'],
    json: flags.json,
    dryRun: values['dry-run'],
    ...(values.goal === undefined ? {} : { goal: values.goal }),
    ...(values.feature === undefined ? {} : { feature: values.feature }),
    ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
    ...(values.out === undefined ? {} : { out: values.out }),
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.project === undefined ? {} : { project: values.project }),
    ...(values.validate === undefined ? {} : { validate: values.validate }),
    ...(values['api-pattern'] === undefined ? {} : { apiPattern: values['api-pattern'] }),
  };

  const initFlags: InitFlags = {
    apply: values.apply,
    undo: values.undo,
    json: flags.json,
    ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
    ...(values.config === undefined ? {} : { config: values.config }),
  };

  const historyFlags: HistoryFlags = {
    db: flags.db,
    runs: flags.runs,
    json: flags.json,
    ...(values['keep-days'] === undefined ? {} : { keepDays: values['keep-days'] }),
    ...(values['playwright-json'] === undefined
      ? {}
      : { playwrightJson: values['playwright-json'] }),
  };

  const impactFlags: ImpactFlags = {
    cwd: values.cwd,
    from: values.from,
    to: values.to,
    tsconfig: values.tsconfig,
    changed: values.changed,
    alwaysRun: values['always-run'],
    runs: values.runs,
    json: values.json,
  };

  const ciFlags: CiFlags = {
    provider: values.provider,
    out: values.out,
    shards: values.shards,
    projects: values.project,
    nodeVersion: values['node-version'],
    playwrightImage: values['playwright-image'],
    dryRun: values['dry-run'],
  };

  const [command, subcommand] = positionals;

  switch (command) {
    case 'heal':
      switch (subcommand) {
        case undefined:
          return heal(healFlags);
        case 'list':
          return healList(healFlags);
        case 'revert':
          return healRevert(healFlags, positionals[2]);
        default:
          throw new UsageError(`Unknown subcommand "heal ${subcommand}".`);
      }

    case 'impact':
      return impact(impactFlags);

    case 'ci':
      if (subcommand !== 'generate') {
        throw new UsageError('Only `aplaytest ci generate` is supported.');
      }
      return ciGenerate(ciFlags);

    case 'agent':
      switch (subcommand) {
        case 'author':
          return agentAuthor(agentFlags);
        default:
          throw new UsageError(
            `Unknown subcommand "agent ${subcommand ?? ''}". Supported: author.`,
          );
      }

    case 'init':
      return init(initFlags);

    case 'history':
      switch (subcommand) {
        case 'stats':
        case undefined:
          return historyStats(historyFlags);
        case 'ingest':
          return historyIngest(historyFlags);
        case 'prune':
          return historyPrune(historyFlags);
        default:
          throw new UsageError(
            `Unknown subcommand "history ${subcommand}". Supported: stats, ingest, prune.`,
          );
      }

    case 'gate':
      return gate(gateFlags);

    case 'report':
      return report(reportFlags);

    case 'doctor':
      return doctor({
        runs: flags.runs,
        ledger: flags.ledger,
        ...(values.feature === undefined ? {} : { feature: values.feature }),
        ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
      });

    case 'flaky':
      switch (subcommand) {
        case 'report':
        case undefined:
          return flakyReport(flags);
        case 'quarantine':
          return flakyQuarantine(flags);
        case 'release':
          return flakyRelease(flags);
        case 'bisect':
          return flakyBisect(bisectFlags);
        case 'expire':
          return flakyExpire(flags);
        default:
          throw new UsageError(`Unknown subcommand "flaky ${subcommand}".`);
      }

    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

try {
  process.exitCode = await dispatch(process.argv.slice(2));
} catch (caught) {
  if (caught instanceof UsageError || caught instanceof PolicyError) {
    error(caught.message);
    process.exitCode = caught.exitCode;
  } else {
    error(caught instanceof Error ? caught.message : String(caught));
    if (process.env['ATEST_DEBUG'] === '1' && caught instanceof Error) {
      line(style.dim(caught.stack ?? ''));
    }
    process.exitCode = EXIT.INTERNAL;
  }
}
