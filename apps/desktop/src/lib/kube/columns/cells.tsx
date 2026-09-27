import * as i18n from '@/i18n/core';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { formatAge, formatPercent } from '@/lib/format';
import { usageBarClass } from '@/lib/resourceTone';
import type { KubeObject } from '@/types';
import { createdAt } from '../accessors';
import type { StatusTone } from '../pods';
import { toneText, type ConditionChip } from '../workloads';
import type { ColumnContext, ColumnDef, ObjectRef } from './types';

/** Shared cell renderers and the columns every kind starts with. */

export function Muted({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="text-fg-muted truncate" title={title}>
      {children}
    </span>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="text-fg-muted truncate font-mono text-[11px]" title={title}>
      {children}
    </span>
  );
}

export function Dash() {
  return <span className="text-fg-dim/60">—</span>;
}

export function Tone({
  tone,
  children,
  title,
}: {
  tone: StatusTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={cn('truncate font-medium', toneText(tone))} title={title}>
      {children}
    </span>
  );
}

export function RefLink({
  target,
  ctx,
  label,
}: {
  target: ObjectRef;
  ctx: ColumnContext;
  label?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        ctx.navigate(target);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="text-accent hover:text-accent-hover min-w-0 truncate text-left hover:underline"
      title={`${target.kind} ${target.namespace ? `${target.namespace}/` : ''}${target.name}`}
    >
      {label ?? target.name}
    </button>
  );
}

export function Chips({ values, max = 2 }: { values: string[]; max?: number }) {
  if (!values.length) return <Dash />;
  const shown = values.slice(0, max);
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden" title={values.join('\n')}>
      {shown.map((v) => (
        <span
          key={v}
          className="bg-fg/5 text-fg-muted ring-border/60 max-w-[180px] shrink truncate rounded px-1.5 py-px font-mono text-[10.5px] ring-1"
        >
          {v}
        </span>
      ))}
      {values.length > max && (
        <span className="text-fg-dim shrink-0 text-[10.5px]">+{values.length - max}</span>
      )}
    </span>
  );
}

export function ConditionWords({ chips }: { chips: ConditionChip[] }) {
  if (!chips.length) return <Dash />;
  return (
    <span className="flex min-w-0 items-center gap-2 overflow-hidden">
      {chips.map((c) => (
        <span
          key={c.label}
          className={cn('shrink-0 font-medium', toneText(c.tone))}
          title={c.message}
        >
          {c.label}
        </span>
      ))}
    </span>
  );
}

export function UsageBar({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  return (
    <span
      className="flex min-w-0 flex-1 items-center gap-2"
      title={`${label} · ${formatPercent(pct)}`}
    >
      <span className="bg-fg/8 relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full">
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full', usageBarClass(pct))}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span className="text-fg-muted w-9 shrink-0 text-right text-[11px] tabular-nums">
        {formatPercent(pct)}
      </span>
    </span>
  );
}

export const nameColumn: ColumnDef = {
  id: 'name',
  label: () => i18n.t('Name'),
  width: 'minmax(150px, 3fr)',
  fixed: true,
  cell: (o) => (
    <span className="text-fg truncate" title={o.metadata.name}>
      {o.metadata.name}
    </span>
  ),
  sort: (o) => o.metadata.name,
};

export const namespaceColumn: ColumnDef = {
  id: 'namespace',
  label: () => i18n.t('Namespace'),
  width: 'minmax(84px, 1fr)',
  cell: (o) => <Muted>{o.metadata.namespace ?? '—'}</Muted>,
  sort: (o) => o.metadata.namespace ?? '',
};

export const ageColumn: ColumnDef = {
  id: 'age',
  label: () => i18n.t('Age'),
  width: '56px',
  align: 'right',
  cell: (o, ctx) => (
    <span className="text-fg-muted tabular-nums" title={o.metadata.creationTimestamp}>
      {formatAge(o.metadata.creationTimestamp, ctx.now)}
    </span>
  ),
  // Newest first reads naturally when ascending sorts by age.
  sort: (o) => -createdAt(o),
  value: (o) => o.metadata.creationTimestamp ?? null,
};

export function labelsColumn(hidden = true): ColumnDef {
  return {
    id: 'labels',
    label: () => i18n.t('Labels'),
    width: 'minmax(160px, 2fr)',
    defaultHidden: hidden,
    cell: (o) => (
      <Chips values={Object.entries(o.metadata.labels ?? {}).map(([k, v]) => `${k}=${v}`)} />
    ),
    sort: (o) => Object.keys(o.metadata.labels ?? {}).length,
    value: (o) => o.metadata.labels ?? {},
  };
}

/** Name + (Namespace) + … + Age scaffold for simple kinds. */
export function standard(namespaced: boolean, middle: ColumnDef[]): ColumnDef[] {
  return [nameColumn, ...(namespaced ? [namespaceColumn] : []), ...middle, ageColumn];
}

export function ownerRef(o: KubeObject): ObjectRef | null {
  const refs = o.metadata.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  return ref
    ? {
        apiVersion: ref.apiVersion,
        kind: ref.kind,
        name: ref.name,
        namespace: o.metadata.namespace ?? null,
      }
    : null;
}
