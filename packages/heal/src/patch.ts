/**
 * Selector patching.
 *
 * Heals target the CONSTANTS file, not the spec. In a suite where every
 * selector is a named string in `<feature>.constants.ts`, a selector heal is a
 * one-line diff in a file with no logic in it — a reviewer can judge it in ten
 * seconds, which is what makes proposing heals at all defensible.
 *
 * Done with ts-morph rather than text replacement for one concrete reason: a
 * single literal is routinely bound to more than one constant. In a real
 * suite `'gym-card-name'` appears as BOTH `TEST_IDS.cardName` and
 * `GYM_CARD_TEST_IDS.name`, used by different page objects. A regex would fix
 * one, leave the other, and produce a patch that passes its own validation
 * while breaking the file's other tests.
 */

import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph';

export type PatchStatus = 'applied' | 'not-found' | 'unchanged';

export interface TouchedConstant {
  /** e.g. "TEST_IDS.cardName", or "SEARCH_INPUT" for a bare const. */
  readonly path: string;
  readonly line: number;
}

export interface PatchResult {
  readonly status: PatchStatus;
  readonly file: string;
  /** Literal that was searched for. Stored so revert does not scrape `message`. */
  readonly from: string;
  readonly to: string;
  readonly before: string;
  readonly after: string | null;
  readonly touched: readonly TouchedConstant[];
  readonly message: string;
}

export interface PatchInput {
  readonly file: string;
  /** The literal value to replace, e.g. 'gym-card-name'. */
  readonly from: string;
  readonly to: string;
}

/** Re-emit a value using the same quote character the original literal used. */
function requote(originalText: string, value: string): string {
  const quote = originalText.charAt(0);
  if (quote !== "'" && quote !== '"' && quote !== '`') return JSON.stringify(value);
  const escaped = value.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/** Build a readable path for a string literal: `OBJECT.property` or `CONST`. */
function describeLocation(node: Node): string | null {
  const property = node.getFirstAncestorByKind(SyntaxKind.PropertyAssignment);
  if (property !== undefined) {
    const declaration = property.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const owner = declaration?.getName();
    const name = property.getName().replace(/['"`]/g, '');
    return owner === undefined ? name : `${owner}.${name}`;
  }

  const declaration = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return declaration?.getName() ?? null;
}

function stringLiteralsEqualTo(source: SourceFile, value: string): Node[] {
  return [
    ...source.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...source.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ].filter(node => {
    const literal = node.asKind(SyntaxKind.StringLiteral) ?? node.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
    return literal?.getLiteralText() === value;
  });
}

/**
 * Replace every occurrence of a literal value in a constants file.
 *
 * Pure with respect to disk: the caller decides whether to write `after`, so
 * a dry run and a real apply take exactly the same code path.
 */
export function patchConstant(sourceText: string, input: PatchInput): PatchResult {
  if (input.from === input.to) {
    return {
      status: 'unchanged',
      file: input.file,
      from: input.from,
      to: input.to,
      before: sourceText,
      after: null,
      touched: [],
      message: 'The replacement is identical to the original.',
    };
  }

  const project = new Project({ useInMemoryFileSystem: true });
  const source = project.createSourceFile(input.file, sourceText, { overwrite: true });

  const matches = stringLiteralsEqualTo(source, input.from);
  if (matches.length === 0) {
    return {
      status: 'not-found',
      file: input.file,
      from: input.from,
      to: input.to,
      before: sourceText,
      after: null,
      touched: [],
      message: `No literal "${input.from}" in ${input.file}.`,
    };
  }

  const touched: TouchedConstant[] = [];
  for (const node of matches) {
    const path = describeLocation(node);
    touched.push({
      path: path ?? '(anonymous)',
      line: source.getLineAndColumnAtPos(node.getStart()).line,
    });
    // Reuse the literal's own quote style rather than emitting JSON. A patch
    // that switches a single-quoted file to double quotes fights the
    // formatter and turns a one-word change into a noisy diff — which is
    // exactly the kind of friction that gets a proposal rejected on sight.
    node.replaceWithText(requote(node.getText(), input.to));
  }

  return {
    status: 'applied',
    file: input.file,
    from: input.from,
    to: input.to,
    before: sourceText,
    after: source.getFullText(),
    touched,
    message:
      touched.length === 1
        ? `Replaced "${input.from}" with "${input.to}" in ${touched[0]?.path ?? ''}.`
        : `Replaced "${input.from}" with "${input.to}" in ${touched.length} constants sharing ` +
          `that literal: ${touched.map(t => t.path).join(', ')}.`,
  };
}

/**
 * Locate a literal without changing anything — used to report where a
 * selector is defined, which is the difference between "the selector broke"
 * and "the selector broke, here is the line".
 */
export function findConstant(sourceText: string, file: string, value: string): TouchedConstant[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const source = project.createSourceFile(file, sourceText, { overwrite: true });

  return stringLiteralsEqualTo(source, value).map(node => ({
    path: describeLocation(node) ?? '(anonymous)',
    line: source.getLineAndColumnAtPos(node.getStart()).line,
  }));
}
