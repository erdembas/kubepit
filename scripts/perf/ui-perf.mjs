#!/usr/bin/env node
// UI performance driver: runs scenarios in Chromium (Playwright) against
// `vite preview` of the production build, with the in-memory demo backend
// (`?perf=1&scale=<preset>&churn=<n>`) and the in-app probe
// (`window.__kubepitPerf`, apps/desktop/src/lib/perf). It never talks to a
// real cluster: every request outside the preview server is blocked, and it
// refuses to run in a Tauri page.
//
//   pnpm --filter @kubepit/desktop build
//   pnpm exec playwright install chromium
//   pnpm perf:ui -- --preset s --scenarios ttfr,scroll
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appUrl,
  isAllowedUrl,
  parseArgs,
  percentile,
  resultIds,
  soakSummary,
  USAGE,
  withUnits,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DESKTOP = path.join(ROOT, 'apps/desktop');
const VITE = path.join(DESKTOP, 'node_modules/vite/bin/vite.js');

const APPLY_SECONDS = 20;
const SCROLL_MS = 5000;
const SOAK_VIEWS = ['pods', '@resource-map', '@health'];

const log = (...args) => console.log('[perf:ui]', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const max = (values) => (values.length ? Math.max(...values) : 0);

async function startPreview(port) {
  if (!existsSync(path.join(DESKTOP, 'dist/index.html')))
    throw new Error('No production build: run `pnpm --filter @kubepit/desktop build` first.');
  const server = spawn(
    process.execPath,
    [VITE, 'preview', '--port', String(port), '--strictPort', '--host', 'localhost'],
    { cwd: DESKTOP, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  server.stdout.on('data', (d) => (output += d));
  server.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => server.once('exit', resolve));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`vite preview exited:\n${output}`);
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      server.kill();
      throw new Error(`vite preview did not start on port ${port}:\n${output}`);
    }
    await sleep(200);
  }
  return {
    async stop() {
      if (server.exitCode === null) server.kill();
      await exited;
    },
  };
}

/** A new page on the demo UI, connected to `c-scale-<preset>`. */
async function openApp(context, options) {
  const page = await context.newPage();
  page.on('pageerror', (error) => log('page error:', error.message));
  const url = appUrl(options.port, options);
  await page.goto(url, { waitUntil: 'load' });
  if (!page.url().startsWith(`http://localhost:${options.port}/`))
    throw new Error(`Refusing to run: the page left the preview server (${page.url()})`);
  if (await page.evaluate(() => '__TAURI_INTERNALS__' in window))
    throw new Error('Refusing to run in a Tauri page: the driver only measures the demo backend.');
  await page.waitForFunction(() => !!window.__kubepitPerf, null, { timeout: 30_000 });
  const connectMs = await page.evaluate(
    (cluster) => window.__kubepitPerf.connect(cluster),
    cluster(options),
  );
  return { page, connectMs };
}

const cluster = (options) => `c-scale-${options.preset}`;

/** Opens the pods table (all namespaces) and waits for its first rows and for synced. */
function openPods(page, options) {
  return page.evaluate(async (id) => {
    const perf = window.__kubepitPerf;
    perf.reset();
    perf.openKind(id, 'pods', []);
    const ttfr = await perf.waitFor('table:ttfr', { timeoutMs: 120_000 });
    const synced = await perf.waitFor('table:synced', { timeoutMs: 120_000 });
    return { ttfr, synced, rows: perf.watchStats().find((w) => w.key.includes('|pods|'))?.items };
  }, cluster(options));
}

/** Opens a view scoped to `namespaces`: ms until two frames after `ready` is recorded. */
function openViewUntil(page, options, view, namespaces, ready) {
  return page.evaluate(
    async ({ id, view, namespaces, ready }) => {
      const perf = window.__kubepitPerf;
      perf.reset();
      const start = perf.now();
      perf.openView(id, view, namespaces);
      const value = await perf.waitFor(ready.id, { meta: ready.meta, timeoutMs: 300_000 });
      if (value === null) throw new Error(`perf: ${ready.id} was not recorded`);
      const end = await perf.afterFrames(2);
      const { durations } = perf.report();
      return { ms: end - start, value, durations, longTasks: perf.longTasks() };
    },
    { id: cluster(options), view, namespaces, ready },
  );
}

