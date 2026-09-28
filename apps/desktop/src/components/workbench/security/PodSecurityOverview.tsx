import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { ChevronRight, Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ObjectRef } from '@/lib/kube/columns';
import {
  PSS_MODES,
  evaluateNamespace,
  hasPssPolicy,
  modeLabel,
  ownersByNamespace,
  policyText,
  type NamespaceEvaluation,
} from '@/lib/kube/pss';
import type { ApiResourceInfo, KubeObject } from '@/types';
import { StatTile } from '../overview/charts';
import { usePodSpecOwners } from './hooks';
import { PodSecurityPanel } from './PodSecurityPanel';

/**
 * Pod Security Standards per namespace: the admission labels, how many
 * workloads violate baseline and restricted, and — expanded — the local
 * evaluation next to a server-side dry run of a stricter enforce level.
 */

const GRID =
  '@2xl:grid @2xl:grid-cols-[minmax(140px,1.6fr)_repeat(3,minmax(92px,1fr))_76px_76px] @2xl:items-center @2xl:gap-x-3';

interface Row {
  ns: KubeObject;
  owners: KubeObject[];
  evaluation: NamespaceEvaluation;
}

function Count({ n, tone }: { n: number; tone: string }) {
  return <span className={cn('tabular-nums', n ? tone : 'text-fg-dim/60')}>{n}</span>;
}

