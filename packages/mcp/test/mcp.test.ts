import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_SAFETY, WRITE_TOOLS, gate, safetyFromEnv, sanitise } from '../src/safety.js';
import { ALL_TOOLS, getFailure, listFailures, type ToolContext } from '../src/tools.js';

describe('safety — read-only by default', () => {
  it('given an environment with no write opt-in -> when safetyFromEnv resolves it -> then writes are disabled', { tags: ['@unit', '@mcp'] }, () => {
    expect(safetyFromEnv({}).writeEnabled).toBe(false);
  });

  it('given ATEST_MCP_WRITE set to 1 and to true -> when safetyFromEnv resolves each -> then only the exact opt-in value enables writes', { tags: ['@unit', '@mcp'] }, () => {
    expect(safetyFromEnv({ ATEST_MCP_WRITE: '1' }).writeEnabled).toBe(true);
    expect(safetyFromEnv({ ATEST_MCP_WRITE: 'true' }).writeEnabled).toBe(false);
  });

  it('given the default read-only safety -> when a read tool is gated -> then it passes', { tags: ['@unit', '@mcp'] }, () => {
    expect(gate('atest_list_failures', {}, DEFAULT_SAFETY).ok).toBe(true);
  });

  it('given the default read-only safety -> when a mutating tool is gated -> then it is refused as write_disabled', { tags: ['@unit', '@mcp'] }, () => {
    const result = gate('atest_apply_heal', { confirm: true }, DEFAULT_SAFETY);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('write_disabled');
  });

  it('given writes are enabled -> when a mutating tool is gated with and without confirmation -> then confirmation is still required', { tags: ['@unit', '@mcp'] }, () => {
    // Two independent gates. A model exploring a failure must not be able to
    // mutate the working tree as a side effect of asking questions.
    const enabled = { ...DEFAULT_SAFETY, writeEnabled: true };
    expect(gate('atest_apply_heal', {}, enabled).error).toBe('confirmation_required');
    expect(gate('atest_apply_heal', { confirm: true }, enabled).ok).toBe(true);
  });

  it('given writes are enabled and a merely truthy confirm value -> when a mutating tool is gated -> then it is refused', { tags: ['@unit', '@mcp'] }, () => {
    const enabled = { ...DEFAULT_SAFETY, writeEnabled: true };
    expect(gate('atest_apply_heal', { confirm: 'yes' }, enabled).ok).toBe(false);
    expect(gate('atest_apply_heal', { confirm: 1 }, enabled).ok).toBe(false);
  });
});

describe('safety — response hygiene', () => {
  it('given a payload carrying an authorization header -> when sanitise processes it -> then the credential is removed and the path survives', { tags: ['@unit', '@mcp'] }, () => {
    // Evidence from an authenticated suite WILL contain bearer tokens.
    const { text } = sanitise(
      { headers: { authorization: 'Bearer abc123def456ghi' }, url: '/gyms' },
      DEFAULT_SAFETY,
    );
    expect(text).not.toContain('abc123def456ghi');
    expect(text).toContain('/gyms');
  });

  it('given a payload past the response character limit -> when sanitise processes it -> then the output is marked TRUNCATED rather than silently shortened', { tags: ['@unit', '@mcp'] }, () => {
    // A silently cut ARIA snapshot would lead a model to conclude an element
    // is absent when it was merely truncated — the wrong answer for healing.
    const { text, truncated } = sanitise({ aria: 'x'.repeat(5000) }, {
      ...DEFAULT_SAFETY,
      maxResponseChars: 500,
    });
    expect(truncated).toBe(true);
    expect(text).toContain('TRUNCATED');
  });
});