const MAP_SYNCED = { id: 'map:view', meta: { synced: 1 } };

const SCENARIOS = {
  async ttfr(ctx) {
    const { page, connectMs } = await ctx.open();
    const r = await openPods(page, ctx.options);
    await page.close();
    ctx.raw.ttfr = { ...r, connectMs };
    return { ttfr: r.ttfr, synced: r.synced };
  },

  async scroll(ctx) {
    const { page } = await ctx.open();
    await openPods(page, ctx.options);
    const r = await page.evaluate(async (ms) => {
      await window.__kubepitPerf.afterFrames(10);
      return window.__kubepitPerf.scrollTable(ms);
    }, SCROLL_MS);
    await page.close();
    ctx.raw.scroll = r;
    return {
      scrollFps: r.medianFps,
      scrollP95FrameMs: r.p95FrameMs,
      scrollLongTaskMax: max(r.longTasks),
    };
  },

  async apply(ctx) {
    if (!ctx.options.churn) {
      log('apply: skipped (needs --churn > 0)');
      return {};
    }
    const { page } = await ctx.open();
    await openPods(page, ctx.options);
    await page.evaluate(() => window.__kubepitPerf.reset());
    await sleep(APPLY_SECONDS * 1000);
    const { durations, details } = await page.evaluate(() => window.__kubepitPerf.report());
    await page.close();
    const apply = durations['watch:apply'] ?? [];
    const flush = (details['watch:apply'] ?? []).map((d) => d?.flushMs ?? 0);
    ctx.raw.apply = {
      seconds: APPLY_SECONDS,
      batches: apply.length,
      p50: percentile(apply, 50),
      p95: percentile(apply, 95),
      max: max(apply),
      flushP95: percentile(flush, 95),
    };
    return { applyP95: percentile(apply, 95) };
  },

  async map(ctx) {
    const out = {};
    {
      const { page } = await ctx.open();
      const r = await openViewUntil(page, ctx.options, '@resource-map', ['ns-0001'], MAP_SYNCED);
      await page.close();
      ctx.raw.mapNamespace = summarizeMap(r);
      out.mapNamespace = r.ms;
    }
    // All namespaces on `s` and `m` (the budget is `ui/map_all_m`); at `l` the
    // map takes tens of seconds to sync, and only `leave` opens it.
    if (ctx.options.preset !== 'l') {
      const { page } = await ctx.open();
      const r = await openViewUntil(page, ctx.options, '@resource-map', [], MAP_SYNCED);
      await page.close();
      ctx.raw.mapAll = summarizeMap(r);
      out.mapAll = r.ms;
    }
    return out;
  },

  async health(ctx) {
    const { page } = await ctx.open();
    const r = await openViewUntil(page, ctx.options, '@health', [], { id: 'health:scan' });
    await page.close();
    ctx.raw.health = { openMs: r.ms, scanMs: r.value, longTasks: r.longTasks };
    return { healthScan: r.value, healthLongTaskMax: max(r.longTasks) };
  },

  /** The synced all-namespaces map → the overview. */
  async leave(ctx) {
    const { page } = await ctx.open();
    const map = await openViewUntil(page, ctx.options, '@resource-map', [], MAP_SYNCED);
    const r = await page.evaluate(async () => {
      const perf = window.__kubepitPerf;
      await perf.afterFrames(10);
      perf.reset();
      const ms = await perf.switchView('@overview');
      return { ms, longTasks: perf.longTasks() };
    });
    await page.close();
    ctx.raw.leave = { ...r, mapOpenMs: map.ms };
    return { mapLeave: r.ms };
  },
};

