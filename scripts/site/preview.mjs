import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesBasePath } from './config.mjs';

const directory = fileURLToPath(new URL('../../apps/website/out/', import.meta.url));
const root = path.resolve(directory);
const base = pagesBasePath();
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

await stat(path.join(directory, 'index.html'));
createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/' && base) {
      response.writeHead(302, { Location: `${base}/` }).end();
      return;
    }
    if (base && !url.pathname.startsWith(`${base}/`) && url.pathname !== base)
      throw new Error('Unknown base path');
    const relative = decodeURIComponent(url.pathname.slice(base.length)).replace(/^\/+/, '');
    let target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`))
      throw new Error('Unknown path');
    if ((await stat(target)).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(308, { Location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      target = path.join(target, 'index.html');
    }
    const content = await readFile(target);
    response.writeHead(200, {
      'Content-Type': types[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Pages preview: http://127.0.0.1:${port}${base}/`));
