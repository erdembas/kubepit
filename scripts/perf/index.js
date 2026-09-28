// `node --test scripts/perf/` on Node 22+: a directory argument is no longer
// searched for tests; Node runs it as a module, which resolves to this file.
// It loads every `*.test.mjs` next to it. (Node 20 searches the directory
// itself and never matches this file, so nothing runs twice.)
import { readdirSync } from 'node:fs';

const dir = new URL('.', import.meta.url);
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort())
  await import(new URL(file, dir).href);
