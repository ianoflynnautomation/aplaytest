/**
 * The quarantine codemod.
 *
 * Writes `@quarantine` into a test's own tag array rather than maintaining a
 * side-list of quarantined tests. A suite that already excludes that tag needs
 * no new runtime machinery, the state is greppable, it travels with the code
 * in review, and deleting the test deletes the quarantine.
 *
 * WHY THIS LIVES IN @atest/flaky AND NOT @atest/core: ts-morph bundles the
 * TypeScript compiler. `core` is imported by the reporter, which runs inside
 * every test worker — loading a compiler there would be exactly the overhead
 * that makes people switch the tool off. `flaky` is never on that path. When
 * the heal engine needs the same plumbing, extract it to its own package
 * rather than pushing it down into core.
 */

import { Node, Project, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';

export const QUARANTINE_TAG = '@quarantine';

export type CodemodStatus =
  | 'applied'
  | 'already-tagged'
  | 'not-found'
  | 'ambiguous'
  | 'parameterised';

export interface CodemodResult {
  readonly status: CodemodStatus;
  readonly file: string;
  readonly before: string | null;
  readonly after: string | null;
  /** Human-readable explanation, safe to print verbatim. */
  readonly message: string;
  /** 1-indexed line of the matched test, when one was found. */
  readonly line: number | null;
}

export interface QuarantineCodemodInput {
  readonly file: string;
  readonly testTitle: string;
  /** Disambiguates when a title appears more than once in the file. */
  readonly line?: number;
  readonly tag?: string;
  /** Lines rendered as a leading block comment above the test. */
  readonly comment?: readonly string[];
}

/** `test(...)`, `test.only(...)`, `test.fail(...)` — but never `test.describe(...)`. */
function isTestCall(call: CallExpression): boolean {
  const expression = call.getExpression();

  if (Node.isIdentifier(expression)) return expression.getText() === 'test';

  if (Node.isPropertyAccessExpression(expression)) {
    const object = expression.getExpression().getText();
    const property = expression.getName();
    // describe/beforeEach/afterEach take a title too; tagging those would
    // quarantine an entire suite from a request to quarantine one test.
    const NON_TEST = new Set(['describe', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'step']);
    return object === 'test' && !NON_TEST.has(property);
  }

  return false;
}

function titleOf(call: CallExpression): string | null {
  const first = call.getArguments()[0];
  if (first === undefined) return null;
  if (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) {
    return first.getLiteralText();
  }
  return null;
}

function findTestCalls(source: SourceFile, title: string): CallExpression[] {
  return source
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(call => isTestCall(call) && titleOf(call) === title);
}

/**
 * The static fragments of a template-literal title, in order.
 *
 * `` `…selects "${name}", then ${path} is opened` `` yields
 * `['…selects "', '", then ', ' is opened']`.
 */
function templateQuasis(call: CallExpression): string[] | null {
  const first = call.getArguments()[0];
  if (first === undefined || !Node.isTemplateExpression(first)) return null;

  const parts = [first.getHead().getLiteralText()];
  for (const span of first.getTemplateSpans()) {
    parts.push(span.getLiteral().getLiteralText());
  }
  return parts;
}

/** Do the template's static fragments appear, in order, in this concrete title? */
function templateMatches(quasis: readonly string[], title: string): boolean {
  let cursor = 0;
  for (const part of quasis) {
    if (part === '') continue;
    const index = title.indexOf(part, cursor);
    if (index === -1) return false;
    cursor = index + part.length;
  }
  return true;
}

/**
 * Find a loop-generated test whose runtime title would match.
 *
 * Real suites parameterise: one `test()` call inside a `for` produces N tests
 * with computed titles. Reporting a plain "not found" for those reads as "your
 * title is wrong" and sends someone hunting a typo that is not there — so this
 * case gets its own status and its own explanation.
 */
function findParameterisedTest(source: SourceFile, title: string): CallExpression | null {
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isTestCall(call)) continue;
    const quasis = templateQuasis(call);
    if (quasis !== null && templateMatches(quasis, title)) return call;
  }
  return null;
}

