import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');
const jsonVersion = async (file) => JSON.parse(await read(file)).version;
const expected = await jsonVersion('package.json');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected))
  throw new Error(`Invalid release version: ${expected}`);
const versions = new Map([['package.json', expected]]);
for (const file of [
  'apps/desktop/package.json',
  'apps/website/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
]) {
  versions.set(file, await jsonVersion(file));
}
for (const file of ['crates/kubepit-core/Cargo.toml', 'apps/desktop/src-tauri/Cargo.toml']) {
  const section = (await read(file)).match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  versions.set(file, section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]);
}
const lock = await read('Cargo.lock');
for (const name of ['kubepit-core', 'kubepit-desktop']) {
  versions.set(
    `Cargo.lock (${name})`,
    lock.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`))?.[1],
  );
}
for (const [file, actual] of versions) {
  if (actual !== expected)
    throw new Error(`${file}: version ${actual} does not match package.json ${expected}`);
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${expected}`) {
  throw new Error(`Release tag ${process.env.GITHUB_REF_NAME} does not match v${expected}`);
}
console.log(`All ${versions.size} release versions agree: ${expected}.`);
