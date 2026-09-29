// Pure helpers of the budget compare (`compare.mjs`): loading the result
// files of every suite and checking them against `perf/budgets.json`.
// Tested with `node --test scripts/perf/`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const GROUPS = ['rust', 'e2e', 'engines', 'ui', 'structural'];

/** A bad command line: `compare.mjs` prints the usage after the message. */
export class UsageError extends Error {}

/**
 * `compare.mjs` options: `slack` (default 1; `'ci'` until {@link resolveSlack}
 * reads the budget file), `only` (default every group), `results` (null =
 * the default paths), `budgets`, `help`. A lone `--` (pnpm forwards it) is
 * ignored; an empty `--only` or `--results` list is an error, not "nothing".
 */
export function parseCompareArgs(argv) {
  const options = {
    slack: 1,
    only: [...GROUPS],
    results: null,
    budgets: 'perf/budgets.json',
    help: false,
  };
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].startsWith('--') ? args[i].split(/=(.*)/s) : [args[i]];
    const value = () => {
      const v = inline ?? args[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    const list = () => {
      const items = value()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!items.length) throw new UsageError(`${flag} needs at least one value`);
      return items;
    };
    switch (flag) {
      case '--slack': {
        const raw = value();
        options.slack = raw === 'ci' ? 'ci' : Number(raw);
        if (options.slack !== 'ci' && !(Number.isFinite(options.slack) && options.slack > 0))
          throw new UsageError(`--slack must be a positive number or ci (got ${raw})`);
        break;
      }
      case '--only':
        options.only = list();
        for (const g of options.only)
          if (!GROUPS.includes(g))
            throw new UsageError(`Unknown group ${g} (known: ${GROUPS.join(', ')})`);
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
        throw new UsageError(`Unknown option ${args[i]}`);
    }
  }
  return options;
}

/** `slack` as a number: `'ci'` is the budget file's `ci_slack`. */
export function resolveSlack(slack, budgetFile) {
  if (slack !== 'ci') return slack;
  const ci = budgetFile.ci_slack;
  if (!(Number.isFinite(ci) && ci > 0))
    throw new Error('--slack ci: the budget file has no positive ci_slack');
  return ci;
}

/** Nanoseconds per time unit; results in another time unit are converted. */
const TIME_NS = { ns: 1, us: 1e3, µs: 1e3, ms: 1e6, s: 1e9 };

/**
 * `value` of `from` expressed in `to`, or `null` when the units are not
 * comparable. A result without a unit takes the budget's.
 */
export function convert(value, from, to) {
  if (!from || from === to) return value;
  if (from in TIME_NS && to in TIME_NS) return (value * TIME_NS[from]) / TIME_NS[to];
  return null;
}

/** Unit of an id in the backend's flat report (`target/perf/backend-e2e.json`). */
function flatUnit(id) {
  if (id.startsWith('structural/')) return 'count';
  if (id.includes('rss')) return 'bytes';
  return undefined;
}

/** Every `<dir>/**\/new/estimates.json` below `root` (Criterion's layout). */
function criterionEstimates(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      if (entry.name === 'new') {
        const file = path.join(sub, 'estimates.json');
        if (existsSync(file)) found.push(sub);
      } else if (entry.name !== 'report' && entry.name !== 'base' && entry.name !== 'change') {
        walk(sub);
      }
    }
  };
  walk(root);
  return found.sort();
}

/** Criterion: `median.point_estimate` (ns), keyed by the benchmark's full id. */
function loadCriterion(root, out) {
  for (const dir of criterionEstimates(root)) {
    const estimates = JSON.parse(readFileSync(path.join(dir, 'estimates.json'), 'utf8'));
    const meta = path.join(dir, 'benchmark.json');
    const id = existsSync(meta)
      ? JSON.parse(readFileSync(meta, 'utf8')).full_id
      : path.relative(root, path.dirname(dir)).split(path.sep).join('/');
    const value = estimates?.median?.point_estimate;
    if (id && typeof value === 'number') out[id] = { value, unit: 'ns' };
  }
}

/** Vitest bench JSON (`--outputJson`): `median ?? p50 ?? mean` in ms, keyed by the bench name. */
function loadVitest(json, out) {
  for (const file of json.files ?? [])
    for (const group of file.groups ?? [])
      for (const bench of group.benchmarks ?? []) {
        const value = bench.median ?? bench.p50 ?? bench.mean;
        if (typeof value === 'number') out[bench.name] = { value, unit: 'ms' };
      }
}

