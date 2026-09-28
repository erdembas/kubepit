import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluate, formatValue, GROUPS, informationalIds, loadResults } from './compareLib.mjs';

const budgets = {
  ci_slack: 2.5,
  budgets: {
    'watch/steady_500': { group: 'rust', value: 3e6, unit: 'ns', direction: 'max', timing: true },
    'ui/scroll_fps_l': { group: 'ui', value: 55, unit: 'fps', direction: 'min', timing: true },
    'structural/list_requests_without_limit': {
      group: 'structural',
      value: 2,
      unit: 'count',
      direction: 'max',
      timing: false,
    },
    'logs/parse_json': {
      group: 'engines',
      value: 0.004,
      unit: 'ms',
      direction: 'max',
      timing: true,
      per: 10000,
    },
  },
};

test('timings pass within budget × slack and fail beyond', () => {
  const r = evaluate(
    budgets,
    { 'watch/steady_500': { value: 7e6, unit: 'ns' } },
    { slack: 2.5, only: ['rust'] },
  );
  assert.equal(r.failed, false);
  assert.equal(
    evaluate(
      budgets,
      { 'watch/steady_500': { value: 8e6, unit: 'ns' } },
      { slack: 2.5, only: ['rust'] },
    ).failed,
    true,
  );
});
test('min budgets divide by the slack; structural budgets ignore it', () => {
  assert.equal(
    evaluate(
      budgets,
      { 'ui/scroll_fps_l': { value: 23, unit: 'fps' } },
      { slack: 2.5, only: ['ui'] },
    ).failed,
    false,
  );
  assert.equal(
    evaluate(
      budgets,
      { 'structural/list_requests_without_limit': { value: 3, unit: 'count' } },
      { slack: 2.5, only: ['structural'] },
    ).failed,
    true,
  );
});
test('per-line budgets divide the measured total', () => {
  assert.equal(
    evaluate(
      budgets,
      { 'logs/parse_json': { value: 35, unit: 'ms' } },
      { slack: 1, only: ['engines'] },
    ).failed,
    false,
  );
  assert.equal(
    evaluate(
      budgets,
      { 'logs/parse_json': { value: 45, unit: 'ms' } },
      { slack: 1, only: ['engines'] },
    ).failed,
    true,
  );
});
test('missing budgeted result fails', () => {
  const r = evaluate(budgets, {}, { slack: 2.5, only: ['rust'] });
  assert.equal(r.failed, true);
  assert.equal(r.rows[0].missing, true);
});
test('unknown result ids only warn', () => {
  const r = evaluate(
    budgets,
    { 'watch/steady_500': { value: 1e6, unit: 'ns' }, 'new/thing': { value: 1, unit: 'ms' } },
    { slack: 2.5, only: ['rust'] },
  );
  assert.equal(r.failed, false);
  assert.match(r.warnings.join('\n'), /new\/thing/);
});

test('only the selected groups get rows; the default is every group', () => {
  const results = { 'watch/steady_500': { value: 1e6, unit: 'ns' } };
  assert.deepEqual(
    evaluate(budgets, results, { only: ['rust'] }).rows.map((r) => r.id),
    ['watch/steady_500'],
  );
  assert.equal(evaluate(budgets, results).rows.length, 4);
  assert.deepEqual(GROUPS, ['rust', 'e2e', 'engines', 'ui', 'structural']);
});

test('results in another time unit are converted; incomparable units fail', () => {
  const ok = evaluate(
    budgets,
    { 'watch/steady_500': { value: 2.9, unit: 'ms' } },
    { only: ['rust'] },
  );
  assert.equal(ok.failed, false);
  assert.equal(ok.rows[0].value, 2.9e6);
  const bad = evaluate(
    budgets,
    { 'watch/steady_500': { value: 1, unit: 'bytes' } },
    { only: ['rust'] },
  );
  assert.equal(bad.failed, true);
  assert.match(bad.rows[0].error, /bytes/);
});

test('abs budgets compare the size of a drift; non-finite values count as missing', () => {
  const drift = {
    budgets: {
      'ui/soak_dom_nodes': {
        group: 'ui',
        value: 0.1,
        unit: 'ratio',
        direction: 'max',
        timing: false,
        abs: true,
      },
    },
  };
  const at = (value) =>
    evaluate(drift, { 'ui/soak_dom_nodes': { value, unit: 'ratio' } }, { slack: 2.5 });
  assert.equal(at(-0.05).failed, false);
  assert.equal(at(-0.2).failed, true);
  assert.equal(at(0.2).failed, true);
  assert.equal(at(Number.NaN).rows[0].missing, true);
});