export function PodSecurityOverview({
  clusterId,
  apiResources,
  namespaces,
  query,
  isActive,
  onOpen,
}: {
  clusterId: string;
  apiResources: ApiResourceInfo[] | null;
  namespaces: string[];
  query: string;
  isActive: boolean;
  onOpen: (ref: ObjectRef) => void;
}) {
  i18n.useLocale();
  const data = usePodSpecOwners(clusterId, apiResources, namespaces, isActive);
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo((): Row[] => {
    const byNs = ownersByNamespace(data.owners);
    const scoped = namespaces.length
      ? data.namespaces.filter((n) => namespaces.includes(n.metadata.name))
      : data.namespaces;
    return scoped
      .map((ns) => {
        const owners = byNs.get(ns.metadata.name) ?? [];
        return { ns, owners, evaluation: evaluateNamespace(ns, owners) };
      })
      .sort(
        (a, b) =>
          b.evaluation.modes.enforce.length - a.evaluation.modes.enforce.length ||
          Number(hasPssPolicy(b.evaluation.pss)) - Number(hasPssPolicy(a.evaluation.pss)) ||
          a.ns.metadata.name.localeCompare(b.ns.metadata.name),
      );
  }, [data.owners, data.namespaces, namespaces]);

  const q = query.trim().toLowerCase();
  const visible = q ? rows.filter((r) => r.ns.metadata.name.toLowerCase().includes(q)) : rows;
  const totals = useMemo(
    () => ({
      enforcing: rows.filter((r) => r.evaluation.pss.enforce.level !== 'privileged').length,
      enforceViolations: rows.reduce((s, r) => s + r.evaluation.modes.enforce.length, 0),
      baseline: rows.reduce((s, r) => s + r.evaluation.baseline.length, 0),
      restricted: rows.reduce((s, r) => s + r.evaluation.restricted.length, 0),
      workloads: rows.reduce((s, r) => s + r.evaluation.total, 0),
    }),
    [rows],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatTile
          label={i18n.t('Enforcing namespaces')}
          value={i18n.number(totals.enforcing)}
          sub={i18n.t('of {count}', { count: rows.length })}
        />
        <StatTile
          label={i18n.t('Enforce violations')}
          value={i18n.number(totals.enforceViolations)}
          tone={totals.enforceViolations ? 'text-status-error' : 'text-fg'}
          sub={i18n.t('workloads')}
        />
        <StatTile
          label={i18n.t('Fail baseline')}
          value={i18n.number(totals.baseline)}
          tone={totals.baseline ? 'text-status-starting' : 'text-fg'}
          sub={i18n.t('of {count} workloads', { count: totals.workloads })}
        />
        <StatTile
          label={i18n.t('Fail restricted')}
          value={i18n.number(totals.restricted)}
          sub={i18n.t('of {count} workloads', { count: totals.workloads })}
        />
      </div>
      {data.errors.length > 0 && (
        <div className="border-status-starting/30 bg-status-starting/8 text-fg-muted rounded-app flex items-start gap-2.5 border px-4 py-2.5 text-[12px]">
          <TriangleAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">
            {i18n.t('Some lists could not be read, so the evaluation is incomplete: {kinds}', {
              kinds: data.errors.map((e) => e.gvk.kind).join(', '),
            })}
          </span>
        </div>
      )}
      <section className="rounded-app border-border bg-surface-raised/40 overflow-hidden border">
        <div
          className={cn(
            'border-border/60 text-fg-dim hidden h-8 border-b px-4 text-[10px] font-semibold tracking-[0.08em] uppercase',
            GRID,
          )}
        >
          <span>{i18n.t('Namespace')}</span>
          {PSS_MODES.map((m) => (
            <span key={m}>{modeLabel(m)}</span>
          ))}
          <span className="text-right" lang="en">
            {i18n.t('Baseline')}
          </span>
          <span className="text-right" lang="en">
            {i18n.t('Restricted')}
          </span>
        </div>
        {!data.synced && !rows.length ? (
          <div className="text-fg-muted flex items-center justify-center gap-2 px-4 py-8 text-[12px]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Reading namespaces and workloads…')}
          </div>
        ) : !visible.length ? (
          <p className="text-fg-dim px-4 py-8 text-center text-[12px]">
            {rows.length ? i18n.t('No namespace matches the filter.') : i18n.t('No namespaces.')}
          </p>
        ) : (
          <ul className="divide-border/40 divide-y">
            {visible.map(({ ns, owners, evaluation }) => {
              const name = ns.metadata.name;
              const expanded = open === name;
              return (
                <li key={ns.metadata.uid}>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : name)}
                    aria-expanded={expanded}
                    className={cn(
                      'flex w-full flex-col gap-1 px-4 py-2 text-left text-[12px] transition-colors',
                      GRID,
                      expanded ? 'bg-fg/5' : 'hover:bg-fg/4',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ChevronRight
                        className={cn(
                          'text-fg-dim h-3.5 w-3.5 shrink-0 transition-transform',
                          expanded && 'rotate-90',
                        )}
                      />
                      <span className="text-fg truncate font-medium">{name}</span>
                      {evaluation.modes.enforce.length > 0 && (
                        <span
                          className="text-status-error ml-1 shrink-0 text-[10.5px] tabular-nums"
                          title={i18n.t('Workloads violating the enforced level')}
                        >
                          {i18n.plural(
                            '{count} enforce violation',
                            '{count} enforce violations',
                            evaluation.modes.enforce.length,
                          )}
                        </span>
                      )}
                    </span>
                    {PSS_MODES.map((m) => {
                      const p = evaluation.pss[m];
                      return (
                        <span key={m} className="flex min-w-0 items-center gap-1.5 pl-5 @2xl:pl-0">
                          <span className="text-fg-dim w-14 shrink-0 text-[10.5px] @2xl:hidden">
                            {modeLabel(m)}
                          </span>
                          <span
                            className={cn(
                              'truncate font-mono text-[11px]',
                              p.explicit ? 'text-fg' : 'text-fg-dim/60',
                            )}
                            title={p.explicit ? policyText(p) : undefined}
                          >
                            {p.explicit ? policyText(p) : '—'}
                          </span>
                        </span>
                      );
                    })}
                    <span className="flex items-center gap-3 pl-5 @2xl:contents">
                      <span className="text-fg-dim text-[10.5px] @2xl:hidden">
                        {i18n.t('Baseline')}
                      </span>
                      <span className="@2xl:text-right">
                        <Count n={evaluation.baseline.length} tone="text-status-starting" />
                      </span>
                      <span className="text-fg-dim text-[10.5px] @2xl:hidden">
                        {i18n.t('Restricted')}
                      </span>
                      <span className="@2xl:text-right">
                        <Count n={evaluation.restricted.length} tone="text-fg-muted" />
                      </span>
                    </span>
                  </button>
                  {expanded && (
                    <div className="border-border/40 bg-fg/[0.015] border-t px-4 py-3">
                      <PodSecurityPanel
                        clusterId={clusterId}
                        namespace={ns}
                        owners={owners}
                        synced={data.synced}
                        onOpen={onOpen}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
