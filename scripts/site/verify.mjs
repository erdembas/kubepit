import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return htmlFiles(file);
      return entry.name.endsWith('.html') ? [file] : [];
    }),
  );
  return nested.flat();
}

/** Check the assembled artifact, so a project-path deployment cannot ship broken assets. */
export async function verifyPagesOutput(directory, basePath) {
  await Promise.all(
    ['index.html', 'demo/index.html', '.nojekyll'].map((file) =>
      access(path.join(directory, file)),
    ),
  );
  const pages = await htmlFiles(directory);
  const missing = new Set();
  for (const file of pages) {
    const relativePage = path.relative(directory, file).split(path.sep).join('/');
    const pageUrl = new URL(`${basePath}/${relativePage}`, 'https://pages.invalid');
    const html = await readFile(file, 'utf8');
    for (const [, rawUrl] of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
      if (/^(?:#|data:|blob:|mailto:|tel:|javascript:)/i.test(rawUrl)) continue;
      const url = new URL(rawUrl.replaceAll('&amp;', '&'), pageUrl);
      if (url.origin !== pageUrl.origin) continue;
      if (basePath && !url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
        missing.add(`${relativePage}: URL escapes Pages base path: ${rawUrl}`);
        continue;
      }
      const relative = decodeURIComponent(url.pathname.slice(basePath.length)).replace(/^\/+/, '');
      const target = path.resolve(directory, relative);
      if (
        target !== path.resolve(directory) &&
        !target.startsWith(`${path.resolve(directory)}${path.sep}`)
      ) {
        missing.add(`${relativePage}: URL escapes output directory: ${rawUrl}`);
        continue;
      }
      try {
        const info = await stat(target);
        if (info.isDirectory()) await access(path.join(target, 'index.html'));
      } catch {
        missing.add(`${relativePage}: missing local target: ${rawUrl}`);
      }
    }
  }
  if (missing.size) throw new Error(`Invalid Pages artifact:\n${[...missing].join('\n')}`);
  return pages.length;
}
