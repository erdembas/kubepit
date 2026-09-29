import * as i18n from '@/i18n';
import { useLocaleMemo } from '@/i18n';
import { useCallback, useMemo, useState } from 'react';
import { ArrowUpRight, Check, Loader2, Lock, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@/lib/cost';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { ipc } from '@/lib/ipc';
import {
  applyMode,
  runTime,
  workloadKey,
  type RightsizingOrigin,
} from '@/lib/kube/recommendations/model';
import {
  confidenceLabel,
  coverageLabel,
  cpuText,
  isRightsizable,
  memoryText,
  reportDays,
  sourceLabel,
  verdictLabel,
} from '@/lib/kube/rightsizing/model';
import { useAppStore } from '@/store/useAppStore';
import { useRecommendationsStore } from '@/store/useRecommendationsStore';
import type {
  ClusterDef,
  ClusterId,
  RecommendationRun,
  RecommendationTrendPoint,
  RightsizingReport,
  WorkloadRecommendation,
} from '@/types';
import { useActionGate } from '../access/gates';
import { usePolled } from '../data/polled';
import { MiniTable, Section } from '../details/primitives';
import type { SectionProps } from '../details/sections/types';
import { Sparkline } from '../overview/TimeSeriesChart';
import { FlagChip } from '../recommendations/RecommendationRow';
import {
  drawerAction,
  trendInterval,
  trendKey,
  trendRange,
  trendTotals,
} from '../recommendations/drawerModel';
import { rowFlags } from '../recommendations/listModel';
import { openRecommendationsView } from '../recommendations/navigation';
import { rightsizeAction, useApplying, useQuickApply } from '../recommendations/quickApply';
import { useNow } from '../util';
import { ChangeCell, RaisedTag, RightsizingDialog } from './RightsizingDialog';
import { CONFIDENCE_TONE, VERDICT_TONE } from './tones';
import { useStoredOrLiveRightsizing } from './useCost';

/**
 * Right-sizing of one workload in its details panel (spec §9.2): the
 * latest stored scan's row when there is one, else the live report; the
 * flags, the recommended requests across stored scans, "Apply" (one-click)
 * or "Review & apply", and the way to the Recommendations view. Applying
 * follows the Recommendations list: `applyMode`, the RBAC gate, the
 * connection, `quickApply` and the audited `RightsizingDialog`.
 */

const NO_NAMESPACES: readonly string[] = [];
const NO_TREND: RecommendationTrendPoint[] = [];
/** Until the cluster is known, nothing is one-click (like the list). */
const UNKNOWN_CLUSTER: Pick<ClusterDef, 'read_only' | 'environment'> = {
  read_only: false,
  environment: 'production',
};

/** One sparkline: the resource, the latest recommended request, the trend. */
function Spark({
  label,
  value,
  ariaLabel,
  points,
  from,
  to,
  intervalMs,
}: {
  label: string;
  value: string;
  ariaLabel: string;
  points: ReturnType<typeof trendTotals>;
  from: number;
  to: number;
  intervalMs: number;
}) {
  return (
    <div className="min-w-0">
      <p className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]">
        <span className="text-fg-dim truncate">{label}</span>
        <span className="text-fg-muted shrink-0 tabular-nums">{value}</span>
      </p>
      <Sparkline
        points={points}
        from={from}
        to={to}
        intervalMs={intervalMs}
        label={ariaLabel}
        className="mt-1"
      />
    </div>
  );
}

/**
 * The workload's recommended CPU and memory requests across the stored
 * scans (`recommendations_trend`, shared with the drawer's History tab);
 * nothing until two scans have a value.
 */
function RecommendationSparklines({
  clusterId,
  rec,
  run,
  enabled,
}: {
  clusterId: ClusterId;
  rec: WorkloadRecommendation;
  run: RecommendationRun;
  enabled: boolean;
}) {
  i18n.useLocale();
  const trend = usePolled<RecommendationTrendPoint[]>(
    trendKey(clusterId, rec, null, run.id),
    () =>
      ipc.recommendationsTrend(clusterId, {
        kind: rec.kind,
        namespace: rec.namespace,
        name: rec.name,
      }),
    null,
    enabled,
  );
  const points = trend.data ?? NO_TREND;
  const cpu = useMemo(() => trendTotals(points, 'cpu'), [points]);
  const memory = useMemo(() => trendTotals(points, 'memory'), [points]);
  if (cpu.length < 2 && memory.length < 2) return null;
  const { from, to } = trendRange(points);
  const intervalMs = trendInterval(points);
  const last = (series: typeof cpu) => series[series.length - 1]?.v ?? null;
  return (
    <div>
      <p className="text-fg-dim mb-1 text-[10px] font-semibold tracking-[0.1em] uppercase">
        {i18n.t('Recommended requests across scans')}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Spark
          label={i18n.t('CPU')}
          value={cpuText(last(cpu))}
          ariaLabel={i18n.t('Recommended CPU request across scans')}
          points={cpu}
          from={from}
          to={to}
          intervalMs={intervalMs}
        />
        <Spark
          label={i18n.t('Memory')}
          value={memoryText(last(memory))}
          ariaLabel={i18n.t('Recommended memory request across scans')}
          points={memory}
          from={from}
          to={to}
          intervalMs={intervalMs}
        />
      </div>
    </div>
  );
}

