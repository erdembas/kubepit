#!/usr/bin/env node
// Budget compare: checks the results of every performance suite against
// `perf/budgets.json` and exits 1 when a budget is missed or a budgeted
// result is missing.
//
//   pnpm perf:compare -- --slack 1                                     # reference machine
//   node scripts/perf/compare.mjs --slack ci --only rust,e2e,engines,structural   # CI
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluate,
  formatValue,
  GROUPS,
  informationalIds,
  loadResults,
  parseCompareArgs,
  resolveSlack,
  UsageError,
} from './compareLib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const USAGE = `Usage: pnpm perf:compare -- [options]

Reads the suites' results and checks them against perf/budgets.json:
  <target>/criterion/**/new/estimates.json   pnpm perf:rust (Criterion)
  <target>/perf/backend-e2e.json             pnpm perf:rust (e2e bench: max RSS, unpaged lists)
  perf-results/frontend-bench.json           pnpm perf:bench (Vitest bench)
  perf-results/ui*.json                      pnpm perf:ui (Playwright)
<target> is CARGO_TARGET_DIR or ./target.

  --slack <n>|ci       multiply timing budgets by n (divide min budgets); default 1;
                       ci = ci_slack from the budget file (the CI workflows use it)
  --only a,b,...       groups to check: ${GROUPS.join(',')} (default: all)
  --results a,b,...    result files or Criterion directories instead of the defaults
  --budgets <file>     budget file (default perf/budgets.json)`;

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
  const options = parseCompareArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const budgets = JSON.parse(readFileSync(path.resolve(ROOT, options.budgets), 'utf8'));
  options.slack = resolveSlack(options.slack, budgets);
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
  if (error instanceof UsageError) console.error(`\n${USAGE}`);
  process.exitCode = 1;
}
