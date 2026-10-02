import * as i18n from '@/i18n/core';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import type { KubeObject } from '@/types';
import {
  POLICY_REPORT_KEYS,
  reportResultCounts,
  reportScope,
  updatedAt,
  type ResultCounts,
} from '../policyreports';
import { Dash, Mono, Muted, RefLink, standard } from './cells';
import type { ColumnDef, KindColumns } from './types';

/** Default columns for the policy report kinds (`wgpolicyk8s.io`). */

const RESULT_CLASS: Record<keyof ResultCounts, string> = {
  fail: 'text-status-error',
  error: 'text-cat-infra',
  warn: 'text-status-starting',
  pass: 'text-status-running',
  skip: 'text-fg-dim',
};

const RESULT_LABEL: Record<keyof ResultCounts, () => string> = {
  fail: () => i18n.t('Fail'),
  error: () => i18n.t('Error'),
  warn: () => i18n.t('Warn'),
  pass: () => i18n.t('Pass'),
  skip: () => i18n.t('Skip'),
};

const scopeColumn: ColumnDef = {
  id: 'scope',
  label: () => i18n.t('Object'),
  width: 'minmax(160px, 2.2fr)',
  cell: (o, ctx) => {
    const s = reportScope(o);
    if (!s) return <Muted>{o.metadata.name}</Muted>;
    return (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-fg-dim shrink-0 text-[10.5px]">{s.kind}</span>
        <RefLink target={{ kind: s.kind, name: s.name, namespace: s.namespace }} ctx={ctx} />
      </span>
    );
  },
  sort: (o) => {
    const s = reportScope(o);
    return `${s?.kind ?? ''}/${s?.namespace ?? ''}/${s?.name ?? o.metadata.name}`;
  },
  text: (o) => {
    const s = reportScope(o);
    return `${s?.kind ?? ''} ${s?.namespace ?? ''} ${s?.name ?? o.metadata.name}`;
  },
};

function countColumn(key: keyof ResultCounts, hidden = false): ColumnDef {
  return {
    id: key,
    label: RESULT_LABEL[key],
    width: '64px',
    align: 'right',
    defaultHidden: hidden,
    cell: (o) => {
      const n = reportResultCounts(o)[key];
      return (
        <span
          className={cn(
            'tabular-nums',
            n ? cn(RESULT_CLASS[key], 'font-semibold') : 'text-fg-dim/50',
          )}
        >
          {n}
        </span>
      );
    },
    // Descending by default reads naturally: most findings first.
    sort: (o) => -reportResultCounts(o)[key],
    value: (o) => reportResultCounts(o)[key],
  };
}

const updatedColumn: ColumnDef = {
  id: 'updated',
  label: () => i18n.t('Updated'),
  width: '76px',
  align: 'right',
  cell: (o, ctx) => {
    const v = updatedAt(o);
    return v ? (
      <span className="text-fg-muted tabular-nums" title={v}>
        {formatAge(v, ctx.now)}
      </span>
    ) : (
      <Dash />
    );
  },
  sort: (o) => -(Date.parse(updatedAt(o)) || 0),
  value: (o) => updatedAt(o) || null,
};

function searchText(o: KubeObject): string {
  const s = reportScope(o);
  return `${s?.kind ?? ''} ${s?.name ?? ''} ${s?.namespace ?? ''} ${o.metadata.name}`;
}

function reportColumns(namespaced: boolean): KindColumns {
  return {
    columns: standard(namespaced, [
      scopeColumn,
      countColumn('fail'),
      countColumn('error'),
      countColumn('warn'),
      countColumn('pass'),
      countColumn('skip', true),
      {
        id: 'engine',
        label: () => i18n.t('Engine'),
        width: '96px',
        defaultHidden: true,
        cell: (o) => {
          const engine = o.metadata.labels?.['app.kubernetes.io/managed-by'];
          return engine ? <Mono>{engine}</Mono> : <Dash />;
        },
        sort: (o) => o.metadata.labels?.['app.kubernetes.io/managed-by'] ?? '',
      },
      updatedColumn,
    ]),
    defaultSort: { column: 'fail', desc: false },
    searchText,
  };
}

export const POLICY_REPORT_COLUMNS: Record<string, KindColumns> = {
  [POLICY_REPORT_KEYS.PolicyReport]: reportColumns(true),
  [POLICY_REPORT_KEYS.ClusterPolicyReport]: reportColumns(false),
};
