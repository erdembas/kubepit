// Pure helpers of the UI performance driver (`ui-perf.mjs`): argument
// parsing, result ids and the soak summary. Tested with `node --test scripts/perf/`.

export const PRESETS = ['s', 'm', 'l'];
export const SCENARIOS = ['ttfr', 'scroll', 'apply', 'map', 'health', 'leave'];
export const MAX_CHURN = 1000;

export const USAGE = `Usage: pnpm perf:ui -- [options]

Runs UI scenarios against the production build (vite preview) with the
in-memory demo backend (?perf=1&scale=<preset>&churn=<n>). Never a real cluster.
Build first: pnpm --filter @kubepit/desktop build

  --preset s|m|l          scaled demo cluster c-scale-<preset> (default m)
  --scenarios a,b,...     ${SCENARIOS.join(',')} (default: all)
  --churn <n>             pod changes per second, 0-${MAX_CHURN} (default 0; apply needs > 0)
  --soak <minutes>        also cycle pods table / map / health for that long (default 0)
  --port <port>           vite preview port (default 4173)
  --out <file>            result file (default perf-results/ui.json)
  --headed                show the browser`;

/**
 * CLI options with defaults: preset `m`, every scenario, churn 0, soak 0,
 * port 4173. A lone `--` (pnpm forwards it) is ignored.
 */
export function parseArgs(argv) {
  const options = {
    preset: 'm',
    scenarios: [...SCENARIOS],
    churn: 0,
    soak: 0,
    port: 4173,
    out: 'perf-results/ui.json',
    headed: false,
    help: false,
  };
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = flag === arg ? undefined : arg.slice(eq + 1);
    const value = () => {
      const v = inline ?? args[++i];
      if (v === undefined || (inline === undefined && v.startsWith('--')))
        throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--preset':
        options.preset = value();
        break;
      case '--scenarios':
        options.scenarios = value()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--churn':
        options.churn = number(flag, value(), 0, MAX_CHURN);
        break;
      case '--soak':
        options.soak = number(flag, value(), 0, 24 * 60);
        break;
      case '--port':
        options.port = number(flag, value(), 1, 65535);
        if (!Number.isInteger(options.port)) throw new Error('--port must be an integer');
        break;
      case '--out':
        options.out = value();
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
    }
  }
  if (!PRESETS.includes(options.preset))
    throw new Error(`--preset must be one of ${PRESETS.join(', ')} (got ${options.preset})`);
  for (const s of options.scenarios)
    if (!SCENARIOS.includes(s))
      throw new Error(`Unknown scenario ${s} (known: ${SCENARIOS.join(', ')})`);
  return options;
}

function number(flag, raw, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`${flag} must be a number from ${min} to ${max} (got ${raw})`);
  return n;
}

/** The only page the driver opens: the demo UI on localhost. */
export function appUrl(port, { preset, churn }) {
  const url = new URL(`http://localhost:${port}/`);
  url.searchParams.set('perf', '1');
  url.searchParams.set('scale', preset);
  url.searchParams.set('churn', String(churn));
  return url.toString();
}

/** Requests the page may make: the preview server itself, or inline data. */
export function isAllowedUrl(raw, port) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
    url.port === String(port)
  );
}

/**
 * Whether `body` (what the preview server answers for `/`) is this
 * checkout's built `index.html`. Its asset names carry content hashes, so
 * another build, another app or another server never matches.
 */
export function servesBuild(body, builtIndex) {
  return typeof body === 'string' && body.trim() === builtIndex.trim();
}

/** Whether vite preview's output says it listens on `port` itself. */
export function previewListening(output, port) {
  // eslint-disable-next-line no-control-regex -- strips ANSI colours
  return output.replace(/\x1b\[[0-9;]*m/g, '').includes(`://localhost:${port}/`);
}

/** Nearest-rank percentile (`p` in 0–100); `NaN` for an empty list (as `lib/perf/stats.ts`). */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

/**
 * Heap growth and DOM drift of a soak: the last sample against the first one
 * taken at or after minute 5 (the first sample when the soak is shorter).
 */
export function soakSummary(samples) {
  if (!samples.length) return { heapRatio: NaN, domDrift: NaN };
  const base = samples.find((s) => s.minute >= 5) ?? samples[0];
  const last = samples[samples.length - 1];
  return {
    heapRatio: last.heap / base.heap,
    domDrift: (last.dom - base.dom) / base.dom,
  };
}

/**
 * Measurements → the `ui/*` result ids of the spec's budgets table. Missing
 * or non-finite measurements are left out, so the compare reports them as
 * missing instead of passing them.
 */
export function resultIds(preset, m, { churn = 0 } = {}) {
  const ids = {};
  const put = (id, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) ids[id] = value;
  };
  put(`ui/ttfr_pods_${preset}`, m.ttfr);
  put(`ui/synced_pods_${preset}`, m.synced);
  put(`ui/scroll_fps_${preset}`, m.scrollFps);
  put(`ui/scroll_p95_frame_${preset}`, m.scrollP95FrameMs);
  put(`ui/scroll_long_task_max_${preset}`, m.scrollLongTaskMax);
  put(`ui/apply_p95_${preset}_churn${churn}`, m.applyP95);
  put(`ui/map_namespace_${preset}`, m.mapNamespace);
  put(`ui/map_all_${preset}`, m.mapAll);
  put(`ui/health_scan_${preset}`, m.healthScan);
  put(`ui/health_long_task_max_${preset}`, m.healthLongTaskMax);
  put('ui/map_leave', m.mapLeave);
  put('ui/soak_heap_ratio', m.soakHeapRatio);
  put('ui/soak_dom_nodes', m.soakDomDrift);
  return ids;
}

/** Unit of a `ui/*` result id. */
export function unitFor(id) {
  if (id.startsWith('ui/scroll_fps_')) return 'fps';
  if (id === 'ui/soak_heap_ratio' || id === 'ui/soak_dom_nodes') return 'ratio';
  return 'ms';
}

/** `{ id: { value, unit } }` for the result file. */
export function withUnits(ids) {
  return Object.fromEntries(
    Object.entries(ids).map(([id, value]) => [id, { value, unit: unitFor(id) }]),
  );
}
