import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { ArrowRight, ChartBarBig } from 'lucide-react';
import { cn } from '@/lib/cn';
import { capacityByNamespace, type NamespaceCapacity } from '@/lib/kube/recommendations/model';
import { memoryText } from '@/lib/kube/rightsizing/model';
import type { WorkloadRecommendation } from '@/types';
import { cpuWithUnit } from '../metrics/UsageHistory';
import { Card, Legend } from '../overview/charts';
import { barPercent, signedPercent, totalsChange } from './summaryModel';

type Resource = 'cpu' | 'memory';

/** CPU / memory segmented toggle (`aria-pressed`). */
export function ResourceToggle({
  value,
  onChange,
  label,
}: {
  value: Resource;
  onChange: (next: Resource) => void;
  label: string;
}) {
  i18n.useLocale();
  const options: Array<{ key: Resource; label: string }> = [
    { key: 'cpu', label: i18n.t('CPU') },
    { key: 'memory', label: i18n.t('Memory') },
  ];
  return <Segmented value={value} options={options} onChange={onChange} label={label} />;
}

/** A small segmented control of the section cards (`aria-pressed` buttons). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ key: T; label: string }>;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div
      className="bg-fg/4 inline-flex shrink-0 gap-0.5 rounded-md p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            'rounded px-1.5 py-px text-[10.5px] transition-colors',
            value === o.key
              ? 'bg-surface-raised text-fg font-medium shadow-sm'
              : 'text-fg-dim hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function CapacityRow({
  entry,
  max,
  format,
  active,
  onClick,
}: {
  entry: NamespaceCapacity;
  max: number;
  format: (v: number) => string;
  active: boolean;
  onClick: () => void;
}) {
  i18n.useLocale();
  const change = totalsChange(entry.current, entry.recommended);
  const current = format(entry.current);
  const recommended = format(entry.recommended);
  return (
    <li className="flex max-h-[5.5rem] flex-1 flex-col">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={
          active
            ? i18n.t('Show every namespace in scope')
            : i18n.t('Show only {namespace}', { namespace: entry.namespace })
        }
        className={cn(
          'relative grid w-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] content-center items-center gap-x-3 gap-y-1 px-4 py-2 text-left transition-colors @md:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto]',
          active ? 'bg-fg/6' : 'hover:bg-fg/4',
        )}
      >
        {active && <span className="bg-accent absolute inset-y-1 left-0 w-0.5 rounded-full" />}
        <span className="min-w-0">
          <span className="text-fg block truncate text-[12px] font-medium">{entry.namespace}</span>
          <span className="text-fg-dim block text-[10.5px] tabular-nums">
            {i18n.t('{comparable}/{total} comparable', {
              comparable: i18n.number(entry.comparable),
              total: i18n.number(entry.containers),
            })}
          </span>
        </span>
        <svg
          className="col-span-2 row-start-2 block h-3.5 w-full @md:col-span-1 @md:col-start-2 @md:row-start-1"
          role="img"
          aria-label={i18n.t('Current requests {current}, recommended {recommended}', {
            current,
            recommended,
          })}
        >
          <rect
            x="0"
            y="0"
            height="6"
            rx="2"
            width={`${barPercent(entry.current, max)}%`}
            className="fill-fg/15"
          />
          <rect
            x="0"
            y="8"
            height="6"
            rx="2"
            width={`${barPercent(entry.recommended, max)}%`}
            className="fill-accent"
          />
        </svg>
        <span className="flex flex-col items-end text-[11.5px] tabular-nums">
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <span className="text-fg-muted">{current}</span>
            <ArrowRight className="text-fg-dim h-3 w-3 shrink-0" aria-hidden />
            <span className="text-fg font-medium">{recommended}</span>
          </span>
          <span
            className={cn(
              'text-[10.5px]',
              change.direction === 'decrease'
                ? 'text-status-running'
                : change.direction === 'increase'
                  ? 'text-status-starting'
                  : 'text-fg-dim',
            )}
          >
            {change.ratio != null && change.direction !== 'none'
              ? signedPercent(change.ratio)
              : i18n.t('No change')}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The five namespaces with the largest current requests: paired bars of
 * current and recommended requests (comparable containers × replicas),
 * scaled to the largest value shown. A click narrows the page to the
 * namespace (again: back to the whole scope).
 */
export function CapacityOverview({
  list,
  onNamespace,
  active = null,
}: {
  list: readonly WorkloadRecommendation[];
  onNamespace: (namespace: string) => void;
  /** The namespace the page is narrowed to. */
  active?: string | null;
}) {
  i18n.useLocale();
  const [resource, setResource] = useState<Resource>('cpu');
  const entries = useMemo(() => capacityByNamespace(list, resource), [list, resource]);
  const format = resource === 'cpu' ? cpuWithUnit : memoryText;
  const max = Math.max(0, ...entries.flatMap((e) => [e.current, e.recommended]));
  const sum = (pick: (e: NamespaceCapacity) => number) => entries.reduce((s, e) => s + pick(e), 0);

  return (
    <Card
      title={i18n.t('Capacity overview')}
      icon={<ChartBarBig />}
      className="@container flex flex-col"
      actions={
        <ResourceToggle
          value={resource}
          onChange={setResource}
          label={i18n.t('Resource of the capacity overview')}
        />
      }
    >
      {entries.length === 0 ? (
        <p className="text-fg-dim flex flex-1 items-center justify-center px-4 py-10 text-center text-[12px]">
          {i18n.t('Namespace comparisons appear after the first scan.')}
        </p>
      ) : (
        <>
          <ul className="flex flex-1 flex-col py-1">
            {entries.map((e) => (
              <CapacityRow
                key={e.namespace}
                entry={e}
                max={max}
                format={format}
                active={active === e.namespace}
                onClick={() => onNamespace(e.namespace)}
              />
            ))}
          </ul>
          <Legend
            className="border-border/60 grid space-y-0 gap-x-6 gap-y-1 border-t px-4 py-2 @md:grid-cols-2"
            items={[
              {
                key: 'current',
                label: i18n.t('Current requests'),
                value: format(sum((e) => e.current)),
                fill: 'bg-fg/15',
              },
              {
                key: 'recommended',
                label: i18n.t('Recommended requests'),
                value: format(sum((e) => e.recommended)),
                fill: 'bg-accent',
              },
            ]}
          />
        </>
      )}
    </Card>
  );
}
