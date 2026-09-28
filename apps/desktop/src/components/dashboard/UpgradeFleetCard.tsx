import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { ChevronRight, CircleArrowUp, CircleCheck, Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { openUpgradeView } from '@/components/workbench/upgrade/navigation';
import { connState } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { minorOf, nextMinor } from '@/lib/kube/deprecations';
import { countFindings } from '@/lib/kube/upgrade';
import { useVisibleStore } from '@/lib/useVisibleStore';
import { useAppStore } from '@/store/useAppStore';
import { useUpgradeStore } from '@/store/useUpgradeStore';

/**
 * Fleet summary of upgrade readiness: every connected cluster against its
 * next minor, with blockers and warnings from the last scan of this
 * session. Scans run on request ("Check all") since each one lists many
 * kinds; a row opens the cluster's Upgrade readiness view.
 */
export function UpgradeFleetCard({ visible }: { visible: boolean }) {
  i18n.useLocale();
  const clusters = useVisibleStore(useAppStore, (s) => s.clusters, visible);
  const statuses = useVisibleStore(useAppStore, (s) => s.statuses, visible);
  const entries = useVisibleStore(useUpgradeStore, (s) => s.entries, visible);

  const rows = useMemo(
    () =>
      clusters
        .filter((c) => connState(statuses[c.id]) === 'connected')
        .map((cluster) => {
          const version = statuses[cluster.id]?.version ?? null;
          const target = nextMinor(version);
          const entry = entries[`${cluster.id}|${target ?? ''}`] ?? null;
          return {
            cluster,
            current: minorOf(version),
            target,
            entry,
            counts: entry?.report ? countFindings(entry.report.findings) : null,
          };
        }),
    [clusters, statuses, entries],
  );
  if (!rows.length) return null;

  const scanning = rows.some((r) => r.entry?.scanning);
  const checked = rows.filter((r) => r.counts);
  const blocked = checked.filter((r) => r.counts!.blocker > 0).length;
  const checkAll = () =>
    void useUpgradeStore
      .getState()
      .scanFleet(rows.filter((r) => !r.entry?.scanning).map((r) => r.cluster.id));

  return (
    <section className="glass flex flex-col gap-3 px-5 py-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-fg-dim flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.18em] uppercase">
          <CircleArrowUp className="h-3.5 w-3.5" />
          {i18n.t('Upgrade readiness')}
        </span>
        <span className="text-fg-muted text-[11.5px] tabular-nums">
          {checked.length
            ? i18n.t(
                '{blocked} of {checked} checked clusters have blockers for their next version',
                {
                  blocked,
                  checked: checked.length,
                },
              )
            : i18n.t('Deprecated and removed APIs each cluster uses for its next version')}
        </span>
        <Button
          size="xs"
          variant="secondary"
          className="ml-auto"
          disabled={scanning}
          leftIcon={
            scanning ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CircleArrowUp className="h-3 w-3" />
            )
          }
          onClick={checkAll}
        >
          {checked.length ? i18n.t('Check again') : i18n.t('Check all')}
        </Button>
      </header>
      <ul className="grid grid-cols-1 gap-1 @2xl/main:grid-cols-2">
        {rows.map(({ cluster, current, target, entry, counts }) => (
          <li key={cluster.id}>
            <button
              type="button"
              onClick={() => openUpgradeView(cluster.id)}
              className="hover:bg-fg/4 group flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
            >
              <span className="text-fg min-w-0 flex-1 truncate text-[12px] font-medium">
                {cluster.name}
              </span>
              <span className="text-fg-dim shrink-0 font-mono text-[11px] tabular-nums">
                {current ?? '—'} → {target ?? '—'}
              </span>
              <span className="flex w-40 shrink-0 items-center justify-end gap-1.5 text-[11px] tabular-nums">
                {entry?.scanning ? (
                  <span className="text-fg-dim flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {i18n.t('Scanning')}
                  </span>
                ) : entry?.error ? (
                  <span className="text-status-error flex items-center gap-1" title={entry.error}>
                    <TriangleAlert className="h-3 w-3" />
                    {i18n.t('Scan failed')}
                  </span>
                ) : counts ? (
                  counts.blocker + counts.warning === 0 ? (
                    <span className="text-status-running flex items-center gap-1">
                      <CircleCheck className="h-3 w-3" />
                      {i18n.t('Ready')}
                    </span>
                  ) : (
                    <>
                      <span
                        className={cn(
                          counts.blocker ? 'text-status-error font-semibold' : 'text-fg-dim',
                        )}
                      >
                        {i18n.plural('{count} blocker', '{count} blockers', counts.blocker)}
                      </span>
                      <span className="text-fg-dim/50">·</span>
                      <span className={counts.warning ? 'text-status-starting' : 'text-fg-dim'}>
                        {i18n.plural('{count} warning', '{count} warnings', counts.warning)}
                      </span>
                    </>
                  )
                ) : (
                  <span className="text-fg-dim">{i18n.t('Not checked')}</span>
                )}
              </span>
              <ChevronRight className="text-fg-dim/0 group-hover:text-fg-dim h-3.5 w-3.5 shrink-0" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