describe('tool surface', () => {
  it('given the exported tool surface -> when its size is measured -> then it holds at most nine tools', { tags: ['@unit', '@mcp'] }, () => {
    // A server with forty tools makes the client agent worse at choosing.
    expect(ALL_TOOLS.length).toBeLessThanOrEqual(9);
  });

  it('given the exported tool surface -> when each name is inspected -> then every tool carries the atest_ prefix', { tags: ['@unit', '@mcp'] }, () => {
    for (const tool of ALL_TOOLS) expect(tool.name).toMatch(/^atest_/);
  });

  it('given the exported tool surface -> when each description is inspected -> then every one is long enough for a model to route on', { tags: ['@unit', '@mcp'] }, () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description.length, `${tool.name} needs a real description`).toBeGreaterThan(60);
    }
  });

  it('given the exported tool surface -> when the mutating tools are inspected -> then every one is declared in the write set', { tags: ['@unit', '@mcp'] }, () => {
    // A mutating tool missing from WRITE_TOOLS would bypass both gates.
    const mutating = ALL_TOOLS.filter(t => /apply|quarantine|write|delete/.test(t.name));
    for (const tool of mutating) expect(WRITE_TOOLS.has(tool.name)).toBe(true);
  });
});

describe('tool behaviour against a real evidence directory', () => {
  let context: ToolContext;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'atest-mcp-'));
    const evidenceDir = join(root, 'evidence');
    await mkdir(join(evidenceDir, 'run-1'), { recursive: true });

    const bundle = {
      schemaVersion: 1,
      id: 'ev_test00000001',
      runId: 'run-1',
      traceId: 't',
      capturedAt: new Date().toISOString(),
      test: {
        id: 'test-1',
        title: 'a gym can be found by name',
        titlePath: [],
        file: join(root, 'tests/gyms.spec.ts'),
        line: 8,
        project: 'default',
        tags: [],
        retry: 0,
        workerIndex: 0,
        shard: null,
      },
      failure: {
        kind: 'locator_not_found',
        message: 'Authorization: Bearer secret-token-value-here',
        stack: '',
        matcher: 'toBeVisible',
        expected: 'visible',
        actual: 'element(s) not found',
        timedOut: true,
      },
      intent: {
        steps: [],
        failingStep: {
          pageObject: 'gymsPage',
          method: 'expectCardData',
          args: ['011 Grappling'],
          startedAt: '',
          durationMs: 1,
          failed: true,
        },
        selector: "getByTestId('gym-card-name-v2')",
        selectorSource: null,
      },
      page: {
        url: '/gyms',
        title: 'Gyms',
        ariaSnapshot: '- heading "Gyms"',
        candidates: [],
        htmlDigest: null,
        testIdsPresent: ['gym-card-name', 'gym-card-county'],
      },
      visual: { screenshotPath: '/tmp/shot.png', diffPath: null, diffPixelRatio: null },
      network: { failed: [], slow: [], statusCounts: {} },
      console: { errors: [], warnings: [] },
      timing: { testMs: 1, failingActionMs: null, navigationMs: null, budgetUsedRatio: 0 },
      env: {
        appEnv: 'local',
        baseUrl: '',
        browser: 'chromium',
        platform: 'darwin',
        workers: 1,
        commit: '',
        changedPaths: [],
      },
      appSpans: null,
      artifacts: { tracePath: null, videoPath: null },
    };

    await writeFile(
      join(evidenceDir, 'run-1', 'ev_test00000001.json'),
      JSON.stringify(bundle),
      'utf8',
    );

    context = { cwd: root, evidenceDir, runsDir: join(root, 'runs') };
  });

  it('given an evidence directory holding one failure -> when listFailures runs -> then the summary carries the intent and healability but no accessibility tree', { tags: ['@integration', '@mcp'] }, async () => {
    // Returning full evidence for every failure would blow the client's
    // context in one call.
    const result = (await listFailures.handler({}, context)) as {
      count: number;
      failures: { intent: string | null; healable: boolean }[];
    };

    expect(result.count).toBe(1);
    expect(JSON.stringify(result)).not.toContain('ariaSnapshot');
    expect(result.failures[0]?.intent).toContain('expectCardData');
    expect(result.failures[0]?.healable).toBe(true);
  });

  it('given an evidence directory holding one failure -> when getFailure runs for that id -> then the tree and ranked candidates are returned and the screenshot is offered as a URI', { tags: ['@integration', '@mcp'] }, async () => {
    const result = (await getFailure.handler({ evidenceId: 'ev_test00000001' }, context)) as {
      page: { ariaSnapshot?: string };
      heal: { candidates?: { value: string }[] };
      screenshot: string | null;
    };

    expect(result.page.ariaSnapshot).toContain('heading');
    expect(result.heal.candidates?.[0]?.value).toBe('gym-card-name');
    // Never inlined — offered as a URI the client fetches deliberately.
    expect(result.screenshot).toBe('atest://failures/ev_test00000001/screenshot');
  });

  it('given a getFailure call requesting only candidates -> when the handler runs -> then the accessibility tree is omitted', { tags: ['@integration', '@mcp'] }, async () => {
    const result = await getFailure.handler(
      { evidenceId: 'ev_test00000001', include: ['candidates'] },
      context,
    );
    expect(JSON.stringify(result)).not.toContain('ariaSnapshot');
  });

  it('given an evidence bundle whose message carries a bearer token -> when the response is sanitised -> then the credential is removed', { tags: ['@integration', '@mcp'] }, async () => {
    const raw = await getFailure.handler({ evidenceId: 'ev_test00000001' }, context);
    const { text } = sanitise(raw, DEFAULT_SAFETY);
    expect(text).not.toContain('secret-token-value-here');
  });

  it('given an evidence id that does not exist -> when getFailure runs -> then it reports not_found rather than throwing into the transport', { tags: ['@integration', '@mcp'] }, async () => {
    const result = (await getFailure.handler({ evidenceId: 'ev_missing' }, context)) as {
      error?: string;
    };
    expect(result.error).toBe('not_found');
  });
});

