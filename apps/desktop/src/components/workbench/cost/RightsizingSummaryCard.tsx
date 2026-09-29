import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import type { ReactNode } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { formatMoney } from '@/lib/cost';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { VIEW_KEYS } from '@/lib/kube/nav';
import { runErrorText, runTime, scanSourceLabel } from '@/lib/kube/recommendations/model';
import { reportDays, rightsizingTotals } from '@/lib/kube/rightsizing/model';
import { useLatestRecommendations } from '@/store/useRecommendationsStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ClusterId } from '@/types';
import { Card } from '../overview/charts';
import { useNow } from '../util';

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">{label}</p>
      <p
        className={cn(
          'mt-1.5 text-[22px] leading-none font-semibold tracking-tight tabular-nums',
          tone ?? 'text-fg',
        )}
      >
        {value}
      </p>
      <p className="text-fg-dim mt-1.5 text-[11px]">{sub}</p>
    </div>
  );
}

/**
 * The Cost view's right-sizing tab: the latest stored scan's potential
 * saving, over- and under-provisioned counts and age, and the way to the
 * Recommendations view.
 */
export function RightsizingSummaryCard({
  clusterId,
  enabled = true,
}: {
  clusterId: ClusterId;
  enabled?: boolean;
}) {
  i18n.useLocale();
  const { report, run, latest, loading, error } = useLatestRecommendations(clusterId, enabled);
  const now = useNow(60_000, enabled);
  const totals = useMemo(() => (report ? rightsizingTotals(report.workloads) : null), [report]);
  const open = () =>
    useWorkbenchStore.getState().setActiveKind(clusterId, VIEW_KEYS.recommendations);

  let body: ReactNode;
  if (report && totals && run) {
    body = (
      <>
        <div className="grid gap-3 px-4 py-3 @md:grid-cols-3 @md:gap-4">
          <Metric
            label={i18n.t('Potential saving')}
            value={formatMoney(totals.savings, report.currency, { compact: true })}
            tone={totals.savings > 0 ? 'text-status-running' : undefined}
            sub={i18n.t('per month')}
          />
          <Metric
            label={i18n.t('Over-provisioned')}
            value={i18n.number(totals.over)}
            sub={i18n.plural(
              '{count} workload checked',
              '{count} workloads checked',
              totals.workloads,
            )}
          />
          <Metric
            label={i18n.t('Under-provisioned')}
            value={i18n.number(totals.under)}
            tone={totals.under > 0 ? 'text-status-starting' : undefined}
            sub={i18n.t('usage above requests')}
          />
        </div>
        <p className="text-fg-dim border-border/60 flex flex-wrap gap-x-2 border-t px-4 py-2 text-[11px]">
          <span>{i18n.t('Scanned {age} ago', { age: formatAge(runTime(run), now) })}</span>
          <span aria-hidden="true">·</span>
          <span>{scanSourceLabel(report.source, reportDays(report))}</span>
          {latest?.last_failure && (
            <span className="text-status-error min-w-0 break-words">
              {i18n.t('The last scan failed: {error}', {
                error: runErrorText(latest.last_failure.error),
              })}
            </span>
          )}
        </p>
      </>
    );
  } else if (!latest) {
    body = (
      <div className="text-fg-muted flex items-center gap-2 px-4 py-4 text-[12px]">
        {error ? (
          <span className="text-status-error break-words">{error}</span>
        ) : (
          loading && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {i18n.t('Loading recommendations…')}
            </>
          )
        )}
      </div>
    );
  } else {
    body = (
      <p className="text-fg-muted px-4 py-4 text-[12px]">
        {latest.source_changed
          ? i18n.t(
              'The Prometheus configuration changed after the last scan. Scan again in the Recommendations view.',
            )
          : i18n.t(
              'No scan yet. Scans read days of usage history and recommend requests and limits for every workload.',
            )}
      </p>
    );
  }

  return (
    <Card
      title={i18n.t('Right-sizing')}
      icon={<Sparkles />}
      actions={
        <button type="button" onClick={open} className="text-fg-dim hover:text-accent text-[11px]">
          {i18n.t('Open recommendations')}
        </button>
      }
    >
      {body}
    </Card>
  );
}
