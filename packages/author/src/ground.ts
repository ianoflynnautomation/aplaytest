/**
 * Phase 1 — Ground. Retrieval, never guessing.
 *
 * Everything the author agent is told about a repository is READ from that
 * repository. Nothing here is inferred, and nothing is a style rule: the
 * agent gets the conventions file verbatim, the real page-object signatures,
 * the real seeded fixtures, and two exemplar specs.
 *
 * Exemplars beat rules by a wide margin. "Match this file's idiom", with a
 * concrete file attached, produces conventional code. A bulleted list of the
 * same rules produces plausible-looking code that fails review on five small
 * things — because the rules a repo actually enforces are mostly the ones
 * nobody wrote down.
 *
 * This phase is deterministic and runs with no model and no network, which
 * also makes it the part you can inspect when the agent's output is wrong.
 */

import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

export interface ExemplarSpec {
  readonly path: string;
  readonly source: string;
  /** Why this file was chosen — shown to a human reviewing a bad generation. */
  readonly reason: string;
}

export interface GroundingBundle {
  readonly feature: string;
  /** CLAUDE.md / AGENTS.md, verbatim. Already a precise spec; do not paraphrase. */
  readonly conventions: string | null;
  readonly conventionsPath: string | null;
  /** Exported signatures of the feature's page object. */
  readonly pageObjectApi: readonly string[];
  readonly pageObjectPath: string | null;
  /** Seeded fixture module, verbatim — DTOs and partial-name guards. */
  readonly seededData: string | null;
  readonly seededDataPath: string | null;
  readonly exemplars: readonly ExemplarSpec[];
  /** Everything that was looked for and not found — the agent must be told. */
  readonly missing: readonly string[];
}

export interface GroundOptions {
  readonly cwd: string;
  readonly feature: string;
  readonly conventionsFile?: string | undefined;
  readonly specGlobDirs?: readonly string[] | undefined;
  readonly pageObjectDirs?: readonly string[] | undefined;
  readonly seededDirs?: readonly string[] | undefined;
}

const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules'];
const DEFAULT_SPEC_DIRS = ['tests', 'e2e', 'src/tests'];
const DEFAULT_PO_DIRS = ['src/ui/pages', 'src/pages', 'pages'];
const DEFAULT_SEEDED_DIRS = ['tests/testdata/seeded', 'tests/fixtures', 'testdata'];

async function readIfPresent(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

async function walk(dir: string, depth = 4): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path, depth - 1)));
    else out.push(path);
  }
  return out;
}

/**
 * Extract exported signatures rather than whole page-object bodies.
 *
 * The bodies are long, and their internals are exactly what the generated
 * spec must NOT reach into. Handing over the full source invites a spec that
 * reimplements a page object's internals inline — which then breaks the next
 * time that page object changes, without the page object's own tests noticing.
 */