test('informational ids neither warn nor get a row', () => {
  const file = { ...budgets, informational: ['ui/map_all_*'] };
  const results = {
    'watch/steady_500': { value: 1e6, unit: 'ns' },
    'ui/map_all_s': { value: 900, unit: 'ms' },
  };
  const r = evaluate(file, results, { only: ['rust'] });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(informationalIds(file, results), ['ui/map_all_s']);
});

test('loadResults reads Criterion, Vitest bench, the UI driver and the backend report', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kubepit-compare-'));
  try {
    const criterion = path.join(dir, 'criterion');
    const est = (group, name, median, fullId) => {
      const d = path.join(criterion, group, name, 'new');
      mkdirSync(d, { recursive: true });
      writeFileSync(
        path.join(d, 'estimates.json'),
        JSON.stringify({
          mean: { point_estimate: median * 2 },
          median: { point_estimate: median },
        }),
      );
      if (fullId)
        writeFileSync(path.join(d, 'benchmark.json'), JSON.stringify({ full_id: fullId }));
    };
    est('watch', 'steady_500', 2.5e6, 'watch/steady_500');
    est('e2e', 'fleet_search_l', 4e9);
    // Criterion's `base` copy and HTML reports are not results.
    mkdirSync(path.join(criterion, 'watch', 'steady_500', 'base'), { recursive: true });
    writeFileSync(
      path.join(criterion, 'watch', 'steady_500', 'base', 'estimates.json'),
      JSON.stringify({ median: { point_estimate: 1 } }),
    );
    const bench = path.join(dir, 'frontend-bench.json');
    writeFileSync(
      bench,
      JSON.stringify({
        files: [
          {
            filepath: 'x.bench.ts',
            groups: [
              {
                fullName: 'x.bench.ts',
                benchmarks: [
                  { name: 'health/scan_m', mean: 900, p75: 950 },
                  { name: 'logs/parse_json', median: 30, mean: 40 },
                ],
              },
            ],
          },
        ],
      }),
    );
    const ui = path.join(dir, 'ui.json');
    writeFileSync(
      ui,
      JSON.stringify({
        meta: {},
        results: { 'ui/scroll_fps_l': { value: 58, unit: 'fps' } },
        raw: {},
      }),
    );
    const e2e = path.join(dir, 'backend-e2e.json');
    writeFileSync(
      e2e,
      JSON.stringify({
        'e2e/max_rss_l_all_watchers': 4.4e8,
        'structural/list_requests_without_limit': 2,
      }),
    );
    const results = loadResults([criterion, bench, ui, e2e, path.join(dir, 'absent.json')]);
    assert.deepEqual(results, {
      'watch/steady_500': { value: 2.5e6, unit: 'ns' },
      'e2e/fleet_search_l': { value: 4e9, unit: 'ns' },
      'health/scan_m': { value: 900, unit: 'ms' },
      'logs/parse_json': { value: 30, unit: 'ms' },
      'ui/scroll_fps_l': { value: 58, unit: 'fps' },
      'e2e/max_rss_l_all_watchers': { value: 4.4e8, unit: 'bytes' },
      'structural/list_requests_without_limit': { value: 2, unit: 'count' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the checked-in budgets cover the spec ids with valid fields', () => {
  const file = JSON.parse(
    readFileSync(new URL('../../perf/budgets.json', import.meta.url), 'utf8'),
  );
  assert.equal(file.ci_slack, 2.5);
  for (const [id, b] of Object.entries(file.budgets)) {
    assert.ok(GROUPS.includes(b.group), `${id}: group`);
    assert.ok(['ns', 'ms', 'bytes', 'ratio', 'fps', 'count'].includes(b.unit), `${id}: unit`);
    assert.ok(['max', 'min'].includes(b.direction), `${id}: direction`);
    assert.equal(typeof b.timing, 'boolean', `${id}: timing`);
    assert.ok(Number.isFinite(b.value) && b.value > 0, `${id}: value`);
  }
  for (const id of [
    'watch/aggregator_initial_20k',
    'history/writer_events_10k',
    'e2e/max_rss_l_all_watchers',
    'structural/list_requests_without_limit',
    'logs/detect_level',
    'table/filter_sort_20k',
    'ui/ttfr_pods_s',
    'ui/soak_dom_nodes',
  ])
    assert.ok(id in file.budgets, id);
  assert.equal(Object.keys(file.budgets).length, 51);
});

test('formatValue picks a readable unit', () => {
  assert.equal(formatValue(2.5e6, 'ns'), '2.5 ms');
  assert.equal(formatValue(0.0035, 'ms'), '3.5 µs');
  assert.equal(formatValue(4.4e8, 'bytes'), '440 MB');
  assert.equal(formatValue(null, 'ms'), '—');
  assert.equal(formatValue(0, 'ms'), '0 ms');
});