/**
 * Results of every suite, from files and directories:
 * - a directory: Criterion's `target/criterion` (`median.point_estimate`, ns);
 * - `{ files: [...] }`: Vitest bench JSON (`median ?? p50 ?? mean`, ms);
 * - `{ results: { id: { value, unit } } }`: the UI driver (`perf-results/ui*.json`);
 * - a flat `{ id: number }`: `target/perf/backend-e2e.json` (bytes, counts).
 *
 * Paths that do not exist are skipped: their budgeted ids then fail as
 * missing. A later path wins over an earlier one for the same id.
 */
export function loadResults(paths) {
  const out = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      loadCriterion(p, out);
      continue;
    }
    const json = JSON.parse(readFileSync(p, 'utf8'));
    if (Array.isArray(json?.files)) loadVitest(json, out);
    else if (json?.results && typeof json.results === 'object') {
      for (const [id, r] of Object.entries(json.results))
        if (typeof r?.value === 'number') out[id] = { value: r.value, unit: r.unit };
    } else {
      for (const [id, value] of Object.entries(json ?? {}))
        if (typeof value === 'number') out[id] = { value, unit: flatUnit(id) };
    }
  }
  return out;
}

/** `*` matches any run of characters; everything else is literal. */
function globMatch(pattern, id) {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${re}$`).test(id);
}

/**
 * Checks `results` against the budgets of the `only` groups.
 *
 * - Timing budgets allow `budget × slack` (`max`) or `budget ÷ slack`
 *   (`min`); the others (structural counts, memory, ratios) are exact.
 * - `per` divides the measured total first (per-line budgets); `abs`
 *   compares the absolute value (a drift of ±N).
 * - A budgeted id without a result fails (`missing`), as does a result in a
 *   unit that cannot be converted to the budget's.
 * - A result id with no budget and no `informational` pattern only warns.
 *
 * Returns one row per budget of the selected groups, in budget order;
 * `value` is the compared value in the budget's unit (per unit of `per`).
 */
export function evaluate(budgetFile, results, { slack = 1, only = GROUPS } = {}) {
  const budgets = budgetFile.budgets ?? {};
  const informational = budgetFile.informational ?? [];
  const rows = [];
  const warnings = [];
  for (const [id, b] of Object.entries(budgets)) {
    if (!only.includes(b.group)) continue;
    const limit = b.timing ? (b.direction === 'min' ? b.value / slack : b.value * slack) : b.value;
    const row = {
      id,
      group: b.group,
      unit: b.unit,
      direction: b.direction,
      budget: b.value,
      limit,
      value: null,
      ok: false,
      missing: false,
    };
    const r = results[id];
    if (!r || typeof r.value !== 'number' || !Number.isFinite(r.value)) {
      row.missing = true;
    } else {
      const converted = convert(r.value, r.unit, b.unit);
      if (converted === null) {
        row.error = `unit ${r.unit} is not comparable with ${b.unit}`;
      } else {
        const perUnit = converted / (b.per ?? 1);
        row.value = perUnit;
        const compared = b.abs ? Math.abs(perUnit) : perUnit;
        row.ok = b.direction === 'min' ? compared >= limit : compared <= limit;
      }
    }
    rows.push(row);
  }
  for (const id of Object.keys(results).sort()) {
    if (id in budgets || informational.some((pattern) => globMatch(pattern, id))) continue;
    warnings.push(`${id}: no budget in perf/budgets.json (add one, or list it as informational)`);
  }
  return { rows, failed: rows.some((row) => !row.ok), warnings };
}

/** Result ids that match an `informational` pattern and have no budget, sorted. */
export function informationalIds(budgetFile, results) {
  const budgets = budgetFile.budgets ?? {};
  const patterns = budgetFile.informational ?? [];
  return Object.keys(results)
    .filter((id) => !(id in budgets) && patterns.some((pattern) => globMatch(pattern, id)))
    .sort();
}

/** A value in a readable unit: ns → ns/µs/ms/s, bytes → MB. */
export function formatValue(value, unit) {
  if (value === null || value === undefined) return '—';
  const fixed = (n, digits) => Number(n.toFixed(digits)).toString();
  if (unit in TIME_NS) {
    if (value === 0) return `0 ${unit}`;
    const ns = value * TIME_NS[unit];
    if (ns >= 1e9) return `${fixed(ns / 1e9, 2)} s`;
    if (ns >= 1e6) return `${fixed(ns / 1e6, 2)} ms`;
    if (ns >= 1e3) return `${fixed(ns / 1e3, 2)} µs`;
    return `${fixed(ns, 1)} ns`;
  }
  if (unit === 'bytes') return `${fixed(value / 1e6, 1)} MB`;
  if (unit === 'ratio') return fixed(value, 3);
  if (unit === 'fps') return `${fixed(value, 1)} fps`;
  return `${fixed(value, 2)}${unit === 'count' ? '' : ` ${unit}`}`;
}
