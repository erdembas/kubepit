import * as i18n from '@/i18n';
import { useEffect, useMemo, useState } from 'react';
import { CircleDollarSign } from 'lucide-react';
import { costSourceLabel, fleetCostTotals, formatMoney } from '@/lib/cost';
import { ipc } from '@/lib/ipc';
import type { ClusterDef, ClusterId, ClusterStatus, CostSummary } from '@/types';

/** Summaries are recomputed by the backend at most every few minutes anyway. */
const REFRESH_MS = 10 * 60_000;

/**
 * Fleet total of the monthly cost of every connected cluster (7-day run
 * rate), per currency, with the source of each cluster in the tooltip.
 */
export function FleetCost({
  clusters,
  statuses,
  visible,
}: {
  clusters: readonly ClusterDef[];
  statuses: Record<ClusterId, ClusterStatus>;
  visible: boolean;
}) {
  i18n.useLocale();
  const connected = useMemo(
    () =>
      clusters
        .filter((c) => statuses[c.id]?.state === 'connected')
        .map(
          (c) => `${c.id}:${statuses[c.id]?.connected_at ?? 0}:${JSON.stringify(c.cost ?? null)}`,
        )
        .join('|'),
    [clusters, statuses],
  );
  const [summaries, setSummaries] = useState<Record<ClusterId, CostSummary>>({});

  useEffect(() => {
    if (!visible || !connected) {
      if (!connected) setSummaries({});
      return;
    }
    let cancelled = false;
    const ids = connected.split('|').map((entry) => entry.split(':')[0]!);
    const load = async () => {
      const results = await Promise.allSettled(ids.map((id) => ipc.costSummary(id)));
      if (cancelled) return;
      const next: Record<ClusterId, CostSummary> = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') next[ids[i]!] = r.value;
      });
      setSummaries(next);
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connected, visible]);

  const list = Object.values(summaries);
  if (!list.length) return null;
  const totals = fleetCostTotals(list);
  const names = new Map(clusters.map((c) => [c.id, c.name]));
  const tooltip = Object.entries(summaries)
    .map(
      ([id, s]) =>
        `${names.get(id) ?? id}: ${formatMoney(s.total, s.currency)} (${costSourceLabel(s.source)})`,
    )
    .join('\n');
  const estimated = totals.some((t) => t.estimated);

  return (
    <span
      className="text-fg-dim border-border/60 hidden items-center gap-1.5 border-l pl-4 text-[11px] tabular-nums @2xl/main:inline-flex"
      title={tooltip}
    >
      <CircleDollarSign className="h-3 w-3" />
      {i18n.t('{amount} / month', {
        amount: totals.map((t) => formatMoney(t.total, t.currency, { compact: true })).join(' + '),
      })}
      {estimated && <span className="text-fg-dim/70">{i18n.t('(includes estimates)')}</span>}
    </span>
  );
}