/** "Apply" (one-click) or "Review & apply" / "Review", gated like the list's rows. */
function ApplyButton({
  clusterId,
  rec,
  onApply,
  onReview,
}: {
  clusterId: ClusterId;
  rec: WorkloadRecommendation;
  onApply: (rec: WorkloadRecommendation) => void;
  onReview: (rec: WorkloadRecommendation) => void;
}) {
  i18n.useLocale();
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const connected = useAppStore((s) => s.statuses[clusterId]?.state === 'connected');
  const mode = applyMode(rec, cluster ?? UNKNOWN_CLUSTER);
  const gate = useActionGate(
    clusterId,
    useMemo(
      () => (mode === 'one-click' || mode === 'review' ? rightsizeAction(rec) : null),
      [mode, rec],
    ),
    !!cluster?.read_only,
  );
  const blocked = mode !== 'read-only' && gate.reason === 'permission' ? gate.message : null;
  const action = drawerAction(mode, { past: false, connected, blocked });
  const applying = useApplying(clusterId, workloadKey(rec));
  if (action.kind === 'none') return null;
  return (
    <span
      className="shrink-0"
      title={
        action.disabled ??
        (applying
          ? i18n.t('Applying…')
          : mode === 'read-only'
            ? i18n.t(
                'This cluster is read-only: you can review the change, but it cannot be applied.',
              )
            : undefined)
      }
    >
      <Button
        size="xs"
        variant="secondary"
        disabled={!!action.disabled || applying}
        aria-busy={applying || undefined}
        leftIcon={
          applying ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : blocked ? (
            <Lock className="h-3 w-3" />
          ) : action.kind === 'apply' ? (
            <Zap className="text-accent h-3 w-3" />
          ) : undefined
        }
        onClick={() => {
          if (applying) return;
          if (action.kind === 'apply') onApply(rec);
          else onReview(rec);
        }}
      >
        {action.label}
      </Button>
    </span>
  );
}

/**
 * The row: where it comes from ("From the scan {age} ago" for a stored
 * one), its flags, the changes per container, the trend across stored
 * scans, the monthly change and the actions.
 */
