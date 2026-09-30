#!/usr/bin/env node
// Kubepit i18n guard.
//
//   node scripts/check-i18n.mjs          → fail on missing/unused/placeholder-mismatched keys
//   node scripts/check-i18n.mjs --fix    → add missing English keys (value = key), drop unused
//                                          keys from both languages, print what still needs a
//                                          Turkish translation
//   --area=shell|workbench|dock           → limit to one catalog
//   --project=desktop|website            → limit to one app (default: both)
//
// Keys are the English source strings passed to i18n.t / i18n.rich / i18n.plural.
// Catalog ownership by path:
//   components/workbench/dock/**, lib/ipc/mock/dock.ts           → dock
//   components/workbench/**, lib/kube/**, lib/ipc/mock/resources.ts → workbench
//   everything else                                              → shell
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const projects = ['desktop', 'website'];
const fix = process.argv.includes('--fix');
const areaArg = process.argv.find((a) => a.startsWith('--area='))?.slice(7);
const projectArg = process.argv.find((a) => a.startsWith('--project='))?.slice(10);
const areas = ['shell', 'workbench', 'dock'];
if (areaArg !== undefined && !areas.includes(areaArg)) {
  console.error(`Unknown area: ${areaArg}. Use ${areas.join(', ')}.`);
  process.exit(1);
}
if (projectArg !== undefined && !projects.includes(projectArg)) {
  console.error(`Unknown project: ${projectArg}. Use ${projects.join(', ')}.`);
  process.exit(1);
}
const areaOf = (root, file) => {
  const rel = relative(root, file).split(sep).join('/');
  if (rel.startsWith('components/workbench/dock/') || rel === 'lib/ipc/mock/dock.ts') return 'dock';
  if (
    rel.startsWith('components/workbench/') ||
    rel.startsWith('lib/kube/') ||
    rel === 'lib/ipc/mock/resources.ts'
  )
    return 'workbench';
  return 'shell';
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

// Matches t('…'), i18n.t("…"), rich('…'), plural('…', '…') — single or double quotes.
const CALL =
  /\b(t|rich|plural)\(\s*(['"])((?:\\.|(?!\2).)*)\2(?:\s*,\s*(['"])((?:\\.|(?!\4).)*)\4)?/g;
const unescape = (s) => s.replace(/\\(.)/g, (_, ch) => ({ n: '\n', t: '\t', r: '\r' })[ch] ?? ch);

const load = (root, lang, area) =>
  JSON.parse(readFileSync(join(root, 'i18n', lang, `${area}.json`), 'utf8'));
const save = (root, lang, area, data) =>
  writeFileSync(
    join(root, 'i18n', lang, `${area}.json`),
    JSON.stringify(
      Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))),
      null,
      2,
    ) + '\n',
  );
const placeholders = (s) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

let problems = 0;
for (const project of projects) {
  if (projectArg && project !== projectArg) continue;
  const root = fileURLToPath(new URL(`../apps/${project}/src/`, import.meta.url));
  // Each app owns its own catalogs, including keys shared by both apps.
  const used = Object.fromEntries(areas.map((a) => [a, new Map()]));
  for (const file of walk(root)) {
    if (file.includes(`${sep}i18n${sep}`)) continue;
    const src = readFileSync(file, 'utf8');
    if (!/i18n|\bt\(|rich\(|plural\(/.test(src)) continue;
    for (const m of src.matchAll(CALL)) {
      const before = src.slice(Math.max(0, m.index - 12), m.index);
      // Only calls through the i18n module or destructured helpers.
      if (!/(i18n\.|^|[^\w.])$/.test(before)) continue;
      if (/\w$/.test(before) && !before.endsWith('i18n.')) continue;
      const area = areaOf(root, file);
      used[area].set(unescape(m[3]), file);
      if (m[1] === 'plural' && m[5] !== undefined) used[area].set(unescape(m[5]), file);
    }
  }

  for (const area of areas) {
    if (areaArg && area !== areaArg) continue;
    const en = load(root, 'en', area);
    const tr = load(root, 'tr', area);
    const keys = used[area];
    const label = `${project}/${area}`;
    for (const key of keys.keys()) {
      if (!(key in en)) {
        if (fix) en[key] = key;
        else {
          console.error(
            `[${label}] missing en: ${JSON.stringify(key)}  (${relative(root, keys.get(key))})`,
          );
          problems++;
        }
      }
    }
    for (const key of Object.keys(en)) {
      if (!keys.has(key)) {
        if (fix) {
          delete en[key];
          delete tr[key];
        } else {
          console.error(`[${label}] unused: ${JSON.stringify(key)}`);
          problems++;
        }
      }
    }
    for (const key of Object.keys(en)) {
      if (!(key in tr)) {
        console.error(`[${label}] missing tr: ${JSON.stringify(key)}`);
        problems++;
      } else if (placeholders(en[key]) !== placeholders(tr[key])) {
        console.error(`[${label}] placeholder mismatch: ${JSON.stringify(key)}`);
        problems++;
      }
    }
    if (fix) {
      save(root, 'en', area, en);
      save(root, 'tr', area, tr);
    }
  }
}
if (problems) {
  console.error(`\n${problems} i18n problem(s).`);
  process.exit(1);
}
console.log('i18n OK');
