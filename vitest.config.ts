import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    /**
     * Tags are declared centrally because `strictTags` defaults to true: an
     * undeclared tag fails the file it appears in, which makes a typo loud
     * instead of silently shrinking a filtered run.
     *
     * Filter with `--tagsFilter`, which takes && || and !:
     *   vitest run --tagsFilter '@unit'
     *   vitest run --tagsFilter '@taxonomy && !@integration'
     */
    tags: [
      // Scope — what the test exercises.
      { name: '@unit', description: 'Isolated function or class, no I/O boundary' },
      { name: '@integration', description: 'Crosses a real boundary: filesystem, SQLite, or several modules' },

      // Component — the module under test.
      { name: '@taxonomy', description: 'Failure classification and Playwright error parsing' },
      { name: '@config', description: 'atest.config.ts schema and defaults' },
      { name: '@evidence-store', description: 'Evidence bundle parsing and run loading' },
      { name: '@evidence-redact', description: 'Secret redaction across strings, structures and URLs' },
      { name: '@locator-stability', description: 'Locator parsing, stability ranking and test-id distance' },
      { name: '@history-url', description: 'History target URL parsing' },
      { name: '@history-store', description: 'SQLite history store' },
      { name: '@history-memory', description: 'In-memory history index and store' },
      { name: '@history-report', description: 'Playwright JSON report mapping' },
      { name: '@history-ingest', description: 'Playwright JSON report ingestion' },

      // Component — one tag per package outside core.
      { name: '@agent', description: 'Author and repair agents over an LLM client' },
      { name: '@author', description: 'Grounding, mutants and the falsifiability gate' },
      { name: '@cli', description: 'Command line interface' },
      { name: '@flaky', description: 'Flake scoring, classification, bisect and quarantine' },
      { name: '@heal', description: 'Selector heal proposal, patching and resolution' },
      { name: '@impact', description: 'Change impact analysis and test selection' },
      { name: '@llm', description: 'LLM client, budget guard and provider plumbing' },
      { name: '@mcp', description: 'MCP server and tool surface' },
      { name: '@report', description: 'Run report rendering' },
      { name: '@runner', description: 'Playwright runner, fixtures and step binding' },
      { name: '@store-azure', description: 'Azure blob history store' },
    ],
  },
});
