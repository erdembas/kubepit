import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@/lib/cost';
import { cn } from '@/lib/cn';
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
import { MiniTable, Section } from '../details/primitives';
import type { SectionProps } from '../details/sections/types';
import { ChangeCell, RaisedTag, RightsizingDialog } from './RightsizingDialog';
import { CONFIDENCE_TONE, VERDICT_TONE } from './tones';
import { useRightsizing } from './useCost';

/** Compact right-sizing of one workload in its details panel. */
export function RightsizingSection({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const [applying, setApplying] = useState(false);
  const workload = useMemo(
    () =>
      isRightsizable(obj.kind) && obj.metadata.namespace
        ? { kind: obj.kind, namespace: obj.metadata.namespace, name: obj.metadata.name }
        : null,
    [obj.kind, obj.metadata.namespace, obj.metadata.name],
  );
  const report = useRightsizing(ctx.clusterId, [], workload, isActive && !!workload);
  if (!workload) return null;
  const data = report.data;
  const rec = data?.workloads[0];

  return (
    <Section
      title={i18n.t('Right-sizing')}
      actions={
        rec ? (
          <>
            <Badge tone={VERDICT_TONE[rec.verdict]} size="xs">
              {verdictLabel(rec.verdict)}
            </Badge>
            {rec.verdict !== 'no-data' && (
              <Badge tone={CONFIDENCE_TONE[rec.confidence]} size="xs">
                {confidenceLabel(rec.confidence)}
              </Badge>
            )}
          </>
        ) : undefined
      }
    >
      {!data ? (
        <p className="text-fg-muted flex items-center gap-2 text-[12px]">
          {report.error ? (
            <span className="text-status-error">{report.error}</span>
          ) : (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {i18n.t('Reading usage history…')}
            </>
          )}
        </p>
      ) : !rec ? (
        <p className="text-fg-dim text-[12px]">{i18n.t('No recommendation for this workload.')}</p>
      ) : (
        <div className="space-y-2.5">
          <MiniTable
            rows={rec.containers}
            rowKey={(c) => c.name}
            columns={[
              {
                label: i18n.t('Container'),
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
            <span className="text-fg-dim">
              {sourceLabel(data.source, reportDays(data))}
              {rec.coverage_hours > 0 &&
                ` · ${i18n.t('{duration} of history', { duration: coverageLabel(rec.coverage_hours) })}`}
            </span>
            {rec.changed && (
              <span
                className={cn(
                  'font-medium tabular-nums',
                  rec.monthly_delta < 0 ? 'text-status-running' : 'text-status-starting',
                )}
              >
                {rec.monthly_delta < 0
                  ? i18n.t('Saves about {amount} a month', {
                      amount: formatMoney(-rec.monthly_delta, data.currency),
                    })
                  : i18n.t('Adds about {amount} a month', {
                      amount: formatMoney(rec.monthly_delta, data.currency),
                    })}
              </span>
            )}
            <Button
              className="ml-auto"
              size="xs"
              variant="secondary"
              disabled={!rec.changed}
              onClick={() => setApplying(true)}
            >
              {i18n.t('Review & apply')}
            </Button>
          </div>
          {applying && (
            <RightsizingDialog
              clusterId={ctx.clusterId}
              rec={rec}
              currency={data.currency}
              onClose={() => setApplying(false)}
            />
          )}
        </div>
      )}
    </Section>
  );
}
