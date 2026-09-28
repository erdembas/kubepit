import * as i18n from '@/i18n/core';
import type { CostPlatform, CostPricing, CostService, CostSourceKind, CostSummary } from '@/types';

/**
 * Cost insight helpers shared by the dashboard, the cluster editor and the
 * workbench: money formatting in the UI locale, source and platform names,
 * price-model text and fleet totals per currency. Pure.
 */

/** Currency with the UI locale's grouping; falls back to `12.34 XYZ` for unknown codes. */
export function formatMoney(
  value: number,
  currency: string,
  { compact = false, cents }: { compact?: boolean; cents?: boolean } = {},
): string {
  const amount = Number.isFinite(value) ? value : 0;
  const fraction = cents ?? Math.abs(amount) < 100;
  try {
    return i18n.number(amount, {
      style: 'currency',
      currency,
      notation: compact && Math.abs(amount) >= 10_000 ? 'compact' : 'standard',
      minimumFractionDigits: fraction ? 2 : 0,
      maximumFractionDigits: fraction ? 2 : compact ? 1 : 0,
    });
  } catch {
    const text = i18n.number(amount, { maximumFractionDigits: fraction ? 2 : 0 });
    return `${text} ${currency}`;
  }
}

/** Unit prices keep up to four decimals (`$0.0316`). */
export function formatUnitPrice(value: number, currency: string): string {
  try {
    return i18n.number(value, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  } catch {
    return `${i18n.number(value, { maximumFractionDigits: 4 })} ${currency}`;
  }
}

/** A monthly amount with its period, e.g. "$1,234 / month". */
export function perMonth(value: number, currency: string, compact = false): string {
  return i18n.t('{amount} / month', { amount: formatMoney(value, currency, { compact }) });
}

/** Product names stay as they are; estimates say what they are based on. */
export function costSourceLabel(kind: CostSourceKind): string {
  switch (kind) {
    case 'opencost':
      return 'OpenCost';
    case 'kubecost':
      return 'Kubecost';
    default:
      return i18n.t('Estimate from requests');
  }
}

export function costPlatformLabel(platform: CostPlatform): string {
  switch (platform) {
    case 'eks':
      return 'EKS';
    case 'gke':
      return 'GKE';
    case 'aks':
      return 'AKS';
    default:
      return i18n.t('Generic / on-prem');
  }
}

export function costServiceLabel(service: CostService): string {
  return `${service.namespace}/${service.service}:${service.port}`;
}

/** "$0.0316 per vCPU-hour · $0.0042 per GiB-hour" (+ GPU, storage, discount). */
export function pricingSummary(pricing: CostPricing): string[] {
  const price = (v: number) => formatUnitPrice(v, pricing.currency);
  const parts = [
    i18n.t('{price} per vCPU-hour', { price: price(pricing.cpu_hour) }),
    i18n.t('{price} per GiB-hour', { price: price(pricing.memory_gib_hour) }),
  ];
  if (pricing.gpu_hour != null)
    parts.push(i18n.t('{price} per GPU-hour', { price: price(pricing.gpu_hour) }));
  if (pricing.storage_gib_month != null)
    parts.push(
      i18n.t('{price} per GiB-month of volumes', { price: price(pricing.storage_gib_month) }),
    );
  if (pricing.discount_percent > 0)
    parts.push(
      i18n.t('{percent} discount', {
        percent: i18n.number(pricing.discount_percent / 100, {
          style: 'percent',
          maximumFractionDigits: 1,
        }),
      }),
    );
  return parts;
}

export interface CurrencyTotal {
  currency: string;
  total: number;
  idle: number;
  clusters: number;
  /** At least one cluster's number is an estimate. */
  estimated: boolean;
}

/** Monthly totals per currency, largest first (clusters rarely share one). */
export function fleetCostTotals(summaries: readonly CostSummary[]): CurrencyTotal[] {
  const by = new Map<string, CurrencyTotal>();
  for (const s of summaries) {
    const entry = by.get(s.currency) ?? {
      currency: s.currency,
      total: 0,
      idle: 0,
      clusters: 0,
      estimated: false,
    };
    entry.total += s.total;
    entry.idle += s.idle ?? 0;
    entry.clusters += 1;
    entry.estimated ||= s.source === 'estimate';
    by.set(s.currency, entry);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

/** Efficiency as a percentage (usage ÷ requests). */
export function formatEfficiency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return i18n.number(value, { style: 'percent', maximumFractionDigits: 0 });
}