/**
 * Add the tag to the test's options object, creating one if absent.
 *
 * Three shapes exist in the wild and all three must round-trip:
 *   test('…', async () => {})                       → insert `{ tag: [...] }`
 *   test('…', { tag: '@acceptance' }, async () => {}) → widen the string to an array
 *   test('…', { tag: ['@smoke'] }, async () => {})    → push onto the array
 */
function addTagToCall(call: CallExpression, tag: string): 'applied' | 'already-tagged' {
  const args = call.getArguments();
  const options = args[1];

  if (options !== undefined && Node.isObjectLiteralExpression(options)) {
    const tagProperty = options.getProperty('tag');

    if (tagProperty === undefined) {
      options.addPropertyAssignment({ name: 'tag', initializer: `['${tag}']` });
      return 'applied';
    }

    if (Node.isPropertyAssignment(tagProperty)) {
      const initializer = tagProperty.getInitializer();

      if (initializer !== undefined && Node.isArrayLiteralExpression(initializer)) {
        const existing = initializer.getElements().map(e => e.getText().replace(/['"`]/g, ''));
        if (existing.includes(tag)) return 'already-tagged';
        initializer.addElement(`'${tag}'`);
        return 'applied';
      }

      if (
        initializer !== undefined &&
        (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer))
      ) {
        const existing = initializer.getLiteralText();
        if (existing === tag) return 'already-tagged';
        tagProperty.setInitializer(`['${existing}', '${tag}']`);
        return 'applied';
      }
    }

    // A computed or spread tag value: append rather than rewrite, so we never
    // discard an expression we do not understand.
    options.addPropertyAssignment({ name: `/* atest */ tag`, initializer: `['${tag}']` });
    return 'applied';
  }

  // No options object — insert one between the title and the body.
  call.insertArgument(1, `{ tag: ['${tag}'] }`);
  return 'applied';
}

function statementOf(call: CallExpression): Node {
  return call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement) ?? call;
}

/**
 * Build the comment for insertion at `statement.getStart()`.
 *
 * That position sits AFTER the statement's existing leading whitespace, which
 * drives both details here: the first line takes no indent prefix (the
 * whitespace already in the file provides it), and the text ends with the
 * indent so the statement it precedes keeps its own indentation instead of
 * being left at column zero.
 */
function renderComment(lines: readonly string[], indent: string): string {
  const body = lines.map(line => `${indent} * ${line}`).join('\n');
  return `/**\n${body}\n${indent} */\n${indent}`;
}

/**
 * Apply the quarantine tag. Pure with respect to disk — the caller decides
 * whether to write `result.after`, so a dry run and a real run take exactly
 * the same code path.
 */
export function quarantineCodemod(
  sourceText: string,
  input: QuarantineCodemodInput,
): CodemodResult {
  const tag = input.tag ?? QUARANTINE_TAG;
  const project = new Project({ useInMemoryFileSystem: true });
  const source = project.createSourceFile(input.file, sourceText, { overwrite: true });

  let matches = findTestCalls(source, input.testTitle);

  if (matches.length === 0) {
    const parameterised = findParameterisedTest(source, input.testTitle);
    if (parameterised !== null) {
      const line = source.getLineAndColumnAtPos(parameterised.getStart()).line;
      return {
        status: 'parameterised',
        file: input.file,
        before: sourceText,
        after: null,
        line,
        message:
          `"${input.testTitle}" is generated at runtime by the parameterised test at ` +
          `${input.file}:${line}. Its title does not exist as a literal in the source, and the ` +
          `single test() call there produces every case in the loop — tagging it would ` +
          `quarantine all of them, not just this one.\n` +
          `Narrow the loop's data, extract this case into its own test(), or fix it directly; ` +
          `quarantine is not the right lever here.`,
      };
    }

    return {
      status: 'not-found',
      file: input.file,
      before: sourceText,
      after: null,
      line: null,
      message: `No test titled "${input.testTitle}" in ${input.file}.`,
    };
  }

  if (matches.length > 1 && input.line !== undefined) {
    const onLine = matches.filter(
      call => source.getLineAndColumnAtPos(call.getStart()).line === input.line,
    );
    if (onLine.length === 1) matches = onLine;
  }

  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      file: input.file,
      before: sourceText,
      after: null,
      line: null,
      message:
        `${matches.length} tests in ${input.file} share the title "${input.testTitle}". ` +
        'Pass the line number to disambiguate.',
    };
  }

  const call = matches[0];
  if (call === undefined) {
    return {
      status: 'not-found',
      file: input.file,
      before: sourceText,
      after: null,
      line: null,
      message: `No test titled "${input.testTitle}" in ${input.file}.`,
    };
  }

  const line = source.getLineAndColumnAtPos(call.getStart()).line;
  const tagResult = addTagToCall(call, tag);

  if (tagResult === 'already-tagged') {
    return {
      status: 'already-tagged',
      file: input.file,
      before: sourceText,
      after: null,
      line,
      message: `"${input.testTitle}" already carries ${tag}.`,
    };
  }

  // The comment is inserted LAST and by text position, because insertText
  // invalidates every node handle obtained before it.
  if (input.comment !== undefined && input.comment.length > 0) {
    const statement = statementOf(call);
    const start = statement.getStart();
    const column = source.getLineAndColumnAtPos(start).column;
    const indent = ' '.repeat(Math.max(0, column - 1));
    source.insertText(start, renderComment(input.comment, indent));
  }

  return {
    status: 'applied',
    file: input.file,
    before: sourceText,
    after: source.getFullText(),
    line,
    message: `Tagged "${input.testTitle}" with ${tag}.`,
  };
}

