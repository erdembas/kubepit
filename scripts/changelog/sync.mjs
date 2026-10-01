import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateChangelog } from './model.mjs';

const root = new URL('../../', import.meta.url);
const output = new URL('shared/changelog/generated.json', root);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check') || args.length > 1) {
  throw new Error('Usage: node scripts/changelog/sync.mjs [--check]');
}
const generated = generateChangelog(await readFile(new URL('CHANGELOG.md', root), 'utf8'));
if (args.includes('--check')) {
  const current = await readFile(output, 'utf8').catch(() => '');
  if (current !== generated)
    throw new Error('Bundled changelog is stale. Run pnpm changelog:sync.');
  console.log('Changelog: bilingual source and bundled notes agree.');
} else {
  await mkdir(new URL('shared/changelog/', root), { recursive: true });
  await writeFile(output, generated);
  console.log(`Updated ${fileURLToPath(output)}`);
}
