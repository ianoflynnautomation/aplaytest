/**
 * Extract the page-object call trail from Playwright's step tree.
 *
 * This is what turns "the selector [data-testid=gym-card-name] did not resolve"
 * into "gymsPage.expectCardData({ name: 'Blackwater Valley BJJ' }) failed".
 * The first says where the test looked; the second says what it WANTED — which
 * is the input the healing engine actually reasons over.
 *
 * The trail arrives for free when page objects are bound through a wrapper
 * that calls `test.step()`. No spec changes, no extra reporting channel.
 */

import type { StepRecord } from '@atest/core';

/** Structural subset of Playwright's TestStep — keeps this unit-testable. */
export interface StepLike {
  readonly title: string;
  readonly category: string;
  readonly duration: number;
  readonly startTime: Date;
  readonly error?: unknown;
  readonly steps: readonly StepLike[];
}

/** `gymsPage.expectCardData({ name: 'X' })` → object / method / args preview. */
const CALL_PATTERN = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\((.*)\)$/s;

export interface ParsedStepTitle {
  readonly pageObject: string;
  readonly method: string;
  readonly argsPreview: string;
}

export function parseStepTitle(title: string): ParsedStepTitle | null {
  const match = CALL_PATTERN.exec(title.trim());
  if (match === null) return null;
  const [, pageObject, method, argsPreview] = match;
  if (pageObject === undefined || method === undefined) return null;
  return { pageObject, method, argsPreview: argsPreview ?? '' };
}

/**
 * Domain string arguments from a step title — the accessible names, search
 * terms, and labels the test was looking for. Tier-0 candidate generation
 * matches these against the page's ARIA tree, which is why a page object that
 * takes domain values rather than selectors pays off here.
 */
export function domainStringArgs(argsPreview: string): string[] {
  const out: string[] = [];
  // Match any quote-delimited run, THEN filter. A length constraint inside the
  // pattern lets the engine pair a closing quote with the next opening one —
  // `'a', 'Cork'` would yield the separator `", "` as an "argument", quietly
  // feeding junk into candidate matching.
  const literal = /'([^']*)'|"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = literal.exec(argsPreview)) !== null) {
    const value = match[1] ?? match[2];
    if (value !== undefined && isDomainValue(value)) out.push(value);
  }
  return [...new Set(out)];
}

/** Two or more characters, containing at least one letter or digit. */
function isDomainValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 2 && /[\p{L}\p{N}]/u.test(trimmed);
}

const USER_STEP_CATEGORIES = new Set(['test.step']);

/** Flatten the step tree into an ordered trail of user-authored steps. */
export function extractSteps(steps: readonly StepLike[]): StepRecord[] {
  const out: StepRecord[] = [];

  const walk = (nodes: readonly StepLike[]): void => {
    for (const node of nodes) {
      if (USER_STEP_CATEGORIES.has(node.category)) {
        const parsed = parseStepTitle(node.title);
        out.push({
          pageObject: parsed?.pageObject ?? '(unknown)',
          method: parsed?.method ?? node.title,
          args: parsed === null ? [] : domainStringArgs(parsed.argsPreview),
          startedAt: node.startTime.toISOString(),
          durationMs: node.duration,
          failed: node.error !== undefined && node.error !== null,
        });
      }
      walk(node.steps);
    }
  };

  walk(steps);
  return out;
}

/**
 * The DEEPEST failing step, not the first.
 *
 * Playwright marks every ancestor of a failure as failed too, so the outermost
 * failed step is usually the whole test body — useless. The innermost one is
 * the actual call that broke.
 */
export function findFailingStep(steps: readonly StepLike[]): StepRecord | null {
  let deepest: { record: StepRecord; depth: number } | null = null;

  const walk = (nodes: readonly StepLike[], depth: number): void => {
    for (const node of nodes) {
      const failed = node.error !== undefined && node.error !== null;
      if (failed && USER_STEP_CATEGORIES.has(node.category)) {
        const parsed = parseStepTitle(node.title);
        if (deepest === null || depth > deepest.depth) {
          deepest = {
            depth,
            record: {
              pageObject: parsed?.pageObject ?? '(unknown)',
              method: parsed?.method ?? node.title,
              args: parsed === null ? [] : domainStringArgs(parsed.argsPreview),
              startedAt: node.startTime.toISOString(),
              durationMs: node.duration,
              failed: true,
            },
          };
        }
      }
      walk(node.steps, depth + 1);
    }
  };

  walk(steps, 0);
  return deepest === null ? null : (deepest as { record: StepRecord }).record;
}