/** Remove the tag again — the release path. */
export function releaseCodemod(
  sourceText: string,
  input: Omit<QuarantineCodemodInput, 'comment'>,
): CodemodResult {
  const tag = input.tag ?? QUARANTINE_TAG;
  const project = new Project({ useInMemoryFileSystem: true });
  const source = project.createSourceFile(input.file, sourceText, { overwrite: true });

  const matches = findTestCalls(source, input.testTitle);
  const call = matches[0];

  if (call === undefined) {
    return {
      status: 'not-found',
      file: input.file,
      before: sourceText,
      after: null,
      line: null,
      message: `No test titled "${input.testTitle}" in ${input.file}.`,
    };
  }

  const line = source.getLineAndColumnAtPos(call.getStart()).line;
  const options = call.getArguments()[1];
  if (options === undefined || !Node.isObjectLiteralExpression(options)) {
    return {
      status: 'not-found',
      file: input.file,
      before: sourceText,
      after: null,
      line,
      message: `"${input.testTitle}" has no tags to remove.`,
    };
  }

  const tagProperty = options.getProperty('tag');
  if (tagProperty === undefined || !Node.isPropertyAssignment(tagProperty)) {
    return {
      status: 'not-found',
      file: input.file,
      before: sourceText,
      after: null,
      line,
      message: `"${input.testTitle}" has no tags to remove.`,
    };
  }

  const initializer = tagProperty.getInitializer();
  if (initializer === undefined || !Node.isArrayLiteralExpression(initializer)) {
    return {
      status: 'not-found',
      file: input.file,
      before: sourceText,
      after: null,
      line,
      message: `"${input.testTitle}" does not carry ${tag}.`,
    };
  }

  const index = initializer
    .getElements()
    .findIndex(e => e.getText().replace(/['"`]/g, '') === tag);

  if (index === -1) {
    return {
      status: 'not-found',
      file: input.file,
      before: sourceText,
      after: null,
      line,
      message: `"${input.testTitle}" does not carry ${tag}.`,
    };
  }

  initializer.removeElement(index);

  return {
    status: 'applied',
    file: input.file,
    before: sourceText,
    after: source.getFullText(),
    line,
    message: `Removed ${tag} from "${input.testTitle}".`,
  };
}
