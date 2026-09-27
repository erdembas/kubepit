import * as i18n from '@/i18n';
import { useState } from 'react';
import { HeartPulse, Play } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SEVERITIES, ruleTitle, severityLabel } from '@/lib/kube/health';
import { cn } from '@/lib/cn';
import { VIEW, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';
import { Card } from '../overview/charts';
import { ScoreRing } from './ScoreRing';
import { SEVERITY_ICON, SEVERITY_TEXT } from './severity';
import { useHealthScan } from './useHealthScan';

/** Clusters above this size scan only on request from the overview (the view always scans). */
const AUTO_SCAN_MAX_PODS = 1_500;
const requested = new Set<string>();

/** Compact cluster-wide health summary for the cluster overview, linking to the health view. */
export function HealthSummaryCard({
  clusterId,
  isActive,
  apiResources,
  podCount,
}: {
  clusterId: string;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
  podCount: number;
}) {
  i18n.useLocale();
  const [, rerender] = useState(0);
  const auto = podCount <= AUTO_SCAN_MAX_PODS || requested.has(clusterId);
  const health = useHealthScan(clusterId, [], isActive && auto, apiResources);
  const { summary } = health;
  const open = () => useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.clusterHealth);
  const top = summary?.groups.slice(0, 4) ?? [];

  return (
    <Card
      title={i18n.t('Health')}
      icon={<HeartPulse />}
      actions={
        <button type="button" onClick={open} className="text-fg-dim hover:text-accent text-[11px]">
          {i18n.t('Open health checks')}
        </button>
      }
    >
      {!auto && !summary ? (
        <div className="flex items-center gap-4 p-4">
          <p className="text-fg-muted min-w-0 flex-1 text-[12px]">
            {i18n.t('Large cluster: health checks run on request to keep the overview fast.')}
          </p>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Play className="h-3.5 w-3.5" />}
            onClick={() => {
              requested.add(clusterId);
              rerender((n) => n + 1);
            }}
          >
            {i18n.t('Run checks')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
          <ScoreRing
            score={summary?.score ?? null}
            grade={summary?.grade ?? null}
            size={84}
            stroke={8}
            loading={!summary}
          />
          <div className="flex gap-5">
            {SEVERITIES.map((s) => {
              const Icon = SEVERITY_ICON[s];
              const n = summary?.counts[s] ?? 0;
              return (
                <div key={s} className="flex flex-col">
                  <span className="text-fg-dim flex items-center gap-1 text-[10.5px] font-semibold tracking-[0.12em] uppercase">
                    <Icon className={cn('h-3 w-3', SEVERITY_TEXT[s])} />
                    {severityLabel(s)}
                  </span>
                  <span
                    className={cn(
                      'mt-1 text-[20px] leading-none font-semibold tabular-nums',
                      n > 0 ? SEVERITY_TEXT[s] : 'text-fg',
                    )}
                  >
                    {summary ? n : '—'}
                  </span>
                </div>
              );
            })}
          </div>
          <ul className="min-w-[220px] flex-1 space-y-1">
            {!summary ? (
              <li className="text-fg-dim text-[11.5px]">
                {i18n.t('Reading {loaded} of {total} resource lists…', {
                  loaded: health.progress.loaded,
                  total: health.progress.total,
                })}
              </li>
            ) : !top.length ? (
              <li className="text-fg-dim text-[11.5px]">
                {i18n.t('No findings. Every check passes.')}
              </li>
            ) : (
              top.map((g) => {
                const Icon = SEVERITY_ICON[g.severity];
                return (
                  <li key={g.ruleId}>
                    <button
                      type="button"
                      onClick={open}
                      className="hover:bg-fg/4 -mx-1.5 flex w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-[11.5px]"
                    >
                      <Icon className={cn('h-3 w-3 shrink-0', SEVERITY_TEXT[g.severity])} />
                      <span className="text-fg-muted min-w-0 flex-1 truncate">
                        {ruleTitle(g.ruleId)}
                      </span>
                      <span className="text-fg shrink-0 tabular-nums">{g.total}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </Card>
  );
}