export function RecommendationBody({
  clusterId,
  rec,
  report,
  origin,
  run,
  isActive,
}: {
  clusterId: ClusterId;
  rec: WorkloadRecommendation;
  report: RightsizingReport;
  origin: RightsizingOrigin;
  run: RecommendationRun | null;
  isActive: boolean;
}) {
  i18n.useLocale();
  const key = workloadKey(rec);
  const stored = origin === 'stored' && run != null;
  const now = useNow(60_000, isActive && stored);
  const flags = useLocaleMemo(() => rowFlags(rec), [rec]);
  const connected = useAppStore((s) => s.statuses[clusterId]?.state === 'connected');
  // Applied from a stored row: shown until a later scan reflects it (a live report follows at once).
  const applied =
    useRecommendationsStore((s) => s.byCluster[clusterId]?.applied[key] != null) && stored;
  // The dialog reviews the recommendation as it was when opened, not the next poll or scan.
  const [reviewing, setReviewing] = useState<WorkloadRecommendation | null>(null);
  const review = useCallback((r: WorkloadRecommendation) => setReviewing(r), []);
  const apply = useQuickApply(clusterId, { past: false, connected }, review);
  const meta = [
    stored ? i18n.t('From the scan {age} ago', { age: formatAge(runTime(run), now) }) : null,
    sourceLabel(report.source, reportDays(report)),
    rec.coverage_hours > 0
      ? i18n.t('{duration} of history', { duration: coverageLabel(rec.coverage_hours) })
      : null,
  ].filter((s): s is string => !!s);

  return (
    <div className="space-y-2.5">
      <p className="text-fg-dim text-[11px]">{meta.join(' · ')}</p>
      {flags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {flags.map((f) => (
            <FlagChip key={f.code} flag={f} />
          ))}
        </div>
      )}
      <MiniTable
        rows={rec.containers}
        rowKey={(c) => c.name}
        columns={[
          {
            label: i18n.t('Container'),
            lang: 'en',
            cell: (c) => <span className="text-fg">{c.name}</span>,
          },
          {
            label: i18n.t('CPU request'),
            cell: (c) => (
              <ChangeCell
                current={c.current.cpu_request}
                next={c.recommended.cpu_request}
                change={c.cpu}
                format={cpuText}
              />
            ),
          },
          {
            label: i18n.t('Memory request'),
            cell: (c) => (
              <ChangeCell
                current={c.current.memory_request}
                next={c.recommended.memory_request}
                change={c.memory}
                format={memoryText}
              />
            ),
          },
          {
            label: i18n.t('Memory limit'),
            cell: (c) => (
              <span className="inline-flex flex-wrap items-center gap-1">
                <ChangeCell
                  current={c.current.memory_limit}
                  next={c.recommended.memory_limit}
                  change={c.memory_limit}
                  format={memoryText}
                />
                {(c.memory_limit_raised || c.cpu_limit_raised) && <RaisedTag ratio={null} />}
              </span>
            ),
          },
        ]}
      />
      {stored && (
        <RecommendationSparklines clusterId={clusterId} rec={rec} run={run} enabled={isActive} />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
        {rec.changed ? (
          <span
            className={cn(
              'font-medium tabular-nums',
              rec.monthly_delta < 0 ? 'text-status-running' : 'text-status-starting',
            )}
          >
            {rec.monthly_delta < 0
              ? i18n.t('Saves about {amount} a month', {
                  amount: formatMoney(-rec.monthly_delta, report.currency),
                })
              : i18n.t('Adds about {amount} a month', {
                  amount: formatMoney(rec.monthly_delta, report.currency),
                })}
          </span>
        ) : (
          <span className="text-fg-dim">{i18n.t('No change')}</span>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
          <button
            type="button"
            onClick={() => openRecommendationsView(clusterId, stored ? key : undefined)}
            className="text-fg-dim hover:text-accent inline-flex items-center gap-0.5 text-[11px]"
          >
            {i18n.t('Open in Recommendations')}
            <ArrowUpRight className="h-3 w-3 shrink-0" />
          </button>
          {applied ? (
            <span className="text-status-running inline-flex items-center gap-1 text-[11px]">
              <Check className="h-3 w-3 shrink-0" />
              {i18n.t('Applied, updated at the next scan')}
            </span>
          ) : (
            <ApplyButton clusterId={clusterId} rec={rec} onApply={apply} onReview={review} />
          )}
        </div>
      </div>
      {reviewing && (
        <RightsizingDialog
          clusterId={clusterId}
          rec={reviewing}
          currency={report.currency}
          requireAck={reviewing.confidence !== 'high'}
          onApplied={() =>
            useRecommendationsStore.getState().markApplied(clusterId, workloadKey(reviewing))
          }
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  );
}

/** Compact right-sizing of one workload in its details panel. */
export function RightsizingSection({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const workload = useMemo(
    () =>
      isRightsizable(obj.kind) && obj.metadata.namespace
        ? { kind: obj.kind, namespace: obj.metadata.namespace, name: obj.metadata.name }
        : null,
    [obj.kind, obj.metadata.namespace, obj.metadata.name],
  );
  const { origin, report, rec, run, error } = useStoredOrLiveRightsizing(
    ctx.clusterId,
    NO_NAMESPACES,
    workload,
    isActive && !!workload,
  );
  if (!workload) return null;

  return (
    <Section
      title={i18n.t('Right-sizing')}
      actions={
        rec ? (
          // Wraps below the title's width instead of overflowing a narrow panel.
          <span className="flex flex-wrap justify-end gap-1">
            <Badge tone={VERDICT_TONE[rec.verdict]} size="xs">
              {verdictLabel(rec.verdict)}
            </Badge>
            {rec.verdict !== 'no-data' && (
              <Badge tone={CONFIDENCE_TONE[rec.confidence]} size="xs">
                {confidenceLabel(rec.confidence)}
              </Badge>
            )}
          </span>
        ) : undefined
      }
    >
      {!report ? (
        <p className="text-fg-muted flex items-center gap-2 text-[12px]">
          {error ? (
            <span className="text-status-error">{error}</span>
          ) : (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {origin === 'pending'
                ? i18n.t('Loading recommendations…')
                : i18n.t('Reading usage history…')}
            </>
          )}
        </p>
      ) : !rec ? (
        <p className="text-fg-dim text-[12px]">{i18n.t('No recommendation for this workload.')}</p>
      ) : (
        <RecommendationBody
          clusterId={ctx.clusterId}
          rec={rec}
          report={report}
          origin={origin}
          run={run}
          isActive={isActive}
        />
      )}
    </Section>
  );
}
