import { spawn } from 'node:child_process';
import { cp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pagesBasePath } from './site/config.mjs';
import { verifyPagesOutput } from './site/verify.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../apps/website/out/', import.meta.url));
const base = pagesBasePath();
const env = { ...process.env, NEXT_PUBLIC_BASE_PATH: base, NEXT_TELEMETRY_DISABLED: '1' };

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      cwd: root,
      env: { ...env, ...extraEnv },
      stdio: 'inherit',
      // Windows resolves pnpm's .cmd wrapper through the command shell.
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(' ')} failed (${signal ?? code}).`));
    });
  });
}

await run(['check:version']);
await run(['--filter', '@kubepit/website', 'build']);
await run(['--filter', '@kubepit/desktop', 'build'], {
  VITE_BASE_PATH: `${base}/demo/`,
  VITE_PUBLIC_DEMO: 'true',
});
await cp(
  new URL('../apps/desktop/dist/', import.meta.url),
  new URL('../apps/website/out/demo/', import.meta.url),
  { recursive: true },
);
await writeFile(new URL('../apps/website/out/.nojekyll', import.meta.url), '');
const count = await verifyPagesOutput(output, base);
console.log(`Pages artifact ready: ${output} (${count} HTML pages; demo at ${base}/demo/).`);
