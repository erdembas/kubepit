import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appUrl,
  isAllowedUrl,
  parseArgs,
  percentile,
  previewListening,
  resultIds,
  SCENARIOS,
  servesBuild,
  soakSummary,
  withUnits,
} from './lib.mjs';

test('parseArgs applies defaults and validates the preset', () => {
  assert.deepEqual(parseArgs([]).preset, 'm');
  assert.deepEqual(parseArgs(['--preset', 'l', '--soak', '30']).soak, 30);
  assert.throws(() => parseArgs(['--preset', 'xl']), /preset/);
});
test('parseArgs reads every option and ignores the -- pnpm forwards', () => {
  const o = parseArgs(['--', '--preset=s', '--scenarios', 'ttfr,scroll', '--churn', '50']);
  assert.deepEqual(
    [o.preset, o.scenarios, o.churn, o.soak, o.port],
    ['s', ['ttfr', 'scroll'], 50, 0, 4173],
  );
  assert.deepEqual(parseArgs([]).scenarios, SCENARIOS);
  assert.equal(parseArgs(['--port', '5000', '--out', 'x.json']).out, 'x.json');
  assert.throws(() => parseArgs(['--scenarios', 'ttfr,fly']), /fly/);
  assert.throws(() => parseArgs(['--churn', '5000']), /churn/);
  assert.throws(() => parseArgs(['--port']), /needs a value/);
  assert.throws(() => parseArgs(['--kube', 'prod']), /Unknown option/);
});
test('soakSummary compares the end with the 5-minute sample', () => {
  const s = soakSummary([
    { minute: 1, heap: 50, dom: 900 },
    { minute: 5, heap: 100, dom: 1000 },
    { minute: 30, heap: 110, dom: 1050 },
  ]);
  assert.equal(s.heapRatio, 1.1);
  assert.equal(s.domDrift, 0.05);
});
test('soakSummary of a short soak uses its first sample', () => {
  const s = soakSummary([
    { minute: 1, heap: 100, dom: 1000 },
    { minute: 2, heap: 120, dom: 900 },
  ]);
  assert.equal(s.heapRatio, 1.2);
  assert.equal(s.domDrift, -0.1);
});
test('resultIds names results like the budgets', () => {
  assert.deepEqual(Object.keys(resultIds('l', { ttfr: 900, synced: 3000 })).sort(), [
    'ui/synced_pods_l',
    'ui/ttfr_pods_l',
  ]);
});
test('resultIds covers every scenario and drops missing values', () => {
  const ids = resultIds(
    'm',
    {
      ttfr: 1,
      scrollFps: 60,
      applyP95: 9,
      mapNamespace: 2,
      mapAll: null,
      mapLeave: 3,
      soakHeapRatio: 1.02,
      healthScan: NaN,
    },
    { churn: 50 },
  );
  assert.deepEqual(Object.keys(ids).sort(), [
    'ui/apply_p95_m_churn50',
    'ui/map_leave',
    'ui/map_namespace_m',
    'ui/scroll_fps_m',
    'ui/soak_heap_ratio',
    'ui/ttfr_pods_m',
  ]);
  assert.deepEqual(withUnits(ids)['ui/scroll_fps_m'], { value: 60, unit: 'fps' });
  assert.deepEqual(withUnits(ids)['ui/soak_heap_ratio'], { value: 1.02, unit: 'ratio' });
  assert.deepEqual(withUnits(ids)['ui/ttfr_pods_m'], { value: 1, unit: 'ms' });
});
test('the driver only talks to the local preview server', () => {
  assert.equal(
    appUrl(4173, { preset: 's', churn: 0 }),
    'http://localhost:4173/?perf=1&scale=s&churn=0',
  );
  assert.equal(isAllowedUrl('http://localhost:4173/assets/index.js', 4173), true);
  assert.equal(isAllowedUrl('data:image/png;base64,AAAA', 4173), true);
  assert.equal(isAllowedUrl('http://localhost:6443/api', 4173), false);
  assert.equal(isAllowedUrl('https://fonts.googleapis.com/css', 4173), false);
  assert.equal(isAllowedUrl('https://kubernetes.default.svc/api', 4173), false);
});
test('the preview must serve this checkout’s build, from vite itself', () => {
  const built =
    '<!doctype html>\n<script type="module" src="/assets/index-CHuGkJDi.js"></script>\n';
  assert.equal(servesBuild(built, built), true);
  assert.equal(servesBuild(`${built}\n`, built), true);
  assert.equal(servesBuild(built.replace('CHuGkJDi', 'Bx81kQ0a'), built), false);
  assert.equal(servesBuild('<html>another app</html>', built), false);
  assert.equal(servesBuild(null, built), false);
  const ready =
    '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m4180\x1b[22m/\x1b[39m\n';
  assert.equal(previewListening(ready, 4180), true);
  assert.equal(previewListening(ready, 418), false);
  assert.equal(previewListening('error: Port 4180 is already in use\n', 4180), false);
});
test('percentile uses nearest rank', () => {
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.ok(Number.isNaN(percentile([], 50)));
});
