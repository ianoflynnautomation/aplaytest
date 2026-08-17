/**
 * The fixture → reporter channel.
 *
 * A Playwright reporter runs in the main process and cannot reach into the
 * browser. Anything only the worker knows — the ARIA snapshot, the request
 * ledger, console output — has to travel as a test ATTACHMENT, which is the
 * runner's own supported channel and needs no side files or IPC.
 *
 * Both ends import these schemas, and the reporter PARSES rather than casts.
 * A fixture that drifts from the contract fails loudly with a named error
 * instead of silently producing a bundle with an empty ARIA snapshot — the
 * same reasoning behind validating mocked response bodies against wire
 * schemas rather than trusting them.
 */

import { z } from 'zod';

export const SIDECAR = {
  page: 'atest:page',
  network: 'atest:network',
  console: 'atest:console',
  intent: 'atest:intent',
  coverage: 'atest:coverage',
} as const;

export type SidecarName = (typeof SIDECAR)[keyof typeof SIDECAR];

export const PageSidecarSchema = z.object({
  url: z.string(),
  title: z.string(),
  ariaSnapshot: z.string(),
  testIdsPresent: z.array(z.string()),
  htmlDigest: z.string().nullable().default(null),
});
export type PageSidecar = z.infer<typeof PageSidecarSchema>;

const RequestRecordSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().nullable(),
  durationMs: z.number(),
  failureText: z.string().nullable().default(null),
  schemaError: z.string().nullable().default(null),
});

export const NetworkSidecarSchema = z.object({
  failed: z.array(RequestRecordSchema),
  slow: z.array(RequestRecordSchema),
  statusCounts: z.record(z.string(), z.number()),
});
export type NetworkSidecar = z.infer<typeof NetworkSidecarSchema>;

export const ConsoleSidecarSchema = z.object({
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ConsoleSidecar = z.infer<typeof ConsoleSidecarSchema>;

export const IntentSidecarSchema = z.object({
  selector: z.string().nullable().default(null),
  selectorSource: z
    .object({
      file: z.string(),
      line: z.number(),
      constantPath: z.string(),
      aliases: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
});
export type IntentSidecar = z.infer<typeof IntentSidecarSchema>;

/**
 * Routes a test actually visited.
 *
 * The one signal that survives a fixture barrel. Static imports say every spec
 * depends on every feature (they compose one `test` object); what a test
 * VISITED is independent of that, and is the only thing that can narrow
 * selection in a suite built that way.
 */
export const CoverageSidecarSchema = z.object({
  routes: z.array(z.string()),
});
export type CoverageSidecar = z.infer<typeof CoverageSidecarSchema>;

const SCHEMAS = {
  [SIDECAR.page]: PageSidecarSchema,
  [SIDECAR.network]: NetworkSidecarSchema,
  [SIDECAR.console]: ConsoleSidecarSchema,
  [SIDECAR.intent]: IntentSidecarSchema,
  [SIDECAR.coverage]: CoverageSidecarSchema,
} as const;

export class SidecarParseError extends Error {
  constructor(
    readonly sidecar: string,
    readonly issues: string,
  ) {
    super(
      `Attachment "${sidecar}" does not match its schema — the atest fixtures and ` +
        `reporter are out of sync.\n${issues}`,
    );
    this.name = 'SidecarParseError';
  }
}

/**
 * Parse a sidecar payload. Absent is fine (the fixtures are optional);
 * PRESENT-BUT-WRONG is not, and throws.
 */
export function parseSidecar<N extends keyof typeof SCHEMAS>(
  name: N,
  raw: string | undefined,
): z.infer<(typeof SCHEMAS)[N]> | null {
  if (raw === undefined) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new SidecarParseError(name, error instanceof Error ? error.message : String(error));
  }

  const result = SCHEMAS[name].safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new SidecarParseError(name, issues);
  }
  return result.data as z.infer<(typeof SCHEMAS)[N]>;
}
