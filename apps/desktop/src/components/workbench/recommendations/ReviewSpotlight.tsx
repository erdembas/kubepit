import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { Check, CircleCheck, Info, Siren } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@/lib/cost';
import { cn } from '@/lib/cn';
import { spotlight, workloadKey } from '@/lib/kube/recommendations/model';
import {
  confidenceLabel,
  containerChanged,
  cpuText,
  memoryText,
} from '@/lib/kube/rightsizing/model';
import type { WorkloadRecommendation } from '@/types';
import { ChangeCell, RaisedTag } from '../cost/RightsizingDialog';
import { CONFIDENCE_TONE } from '../cost/tones';
import { Card } from '../overview/charts';
import { lowConfidenceChanges, spotlightReason } from './summaryModel';

/** Containers whose change cells a spotlight entry shows. */
const SHOWN_CONTAINERS = 2;

function SpotlightItem({
  rec,
  group,
  currency,
  active,
  applied,
  onReview,
}: {
  rec: WorkloadRecommendation;
  group: 'under' | 'over';
  currency: string;
  active: boolean;
  /** Applied in this session; the next scan reflects it. */
  applied: boolean;
  onReview: () => void;
}) {
  i18n.useLocale();
  const reason = group === 'under' ? spotlightReason(rec) : null;
  const changed = rec.containers.filter(containerChanged);
  const shown = changed.slice(0, SHOWN_CONTAINERS);
  return (
    <li
      className={cn(
        'border-border/50 relative flex min-w-0 items-start gap-3 border-t px-4 py-2.5 first:border-t-0',
        active && 'bg-fg/6',
      )}
    >
      {active && <span className="bg-accent absolute inset-y-1 left-0 w-0.5 rounded-full" />}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-fg-dim shrink-0 text-[10.5px]">{rec.kind}</span>
          <span
            className="text-fg min-w-0 truncate text-[12.5px] font-medium"
            title={`${rec.namespace}/${rec.name}`}
          >
            {rec.name}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-fg-dim max-w-full truncate">{rec.namespace}</span>
          {reason?.tone === 'critical' && (
            <Badge tone="critical" size="xs" title={reason.title}>
              {reason.text}
            </Badge>
          )}
          {reason?.tone === 'warning' && (
            <span className="text-status-starting font-medium" title={reason.title}>
              {reason.text}
            </span>
          )}
          <Badge tone={CONFIDENCE_TONE[rec.confidence]} size="xs">
            {confidenceLabel(rec.confidence)}
          </Badge>
          {group === 'over' && rec.monthly_delta < 0 && (
            <span className="text-status-running font-medium tabular-nums">
              {i18n.t('Saves about {amount} a month', {
                amount: formatMoney(-rec.monthly_delta, currency),
              })}
            </span>
          )}
          {applied && (
            <span className="text-status-running inline-flex items-center gap-1">
              <Check className="h-3 w-3 shrink-0" />
              {i18n.t('Applied, updated at the next scan')}
            </span>
          )}
        </div>
        {shown.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-[11.5px]">
            {shown.map((c) => (
              <li key={c.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-fg-muted max-w-[140px] truncate font-medium" title={c.name}>
                  {c.name}
                </span>
                <span className="inline-flex min-w-0 items-center gap-x-1.5">
                  <span className="text-fg-dim">{i18n.t('CPU')}</span>
                  <ChangeCell
                    current={c.current.cpu_request}
                    next={c.recommended.cpu_request}
                    change={c.cpu}
                    format={cpuText}
                  />
                </span>
                <span className="inline-flex min-w-0 items-center gap-x-1.5">
                  <span className="text-fg-dim">{i18n.t('Memory')}</span>
                  <ChangeCell
                    current={c.current.memory_request}
                    next={c.recommended.memory_request}
                    change={c.memory}
                    format={memoryText}
                  />
                </span>
                {(c.cpu_limit_raised || c.memory_limit_raised) && <RaisedTag ratio={null} />}
              </li>
            ))}
            {changed.length > shown.length && (
              <li className="text-fg-dim">
                {i18n.plural(
                  '+{count} more container',
                  '+{count} more containers',
                  changed.length - shown.length,
                )}
              </li>
            )}
          </ul>
        )}
      </div>
      <Button
        size="xs"
        variant="secondary"
        onClick={onReview}
        aria-current={active ? 'true' : undefined}
      >
        {i18n.t('Review')}
      </Button>
    </li>
  );
}

function Group({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <div className="min-w-0 py-1">
      <h4 className="text-fg-dim px-4 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.12em] uppercase">
        {title}
      </h4>
      {children.length ? (
        <ul>{children}</ul>
      ) : (
        <p className="text-fg-dim px-4 pt-1 pb-3 text-[11.5px]">{empty}</p>
      )}
    </div>
  );
}

/**
 * The three riskiest under-provisioned workloads (confidence ≥ medium; an
 * OOM kill first), then the three largest high-confidence savings, each
 * with its change cells and "Review" (the drawer, where it is applied).
 * Rows applied in this session say so until the next scan.
 */
export function ReviewSpotlight({
  list,
  onReview,
  currency = 'USD',
  active = null,
  applied,
  className,
}: {
  list: readonly WorkloadRecommendation[];
  onReview: (rec: WorkloadRecommendation) => void;
  currency?: string;
  /** `workloadKey` of the row open in the drawer. */
  active?: string | null;
  /** `workloadKey` → when it was applied in this session. */
  applied?: Readonly<Record<string, number>>;
  className?: string;
}) {
  i18n.useLocale();
  const { under, over } = useMemo(() => spotlight(list), [list]);
  const unsure = useMemo(() => lowConfidenceChanges(list), [list]);
  const item = (group: 'under' | 'over') => (rec: WorkloadRecommendation) => {
    const key = workloadKey(rec);
    return (
      <SpotlightItem
        key={key}
        rec={rec}
        group={group}
        currency={currency}
        active={active === key}
        applied={applied?.[key] != null}
        onReview={() => onReview(rec)}
      />
    );
  };

  return (
    <Card title={i18n.t('Review spotlight')} icon={<Siren />} className={className}>
      {!under.length && !over.length ? (
        <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
          <p className="text-fg-muted flex items-center gap-2 text-[12px]">
            {unsure ? (
              <Info className="text-fg-dim h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <CircleCheck className="text-status-running h-4 w-4 shrink-0" aria-hidden />
            )}
            {i18n.t('No workload needs attention')}
          </p>
          {unsure > 0 && (
            <p className="text-fg-dim max-w-md text-[11.5px]">
              {i18n.plural(
                '{count} changed workload has too little confidence for the spotlight; review it in the list.',
                '{count} changed workloads have too little confidence for the spotlight; review them in the list.',
                unsure,
              )}
            </p>
          )}
        </div>
      ) : (
        <div className="divide-border/60 grid divide-y @3xl:grid-cols-2 @3xl:divide-x @3xl:divide-y-0">
          <Group
            title={i18n.t('Under-provisioned')}
            empty={i18n.t('No under-provisioned workload with enough confidence.')}
          >
            {under.map(item('under'))}
          </Group>
          <Group title={i18n.t('Largest savings')} empty={i18n.t('No high-confidence saving.')}>
            {over.map(item('over'))}
          </Group>
        </div>
      )}
    </Card>
  );
}
