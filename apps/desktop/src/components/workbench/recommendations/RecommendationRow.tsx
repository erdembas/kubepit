import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { memo } from 'react';
import { Check, TrendingDown, TrendingUp, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Choice';
import { formatMoney } from '@/lib/cost';
import { cn } from '@/lib/cn';
import type { ApplyMode } from '@/lib/kube/recommendations/model';
import {
  confidenceLabel,
  containerChanged,
  cpuText,
  limitRatio,
  memoryText,
  verdictLabel,
} from '@/lib/kube/rightsizing/model';
import type { WorkloadRecommendation } from '@/types';
import { ChangeCell, RaisedTag } from '../cost/RightsizingDialog';
import { CONFIDENCE_TONE, VERDICT_TONE } from '../cost/tones';
import { rowFlags, type FlagTone } from './listModel';

/**
 * Columns of the list at `@3xl` and wider (checkbox, workload, request
 * changes, monthly change and action; the list is its own container, so
 * a docked drawer narrows it); below, everything stacks beside the
 * checkbox. The header row uses the same template.
 */
export const ROW_GRID =
  'grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 @3xl:grid-cols-[16px_minmax(0,1fr)_minmax(0,1.35fr)_14rem]';

const FLAG_TONE: Record<FlagTone, string> = {
  critical: 'bg-status-error/10 text-status-error',
  warning: 'bg-status-starting/10 text-status-starting',
  neutral: 'bg-fg/6 text-fg-muted',
};

export interface RecommendationRowProps {
  rec: WorkloadRecommendation;
  /** `workloadKey(rec)`. */
  rowKey: string;
  /** `applyMode` on this cluster. */
  mode: ApplyMode;
  currency: string;
  /** Shown in the drawer: the accent strip. */
  active: boolean;
  selected: boolean;
  /** Applied in this session; the next scan reflects it. */
  applied: boolean;
  /** Offer the apply action (false for a past run). */
  actions: boolean;
  /** Apply and review need the cluster connection. */
  connected: boolean;
  onToggle: (key: string, shift: boolean) => void;
  onOpen: (key: string) => void;
  onApply: (rec: WorkloadRecommendation) => void;
  onReview: (rec: WorkloadRecommendation) => void;
}

/** The action of a row: "Apply" (one-click), "Review & apply", "Review" (read-only cluster). */
function RowAction({
  rec,
  mode,
  connected,
  onApply,
  onReview,
}: Pick<RecommendationRowProps, 'rec' | 'mode' | 'connected' | 'onApply' | 'onReview'>) {
  if (mode === 'none') return null;
  const title = !connected
    ? i18n.t('Connect to the cluster to apply.')
    : mode === 'read-only'
      ? i18n.t('This cluster is read-only: you can review the change, but it cannot be applied.')
      : undefined;
  return (
    <span title={title} className="shrink-0">
      <Button
        size="xs"
        variant="secondary"
        disabled={!connected}
        leftIcon={mode === 'one-click' ? <Zap className="text-accent h-3 w-3" /> : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (mode === 'one-click') onApply(rec);
          else onReview(rec);
        }}
      >
        {mode === 'one-click'
          ? i18n.t('Apply')
          : mode === 'read-only'
            ? i18n.t('Review')
            : i18n.t('Review & apply')}
      </Button>
    </span>
  );
}

/**
 * One workload of the recommendation list: kind, name and namespace,
 * verdict and confidence, flag chips (the caveat in the tooltip), the
 * request change of every changed container with raised limits tagged
 * `×ratio`, the monthly change and the apply action. A click opens it in
 * the drawer; shift-click extends the checkbox selection.
 */
