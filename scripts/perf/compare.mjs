#!/usr/bin/env node
// Budget compare: checks the results of every performance suite against
// `perf/budgets.json` and exits 1 when a budget is missed or a budgeted
// result is missing.
//
//   pnpm perf:compare -- --slack 1                                   # reference machine
//   node scripts/perf/compare.mjs --slack 2.5 --only rust,e2e,engines,structural   # CI
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, formatValue, GROUPS, informationalIds, loadResults } from './compareLib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const USAGE = `Usage: pnpm perf:compare -- [options]

Reads the suites' results and checks them against perf/budgets.json:
  <target>/criterion/**/new/estimates.json   pnpm perf:rust (Criterion)
  <target>/perf/backend-e2e.json             pnpm perf:rust (e2e bench: max RSS, unpaged lists)
  perf-results/frontend-bench.json           pnpm perf:bench (Vitest bench)
  perf-results/ui*.json                      pnpm perf:ui (Playwright)
<target> is CARGO_TARGET_DIR or ./target.

  --slack <n>          multiply timing budgets by n (divide min budgets); default 1,
                       CI uses ci_slack from perf/budgets.json
  --only a,b,...       groups to check: ${GROUPS.join(',')} (default: all)
  --results a,b,...    result files or Criterion directories instead of the defaults
  --budgets <file>     budget file (default perf/budgets.json)`;

function parseArgs(argv) {
  const options = { slack: 1, only: [...GROUPS], results: null, budgets: 'perf/budgets.json' };
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].startsWith('--') ? args[i].split(/=(.*)/s) : [args[i]];
    const value = () => {
      const v = inline ?? args[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    const list = () =>
      value()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    switch (flag) {
      case '--slack':
        options.slack = Number(value());
        if (!Number.isFinite(options.slack) || options.slack <= 0)
          throw new Error('--slack must be a positive number');
        break;
      case '--only':
        options.only = list();
        for (const g of options.only)
          if (!GROUPS.includes(g))
            throw new Error(`Unknown group ${g} (known: ${GROUPS.join(', ')})`);
        break;
      case '--results':
        options.results = list();
        break;
      case '--budgets':
        options.budgets = value();
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option ${args[i]}\n\n${USAGE}`);
    }
  }
  return options;
}

function defaultResultPaths() {
  const target = path.resolve(ROOT, process.env.CARGO_TARGET_DIR ?? 'target');
  const perfResults = path.join(ROOT, 'perf-results');
  let ui = [];
  try {
    ui = readdirSync(perfResults)
      .filter((f) => /^ui.*\.json$/.test(f))
      .sort()
      .map((f) => path.join(perfResults, f));
  } catch {
    // No UI results yet: their budgets report as missing.
  }
  return [
    path.join(target, 'criterion'),
    path.join(target, 'perf/backend-e2e.json'),
    path.join(perfResults, 'frontend-bench.json'),
    ...ui,
  ];
}

function table(rows) {
  const width = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows
    .map((r) =>
      r
        .map((cell, c) => cell.padEnd(width[c]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const budgets = JSON.parse(readFileSync(path.resolve(ROOT, options.budgets), 'utf8'));
  const paths = (options.results ?? defaultResultPaths()).map((p) => path.resolve(ROOT, p));
  const results = loadResults(paths);
  const { rows, failed, warnings } = evaluate(budgets, results, options);

  const status = (row) => (row.missing ? 'MISSING' : row.error ? 'ERROR' : row.ok ? 'ok' : 'FAIL');
  const lines = [['id', 'value', 'budget', `limit (slack ${options.slack})`, 'status']];
  for (const row of rows) {
    const op = row.direction === 'min' ? '≥' : '≤';
    const abs = budgets.budgets[row.id]?.abs ? '±' : '';
    lines.push([
      row.id,
      formatValue(row.value, row.unit),
      `${op} ${abs}${formatValue(row.budget, row.unit)}`,
      `${op} ${abs}${formatValue(row.limit, row.unit)}`,
      row.error ? `${status(row)}: ${row.error}` : status(row),
    ]);
  }
  console.log(`perf:compare: groups ${options.only.join(',')}, slack ${options.slack}\n`);
  console.log(table(lines));

  const info = informationalIds(budgets, results);
  if (info.length) {
    console.log('\ninformational (no budget):');
    for (const id of info)
      console.log(`  ${id}  ${formatValue(results[id].value, results[id].unit)}`);
  }
  for (const w of warnings) console.warn(`warning: ${w}`);

  const count = (pred) => rows.filter(pred).length;
  console.log(
    `\n${count((r) => r.ok)} ok, ${count((r) => !r.ok && !r.missing)} over budget, ${count((r) => r.missing)} missing`,
  );
  if (failed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`[perf:compare] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
