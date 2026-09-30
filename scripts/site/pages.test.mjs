import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pagesBasePath } from './config.mjs';
import { verifyPagesOutput } from './verify.mjs';

test('Pages supports project, root and nested deployments without malformed prefixes', () => {
  assert.equal(pagesBasePath('/kubepit/'), '/kubepit');
  assert.equal(pagesBasePath(''), '');
  assert.equal(pagesBasePath('/'), '');
  assert.equal(pagesBasePath('/preview/kubepit'), '/preview/kubepit');
  for (const value of ['kubepit', '//example.com', '/a/../b', '/a/./b', '/a?x=1', '/a#b']) {
    assert.throws(() => pagesBasePath(value));
  }
});

async function fixture(t, base, demoAsset) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kubepit-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'demo/assets'), { recursive: true });
  await writeFile(path.join(root, '.nojekyll'), '');
  await writeFile(
    path.join(root, 'index.html'),
    `<a href="${base}/demo/">Demo</a><a href="https://github.com/erdembas/kubepit">Source</a>`,
  );
  await writeFile(path.join(root, 'demo/index.html'), `<script src="${demoAsset}"></script>`);
  await writeFile(path.join(root, 'demo/assets/app.js'), '');
  return root;
}

test('assembled site resolves website links and actual demo assets under a project path', async (t) => {
  const root = await fixture(t, '/kubepit', '/kubepit/demo/assets/app.js');
  assert.equal(await verifyPagesOutput(root, '/kubepit'), 2);
});

test('assembled site resolves root deployments too', async (t) => {
  const root = await fixture(t, '', '/demo/assets/app.js');
  assert.equal(await verifyPagesOutput(root, ''), 2);
});

test('artifact verification catches Vite assets built for the wrong base', async (t) => {
  const root = await fixture(t, '/kubepit', '/assets/app.js');
  await assert.rejects(verifyPagesOutput(root, '/kubepit'), /escapes Pages base path/);
});

test('artifact verification catches missing chunks', async (t) => {
  const root = await fixture(t, '/kubepit', '/kubepit/demo/assets/missing.js');
  await assert.rejects(verifyPagesOutput(root, '/kubepit'), /missing local target/);
});