export const RecommendationRow = memo(function RecommendationRow({
  rec,
  rowKey,
  mode,
  currency,
  active,
  selected,
  applied,
  actions,
  connected,
  onToggle,
  onOpen,
  onApply,
  onReview,
}: RecommendationRowProps) {
  i18n.useLocale();
  const flags = useMemo(() => rowFlags(rec), [rec]);
  const containers = rec.containers.filter((c) => containerChanged(c) || !rec.changed);
  const delta = rec.monthly_delta;

  return (
    <li
      data-key={rowKey}
      aria-current={active || undefined}
      onClick={(e) => {
        if (e.shiftKey) onToggle(rowKey, true);
        else onOpen(rowKey);
      }}
      className={cn(
        ROW_GRID,
        'border-border/40 cursor-default gap-y-1.5 border-b px-4 py-2.5 transition-colors select-none last:border-b-0 @3xl:items-center',
        active
          ? 'bg-fg/7 shadow-[inset_2px_0_0_rgb(var(--accent))]'
          : selected
            ? 'bg-accent/[0.06] hover:bg-accent/[0.09]'
            : 'hover:bg-fg/4',
      )}
    >
      <div className="flex pt-0.5 @3xl:pt-0" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          aria-label={i18n.t('Select {name}', { name: rec.name })}
          onChange={() => undefined}
          onClick={(e) => onToggle(rowKey, e.shiftKey)}
          className="mt-0"
        />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-fg-dim shrink-0 text-[10.5px]">{rec.kind}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(rowKey);
            }}
            className="text-fg hover:text-accent min-w-0 truncate text-left text-[12.5px] font-medium"
            title={`${rec.namespace}/${rec.name}`}
          >
            {rec.name}
          </button>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <span className="text-fg-dim mr-1 max-w-full truncate text-[11px]">{rec.namespace}</span>
          <Badge tone={VERDICT_TONE[rec.verdict]} size="xs">
            {verdictLabel(rec.verdict)}
          </Badge>
          {rec.verdict !== 'no-data' && (
            <Badge tone={CONFIDENCE_TONE[rec.confidence]} size="xs">
              {confidenceLabel(rec.confidence)}
            </Badge>
          )}
          {flags.map((f) => (
            <span
              key={f.code}
              title={f.detail}
              className={cn(
                'rounded px-1.5 py-px text-[10px] font-medium whitespace-nowrap',
                FLAG_TONE[f.tone],
              )}
            >
              {f.label}
            </span>
          ))}
        </div>
      </div>
      <ul className="col-start-2 min-w-0 space-y-0.5 text-[11.5px] @3xl:col-start-auto">
        {containers.map((c) => (
          <li key={c.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-fg-muted max-w-[140px] truncate font-medium" title={c.name}>
              {c.name}
            </span>
            <span className="text-fg-dim">{i18n.t('CPU')}</span>
            <ChangeCell
              current={c.current.cpu_request}
              next={c.recommended.cpu_request}
              change={c.cpu}
              format={cpuText}
            />
            {c.cpu_limit_raised && (
              <RaisedTag
                ratio={limitRatio(
                  c.current.cpu_request ?? c.current.cpu_limit,
                  c.current.cpu_limit,
                )}
              />
            )}
            <span className="text-fg-dim">{i18n.t('Memory')}</span>
            <ChangeCell
              current={c.current.memory_request}
              next={c.recommended.memory_request}
              change={c.memory}
              format={memoryText}
            />
            {c.memory_limit_raised && (
              <RaisedTag
                ratio={limitRatio(
                  c.current.memory_request ?? c.current.memory_limit,
                  c.current.memory_limit,
                )}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="col-start-2 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 @3xl:col-start-auto @3xl:justify-end">
        {rec.changed ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[12px] font-medium whitespace-nowrap tabular-nums',
              delta < 0 ? 'text-status-running' : 'text-status-starting',
            )}
          >
            {delta < 0 ? (
              <TrendingDown className="h-3.5 w-3.5" />
            ) : (
              <TrendingUp className="h-3.5 w-3.5" />
            )}
            {i18n.t('{amount} / month', {
              amount: formatMoney(delta, currency, { signed: true }),
            })}
          </span>
        ) : (
          <span className="text-fg-dim text-[11.5px]">{i18n.t('No change')}</span>
        )}
        {actions &&
          (applied ? (
            <span className="text-status-running inline-flex items-center gap-1 text-[11px]">
              <Check className="h-3 w-3 shrink-0" />
              {i18n.t('Applied, updated at the next scan')}
            </span>
          ) : (
            <RowAction
              rec={rec}
              mode={mode}
              connected={connected}
              onApply={onApply}
              onReview={onReview}
            />
          ))}
      </div>
    </li>
  );
});