describe('grounding and gate tools', () => {
  it('given the falsifiability gate tool -> when it is gated read-only and then with writes enabled -> then both the write opt-in and explicit confirmation are required', { tags: ['@unit', '@mcp'] }, () => {
    // It restores the spec it mutates, so it leaves no net change — but it
    // rewrites a tracked file for the duration of several Playwright runs,
    // and a process killed mid-gate leaves a mutated spec on disk.
    expect(WRITE_TOOLS.has('atest_gate_test')).toBe(true);
    expect(gate('atest_gate_test', { confirm: true }, DEFAULT_SAFETY).error).toBe('write_disabled');

    const enabled = { ...DEFAULT_SAFETY, writeEnabled: true };
    expect(gate('atest_gate_test', {}, enabled).error).toBe('confirmation_required');
    expect(gate('atest_gate_test', { confirm: true }, enabled).ok).toBe(true);
  });

  it('given the grounding retrieval tool -> when it is gated under read-only safety -> then it passes without a write opt-in', { tags: ['@unit', '@mcp'] }, () => {
    // Reading what the repo already says must never need a write opt-in.
    expect(WRITE_TOOLS.has('atest_ground_feature')).toBe(false);
    expect(gate('atest_ground_feature', { feature: 'gyms' }, DEFAULT_SAFETY).ok).toBe(true);
  });

  it('given a repository the server knows nothing about -> when the grounding tool runs -> then exemplar sources are withheld and the gaps are reported', { tags: ['@integration', '@mcp'] }, async () => {
    // Inlining exemplars would spend the caller's context on files it can read
    // deliberately once it knows they exist.
    const tool = ALL_TOOLS.find(t => t.name === 'atest_ground_feature');
    expect(tool).toBeDefined();

    const result = (await tool!.handler(
      { feature: 'nothing-here' },
      { cwd: '/nonexistent', evidenceDir: '/nonexistent', runsDir: '/nonexistent' },
    )) as { exemplars: unknown[]; missing: string[] };

    expect(JSON.stringify(result)).not.toContain('source');
    // A repo it knows nothing about reports gaps rather than inventing them.
    expect(result.missing.length).toBeGreaterThan(0);
  });
});