function summarizeMap(r) {
  const last = (id) => r.durations[id]?.at(-1) ?? null;
  const total = (id) => (r.durations[id] ?? []).reduce((a, b) => a + b, 0);
  return {
    ms: r.ms,
    builds: r.durations['map:build']?.length ?? 0,
    buildTotalMs: total('map:build'),
    lastBuildMs: last('map:build'),
    lastViewMs: last('map:view'),
    lastLayoutMs: last('map:layout'),
    longTaskMax: max(r.longTasks),
  };
}

/** Cycles the pods table, the map and the health view every minute; samples heap and DOM after GC. */
async function soak(ctx, minutes) {
  const { page } = await ctx.open();
  const id = cluster(ctx.options);
  const samples = [];
  const start = Date.now();
  for (let minute = 1; minute <= minutes; minute++) {
    const view = SOAK_VIEWS[(minute - 1) % SOAK_VIEWS.length];
    await page.evaluate(
      ({ id, view }) => {
        const perf = window.__kubepitPerf;
        // Keeps the probe's own samples from growing the heap.
        perf.reset();
        if (view === 'pods') perf.openKind(id, view, []);
        else perf.openView(id, view, []);
      },
      { id, view },
    );
    await sleep(Math.max(0, start + minute * 60_000 - Date.now()));
    const sample = await page.evaluate(async () => {
      const perf = window.__kubepitPerf;
      for (let i = 0; i < 3; i++) {
        window.gc?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { heap: perf.heap(), dom: perf.domNodes(), gc: typeof window.gc === 'function' };
    });
    if (!sample.gc && minute === 1) log('soak: window.gc is missing, heap samples include garbage');
    samples.push({ minute, view, ...sample });
    log(
      `soak ${minute}/${minutes} min: heap ${(sample.heap / 2 ** 20).toFixed(1)} MiB, ${sample.dom} DOM nodes (${view})`,
    );
  }
  await page.close();
  const summary = soakSummary(samples);
  ctx.raw.soak = { samples, ...summary };
  return { soakHeapRatio: summary.heapRatio, soakDomDrift: summary.domDrift };
}

function printResults(results) {
  const rows = Object.entries(results).map(([id, { value, unit }]) => [
    id,
    `${Number.isInteger(value) ? value : value.toFixed(unit === 'ratio' ? 3 : 1)} ${unit}`,
  ]);
  const width = Math.max(0, ...rows.map(([id]) => id.length));
  for (const [id, value] of rows) console.log(`  ${id.padEnd(width)}  ${value}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const { chromium } = await import('playwright');
  log(
    `preset ${options.preset}, churn ${options.churn}/s, scenarios ${options.scenarios.join(',')}${options.soak ? `, soak ${options.soak} min` : ''}`,
  );
  const server = await startPreview(options.port);
  let browser;
  try {
    browser = await chromium.launch({
      headless: !options.headed,
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
    });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    // Nothing leaves the preview server (no fonts, no telemetry, no cluster).
    await context.route('**/*', (route) =>
      isAllowedUrl(route.request().url(), options.port) ? route.continue() : route.abort(),
    );
    const ctx = { options, raw: {}, open: () => openApp(context, options) };
    const measurements = {};
    for (const name of options.scenarios) {
      log(`${name}…`);
      const started = Date.now();
      Object.assign(measurements, await SCENARIOS[name](ctx));
      log(`${name} done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    if (options.soak > 0) Object.assign(measurements, await soak(ctx, options.soak));

    const results = withUnits(resultIds(options.preset, measurements, { churn: options.churn }));
    const out = path.resolve(ROOT, options.out);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(
      out,
      `${JSON.stringify(
        {
          meta: {
            preset: options.preset,
            churn: options.churn,
            scenarios: options.scenarios,
            soakMinutes: options.soak,
            date: new Date().toISOString(),
            browser: `chromium ${browser.version()}`,
            node: process.version,
            platform: `${process.platform}-${process.arch}`,
          },
          results,
          raw: { measurements, ...ctx.raw },
        },
        null,
        2,
      )}\n`,
    );
    log(`results → ${path.relative(ROOT, out)}`);
    printResults(results);
  } finally {
    await browser?.close();
    await server.stop();
  }
}

main().catch((error) => {
  console.error(`[perf:ui] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