export function extractSignatures(source: string): string[] {
  const signatures: string[] = [];
  const pattern = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)\s*:\s*([^{]+)\{/g;

  for (const match of source.matchAll(pattern)) {
    const [, name, params, returns] = match;
    if (name === undefined) continue;
    // Drop the trailing comma a multi-line parameter list leaves behind:
    // `search(page: Page, term: string,)` is what the model would copy.
    const flatParams = (params ?? '').replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
    const flatReturn = (returns ?? '').replace(/\s+/g, ' ').trim();
    signatures.push(`${name}(${flatParams}): ${flatReturn}`);
  }
  return signatures;
}

/**
 * Which feature a file belongs to, from its path.
 *
 * Needed because the second exemplar must come from a DIFFERENT feature, and
 * "different" cannot be inferred from a relevance score. Measured against the
 * real repo, ranking `gyms.api.acceptance.spec.ts` below the same-feature
 * threshold made it look like another feature's file, so the agent was handed
 * two gyms specs while being told the second showed cross-feature idiom — the
 * one thing it was there to do.
 */
export function featureKeyOf(path: string): string {
  const segments = path.split('/');
  const featuresAt = segments.lastIndexOf('features');
  if (featuresAt !== -1 && featuresAt + 1 < segments.length) {
    return (segments[featuresAt + 1] ?? '').toLowerCase();
  }
  // Fall back to the leading dot-segment: `gyms.ui.acceptance.spec.ts` → gyms.
  return (basename(path).split('.')[0] ?? '').toLowerCase();
}

/** Kind only. Provenance is decided separately, by `featureKeyOf`. */
function scoreExemplar(path: string): number {
  const name = basename(path).toLowerCase();
  let score = 0;
  if (name.includes('.ui.')) score += 5;
  if (name.includes('spec')) score += 2;
  if (name.includes('.api.') || name.includes('.a11y.') || name.includes('.snapshot.')) score -= 4;
  // Scaffolds are deliberately minimal — a two-step placeholder is the
  // opposite of what an exemplar is for. Against the real repo, `_template`
  // tied with every genuine spec on kind and then won on alphabetical order.
  if (/(^|\/|\.)_?template/.test(path.toLowerCase())) score -= 6;
  return score;
}

/**
 * Among equally-typed candidates, prefer the file with more in it.
 *
 * A longer spec demonstrates more of the repo's idiom — describe blocks, tags,
 * fixture usage, several assertion styles — and idiom is the entire reason an
 * exemplar is attached rather than a list of rules.
 */
async function pickRichest(
  candidates: readonly { path: string; score: number }[],
): Promise<{ path: string; source: string } | null> {
  const best = candidates[0];
  if (best === undefined) return null;

  const tied = candidates.filter(c => c.score === best.score).slice(0, 6);
  let chosen: { path: string; source: string } | null = null;
  for (const candidate of tied) {
    const source = await readIfPresent(candidate.path);
    if (source === null) continue;
    if (chosen === null || source.length > chosen.source.length) chosen = { path: candidate.path, source };
  }
  return chosen;
}

/**
 * Rank page-object candidates instead of taking the first name that matches.
 *
 * Measured against the real repo: `find()` on "filename contains the feature"
 * returned `gyms.card.mapper.ts` — alphabetically first — handing the agent a
 * single DTO mapper in place of the page object's entire API. With no methods
 * to call, the model can only invent one or give up, and the invention guard
 * then rejects its own draft.
 */
function scorePageObject(path: string, feature: string): number {
  const name = basename(path).toLowerCase();
  const key = feature.toLowerCase();

  let score = 0;
  if (name === `${key}.page.ts`) score += 20;
  else if (name.endsWith('.page.ts')) score += 10;
  if (name.includes(key)) score += 5;
  // Siblings sharing the folder and the feature name, but not the page object.
  if (/\.(mapper|constants|types|schemas?|builder|fixture)\.ts$/.test(name)) score -= 12;
  if (name.endsWith('.spec.ts') || name.endsWith('.test.ts')) score -= 20;
  return score;
}

export async function ground(options: GroundOptions): Promise<GroundingBundle> {
  const { cwd, feature } = options;
  const missing: string[] = [];

  // ── Conventions ────────────────────────────────────────────────────────
  let conventions: string | null = null;
  let conventionsPath: string | null = null;
  const conventionCandidates =
    options.conventionsFile === undefined ? CONVENTION_FILES : [options.conventionsFile];
  for (const name of conventionCandidates) {
    const text = await readIfPresent(join(cwd, name));
    if (text !== null) {
      conventions = text;
      conventionsPath = name;
      break;
    }
  }
  if (conventions === null) missing.push(`conventions file (looked for ${conventionCandidates.join(', ')})`);

  // ── Page object ────────────────────────────────────────────────────────
  let pageObjectApi: string[] = [];
  let pageObjectPath: string | null = null;
  const poCandidates: { path: string; score: number }[] = [];
  for (const dir of options.pageObjectDirs ?? DEFAULT_PO_DIRS) {
    for (const file of await walk(join(cwd, dir), 3)) {
      if (!file.endsWith('.ts')) continue;
      if (!basename(file).toLowerCase().includes(feature.toLowerCase())) continue;
      poCandidates.push({ path: file, score: scorePageObject(file, feature) });
    }
  }
  poCandidates.sort((a, b) => b.score - a.score);

  for (const candidate of poCandidates) {
    const source = await readIfPresent(candidate.path);
    if (source === null) continue;
    const signatures = extractSignatures(source);
    // A file with no exported functions is not a page object, whatever it is
    // called. Falling through to the next candidate beats reporting an empty
    // API as if it were the truth.
    if (signatures.length === 0) continue;
    pageObjectApi = signatures;
    pageObjectPath = relative(cwd, candidate.path);
    break;
  }
  if (pageObjectPath === null) missing.push(`page object for "${feature}"`);

  // ── Seeded data ────────────────────────────────────────────────────────
  let seededData: string | null = null;
  let seededDataPath: string | null = null;
  for (const dir of options.seededDirs ?? DEFAULT_SEEDED_DIRS) {
    const files = await walk(join(cwd, dir), 2);
    const match = files.find(
      f => f.endsWith('.ts') && basename(f).toLowerCase().includes(feature.toLowerCase()),
    );
    if (match !== undefined) {
      seededData = await readIfPresent(match);
      if (seededData !== null) {
        seededDataPath = relative(cwd, match);
        break;
      }
    }
  }
  if (seededDataPath === null) missing.push(`seeded fixtures for "${feature}"`);

  // ── Exemplars ──────────────────────────────────────────────────────────
  const specFiles: string[] = [];
  for (const dir of options.specGlobDirs ?? DEFAULT_SPEC_DIRS) {
    specFiles.push(...(await walk(join(cwd, dir), 4)).filter(f => /\.spec\.ts$/.test(f)));
  }

  const key = feature.toLowerCase();
  const ranked = specFiles
    .map(path => ({ path, score: scoreExemplar(path), key: featureKeyOf(path) }))
    .sort((a, b) => b.score - a.score);

  const exemplars: ExemplarSpec[] = [];

  const sameFeature = await pickRichest(ranked.filter(r => r.key === key));
  if (sameFeature !== null) {
    exemplars.push({
      path: relative(cwd, sameFeature.path),
      source: sameFeature.source,
      reason: `nearest spec in the same feature ("${feature}")`,
    });
  }

  // A second exemplar from a genuinely DIFFERENT feature. One file teaches the
  // feature's vocabulary; two teach which patterns are the repo's idiom and
  // which were incidental to that one file — which only works if the second
  // file is actually from elsewhere.
  const other = await pickRichest(ranked.filter(r => r.key !== key && r.score > 0));
  if (other !== null) {
    exemplars.push({
      path: relative(cwd, other.path),
      source: other.source,
      reason: `spec from another feature ("${featureKeyOf(other.path)}") — shows which patterns are repo idiom`,
    });
  }
  if (exemplars.length === 0) missing.push('exemplar specs');

  return {
    feature,
    conventions,
    conventionsPath,
    pageObjectApi,
    pageObjectPath,
    seededData,
    seededDataPath,
    exemplars,
    missing,
  };
}
