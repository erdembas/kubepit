import * as i18n from '@/i18n/core';

/** Binary prefixes, matching what `kubectl top` and cluster dashboards report. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exp = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 1024 ** exp;
  const formatted =
    value >= 10 || exp === 0
      ? i18n.number(Math.round(value))
      : i18n.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${formatted} ${units[exp]}`;
}

export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent < 0) return '0%';
  if (percent >= 10) return `${i18n.number(Math.round(percent))}%`;
  return `${i18n.number(percent, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** CPU like `kubectl top`: millicores below one core (`250m`), cores above (`1.5`, `160`). */
export function formatCpu(millicores: number): string {
  if (!Number.isFinite(millicores) || millicores <= 0) return '0';
  if (millicores < 1000) return `${Math.round(millicores)}m`;
  const cores = millicores / 1000;
  return i18n.number(cores, { maximumFractionDigits: cores < 10 ? 2 : cores < 100 ? 1 : 0 });
}

/** Kubernetes-style age: 45s, 12m, 3h, 5d, 2y — like `kubectl get`. */
export function formatAge(timestamp: string | number | null | undefined, now = Date.now()): string {
  if (timestamp == null || timestamp === '') return '—';
  const then = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(then)) return '—';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 10 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 365) return h % 24 && d < 10 ? `${d}d${h % 24}h` : `${d}d`;
  const y = Math.floor(d / 365);
  return `${y}y`;
}
