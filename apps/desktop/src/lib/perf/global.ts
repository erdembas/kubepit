import { perfEnabled, type PerfDriver } from './probe';

/**
 * Exposes the driver as `window.__kubepitPerf`, only while the probe is on.
 * Imported by the lazy driver chunk only, so the entry bundle carries no
 * trace of the global.
 */
export function installPerfGlobal(driver: PerfDriver): void {
  if (!perfEnabled()) return;
  window.__kubepitPerf = driver;
}
