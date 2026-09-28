import * as i18n from '@/i18n/core';
import type { CostPlatform, CostPricing, CostService, CostSourceKind, CostSummary } from '@/types';

/**
 * Cost insight helpers shared by the dashboard, the cluster editor and the
 * workbench: money formatting in the UI locale, source and platform names,
 * price-model text and fleet totals per currency. Pure.
 */

/**
 * The one money format of the cost view, overview card, dashboard and
 * right-sizing, in the UI locale: rounded to cents first, two decimals below
 * 1,000 and none from there (`$12.40`, `$7,969`). `compact` switches to
 * compact notation from one million only (`$1.2M`); `signed` prefixes
 * non-zero deltas with `+` / `-`. Non-finite values count as 0; unknown
 * currency codes fall back to `12.40 XYZ` with the same fraction rule.
 */
export function formatMoney(
  value: number,
  currency: string,
  { compact = false, signed = false }: { compact?: boolean; signed?: boolean } = {},
): string {
  const amount = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  const decimals = Math.abs(amount) < 1000 ? 2 : 0;
  const short = compact && Math.abs(amount) >= 1_000_000;
  const digits: Intl.NumberFormatOptions = short
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { notation: 'standard', minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  const signDisplay = signed ? 'exceptZero' : 'auto';
  try {
    return i18n.number(amount, { style: 'currency', currency, signDisplay, ...digits });
  } catch {
    return `${i18n.number(amount, { signDisplay, ...digits })} ${currency}`;
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
