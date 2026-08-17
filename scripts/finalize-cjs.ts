/**
 * The root package.json declares `"type": "module"`, so every .js file emitted
 * under dist-cjs would be interpreted as ESM without a per-directory marker.
 *
 * Run directly with `node scripts/finalize-cjs.ts` — Node strips the types.
 */
import { mkdir, writeFile } from 'node:fs/promises';

const CJS_OUTPUT_DIRS: readonly string[] = [
  'packages/core/dist-cjs',
  'packages/runner-playwright/dist-cjs',
];

async function markAsCommonJs(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/package.json`, `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
}

await Promise.all(CJS_OUTPUT_DIRS.map(markAsCommonJs));

console.log(`[atest] commonjs markers written for ${CJS_OUTPUT_DIRS.length} packages`);
