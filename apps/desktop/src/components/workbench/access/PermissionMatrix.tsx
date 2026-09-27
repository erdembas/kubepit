import * as i18n from '@/i18n';
import { useLocaleMemo } from '@/i18n';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Check,
  CircleHelp,
  Contrast,
  Minus,
  Search,
  ShieldQuestion,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import {
  MATRIX_VERBS,
  POD_SHORTCUTS,
  accessCheck,
  allowedNames,
  checkKey,
  evaluateRules,
  resourceRef,
} from '@/lib/kube/access';
import { buildNav, type NavItem } from '@/lib/kube/nav';
import { cn } from '@/lib/cn';
import { useAccess, useAccessRules, type AccessAnswer } from '@/store/useAccessStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { AccessCheck, AccessRules, ApiResourceInfo, Gvk } from '@/types';
import { MiniTable, MonoText } from '../details/primitives';

/**
 * Permission matrix for one namespace: kinds (grouped like the navigator)
 * × verbs, plus the pod subresources behind Logs / Shell / Attach / Port
 * forward. Namespaced rows are evaluated locally from the namespace's
 * rules review (no request per cell); cluster-scoped rows — which a
 * RoleBinding can never grant — use one batch of access reviews.
 */

type Cell =
  | 'allowed'
  | 'restricted'
  | 'denied'
  | 'unverified'
  | 'pending'
  | 'unknown'
  | 'unsupported'
  | 'none';

interface Column {
  id: string;
  verb: string;
  subresource: string | null;
  podOnly: boolean;
  width: number;
}

const COLUMNS: Column[] = [
  ...MATRIX_VERBS.map((verb) => ({
    id: verb,
    verb,
    subresource: null,
    podOnly: false,
    width: Math.max(48, Math.round(verb.length * 6.6 + 18)),
  })),
  ...POD_SHORTCUTS.map((s) => ({
    id: s.id,
    verb: s.verb,
    subresource: s.subresource,
    podOnly: true,
    width: Math.max(48, Math.round(s.id.length * 6.6 + 18)),
  })),
];
const VERB_COLUMNS = COLUMNS.filter((c) => !c.podOnly);
const TEMPLATE = [
  'minmax(200px,1fr)',
  ...VERB_COLUMNS.map((c) => `${c.width}px`),
  '9px',
  ...COLUMNS.filter((c) => c.podOnly).map((c) => `${c.width}px`),
].join(' ');
const MIN_WIDTH = 200 + 9 + COLUMNS.reduce((sum, c) => sum + c.width, 0) + 32;

interface Row {
  key: string;
  label: string;
  icon: LucideIcon;
  gvk: Gvk;
  terms: string;
  /** Verbs discovery says the resource serves (null = unknown). */
  verbs: ReadonlySet<string> | null;
}

interface RowGroup {
  id: string;
  label: string;
  rows: Row[];
}

function toRow(item: NavItem, apiResources: readonly ApiResourceInfo[] | null): Row | null {
  const gvk = item.gvk;
  if (!gvk) return null;
  const info = apiResources?.find((r) => r.group === gvk.group && r.plural === gvk.plural);
  return {
    key: item.key,
    label: item.label,
    icon: item.icon,
    gvk,
    terms: `${item.label} ${item.terms}`.toLowerCase(),
    verbs: info ? new Set(info.verbs) : null,
  };
}

function isPods(row: Row) {
  return row.gvk.group === '' && row.gvk.plural === 'pods';
}

function cellCheck(row: Row, column: Column, namespace: string): AccessCheck {
  return accessCheck(column.verb, row.gvk, { namespace, subresource: column.subresource });
}

function applies(row: Row, column: Column) {
  if (column.podOnly) return isPods(row);
  return !row.verbs || row.verbs.has(column.verb);
}

function reviewCell(answer: AccessAnswer | undefined): Cell {
  if (!answer || answer.state === 'unknown')
    return answer?.pending === false ? 'unknown' : 'pending';
  return answer.state === 'allowed' ? 'allowed' : 'denied';
}

export function PermissionMatrix({
  clusterId,
  namespace,
  apiResources,
}: {
  clusterId: string;
  namespace: string;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const [tab, setTab] = useState<'matrix' | 'rules'>('matrix');
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState<'allowed' | 'denied' | null>(null);
  const [verifying, setVerifying] = useState(false);
  const { rules, error, loading } = useAccessRules(clusterId, namespace);

  const groups = useLocaleMemo((): RowGroup[] => {
    return buildNav(apiResources)
      .map((g) => ({
        id: g.id,
        label: g.label,
        rows: [...g.items, ...g.subgroups.flatMap((s) => s.items)]
          .map((item) => toRow(item, apiResources))
          .filter((r): r is Row => !!r),
      }))
      .filter((g) => g.rows.length);
  }, [apiResources]);
  const allRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  // Cluster-scoped rows: a namespace's rules review also lists RoleBinding
  // grants, which never apply to cluster-scoped resources, so ask directly.
  const clusterChecks = useMemo(
    () =>
      allRows
        .filter((r) => !r.gvk.namespaced)
        .flatMap((r) =>
          VERB_COLUMNS.filter((c) => applies(r, c)).map((c) => cellCheck(r, c, namespace)),
        ),
    [allRows, namespace],
  );
  const clusterAnswers = useAccess(clusterId, clusterChecks, { mode: 'review' });

  // An incomplete rules review cannot prove a denial; "Verify" asks the
  // API server about every such cell of the rows on screen.
  const verifyChecks = useMemo(() => {
    if (!verifying || !rules?.incomplete) return [];
    return allRows
      .filter((r) => r.gvk.namespaced)
      .flatMap((r) =>
        COLUMNS.filter((c) => applies(r, c))
          .map((c) => cellCheck(r, c, namespace))
          .filter((check) => evaluateRules(rules, check) !== 'allowed'),
      );
  }, [verifying, rules, allRows, namespace]);
  const verifyAnswers = useAccess(clusterId, verifyChecks, { mode: 'review' });

  const answers = useMemo(() => {
    const map = new Map<string, AccessAnswer>();
    clusterChecks.forEach((c, i) => map.set(checkKey(c), clusterAnswers[i]!));
    verifyChecks.forEach((c, i) => map.set(checkKey(c), verifyAnswers[i]!));
    return map;
  }, [clusterChecks, clusterAnswers, verifyChecks, verifyAnswers]);

  const cellOf = (row: Row, column: Column): Cell => {
    if (!applies(row, column)) return column.podOnly ? 'none' : 'unsupported';
    const check = cellCheck(row, column, namespace);
    if (!row.gvk.namespaced) return reviewCell(answers.get(checkKey(check)));
    if (!rules) return loading ? 'pending' : 'unknown';
    const verdict = evaluateRules(rules, check);
    if (verdict === 'allowed' || !rules.incomplete) return verdict;
    const verified = answers.get(checkKey(check));
    return verified ? reviewCell(verified) : 'unverified';
  };

  const q = query.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter((row) => {
        if (q && !row.terms.includes(q)) return false;
        if (!only) return true;
        const cells = COLUMNS.map((c) => cellOf(row, c));
        return only === 'allowed'
          ? cells.some((c) => c === 'allowed' || c === 'restricted')
          : cells.some((c) => c === 'denied');
      }),
    }))
    .filter((g) => g.rows.length);
  const rowCount = shown.reduce((n, g) => n + g.rows.length, 0);

  const tooltip = (row: Row, column: Column, cell: Cell): string => {
    const check = cellCheck(row, column, namespace);
    const values = {
      verb: check.verb,
      resource: resourceRef(check),
      namespace,
    };
    const what = row.gvk.namespaced
      ? i18n.t('{verb} {resource} in {namespace}', values)
      : i18n.t('{verb} {resource} (cluster-wide)', values);
    switch (cell) {
      case 'allowed':
        return i18n.t('{what}: allowed', { what });
      case 'restricted':
        return i18n.t('{what}: only {names}', {
          what,
          names: rules ? allowedNames(rules, check).join(', ') : '',
        });
      case 'denied':
        return i18n.t('{what}: denied', { what });
      case 'unverified':
        return i18n.t('{what}: not in the listed rules; another authorizer may allow it', {
          what,
        });
      case 'pending':
        return i18n.t('{what}: checking…', { what });
      case 'unsupported':
        return i18n.t('{resource} does not support {verb}', values);
      case 'unknown':
        return i18n.t('{what}: unknown', { what });
      default:
        return '';
    }
  };

  return (
    <section className="border-border bg-surface-raised/40 rounded-lg border">
      <div className="border-border/60 flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Tabs
          tabs={[
            { key: 'matrix', label: i18n.t('Matrix') },
            { key: 'rules', label: i18n.t('Rules') },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'matrix' && (
          <>
            <div className="bg-surface border-border focus-within:border-accent/50 flex h-7 w-52 min-w-28 items-center gap-2 rounded-lg border px-2.5 transition-colors">
              <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                placeholder={i18n.t('Filter kinds…')}
                aria-label={i18n.t('Filter kinds')}
                className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={i18n.t('Clear filter')}
                  className="text-fg-dim hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <FilterChip
              active={only === 'allowed'}
              onClick={() => setOnly(only === 'allowed' ? null : 'allowed')}
              icon={<Check className="text-status-running" />}
              label={i18n.t('Only allowed')}
            />
            <FilterChip
              active={only === 'denied'}
              onClick={() => setOnly(only === 'denied' ? null : 'denied')}
              icon={<X className="text-status-error" />}
              label={i18n.t('Only denied')}
            />
            <span className="text-fg-dim text-[11px] tabular-nums">
              {i18n.plural('{count} kind', '{count} kinds', rowCount)}
            </span>
          </>
        )}
        <Legend incomplete={!!rules?.incomplete} />
      </div>
      {rules?.incomplete && (
        <div className="border-status-starting/25 bg-status-starting/8 flex items-start gap-2.5 border-b px-3 py-2.5 text-[12px]">
          <TriangleAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-fg font-medium">{i18n.t('The rules review is incomplete')}</p>
            <p className="text-fg-muted mt-0.5 leading-relaxed">
              {i18n.t(
                'An authorizer on this cluster cannot list its rules, so cells marked ? may still be allowed. Verify asks the API server about each of them.',
              )}
              {rules.evaluation_error && (
                <span className="text-fg-dim mt-1 block font-mono text-[11px] break-words">
                  {rules.evaluation_error}
                </span>
              )}
            </p>
          </div>
          {!verifying && (
            <Button size="xs" variant="secondary" onClick={() => setVerifying(true)}>
              {i18n.t('Verify')}
            </Button>
          )}
        </div>
      )}
      {error && !rules && (
        <div className="border-status-error/25 bg-status-error/8 flex items-start gap-2.5 border-b px-3 py-2.5 text-[12px]">
          <ShieldQuestion className="text-status-error mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p className="text-fg-muted min-w-0 flex-1 break-words">
            {i18n.t('Could not load the rules review: {error}', { error })}
          </p>
        </div>
      )}
      {tab === 'rules' ? (
        <RulesTab rules={rules} loading={loading} />
      ) : (
        <div className="overflow-x-auto">
          <div
            role="table"
            aria-label={i18n.t('Permission matrix')}
            style={{ minWidth: MIN_WIDTH }}
          >
            <div
              role="row"
              style={{ gridTemplateColumns: TEMPLATE }}
              className="border-border/70 text-fg-dim bg-surface/95 sticky top-0 z-10 grid h-8 items-center border-b px-4"
            >
              <span
                role="columnheader"
                className="text-[10.5px] font-semibold tracking-[0.08em] uppercase"
              >
                {i18n.t('Kind')}
              </span>
              {VERB_COLUMNS.map((c) => (
                <span
                  key={c.id}
                  role="columnheader"
                  className="text-center font-mono text-[10.5px]"
                >
                  {c.verb}
                </span>
              ))}
              <span aria-hidden className="bg-border/70 mx-auto h-4 w-px" />
              {COLUMNS.filter((c) => c.podOnly).map((c) => (
                <span
                  key={c.id}
                  role="columnheader"
                  title={i18n.t('Pods only: {verb} pods/{subresource}', {
                    verb: c.verb,
                    subresource: c.subresource ?? '',
                  })}
                  className="text-accent/80 text-center font-mono text-[10.5px]"
                >
                  {c.id}
                </span>
              ))}
            </div>
            {shown.map((g) => (
              <div key={g.id} role="rowgroup">
                <div
                  role="row"
                  className="text-fg-dim bg-fg/[0.025] border-border/40 border-b px-4 py-1.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
                >
                  <span role="cell">{g.label}</span>
                </div>
                {g.rows.map((row) => {
                  const Icon = row.icon;
                  return (
                    <div
                      key={row.key}
                      role="row"
                      style={{ gridTemplateColumns: TEMPLATE }}
                      className="border-border/40 hover:bg-fg/4 group grid h-8 items-center border-b px-4 text-[12px]"
                    >
                      <span role="cell" className="flex min-w-0 items-center gap-2">
                        <Icon className="text-fg-dim group-hover:text-fg-muted h-3.5 w-3.5 shrink-0" />
                        <button
                          type="button"
                          onClick={() =>
                            useWorkbenchStore.getState().setActiveKind(clusterId, row.key)
                          }
                          title={i18n.t('Open {kind}', { kind: row.label })}
                          className="text-fg min-w-0 truncate text-left hover:underline"
                        >
                          {row.label}
                        </button>
                        {!row.gvk.namespaced && (
                          <span className="bg-fg/5 text-fg-dim shrink-0 rounded px-1 py-px text-[9.5px] font-medium">
                            {i18n.t('cluster')}
                          </span>
                        )}
                      </span>
                      {VERB_COLUMNS.map((c) => {
                        const cell = cellOf(row, c);
                        return <MatrixCell key={c.id} cell={cell} title={tooltip(row, c, cell)} />;
                      })}
                      <span aria-hidden />
                      {COLUMNS.filter((c) => c.podOnly).map((c) => {
                        const cell = cellOf(row, c);
                        return <MatrixCell key={c.id} cell={cell} title={tooltip(row, c, cell)} />;
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
            {!rowCount && (
              <p className="text-fg-dim px-4 py-8 text-center text-[12px]">
                {i18n.t('No kinds match the filter.')}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const CELL: Record<Cell, { icon: LucideIcon | null; className: string }> = {
  allowed: { icon: Check, className: 'text-status-running' },
  restricted: { icon: Contrast, className: 'text-status-starting' },
  denied: { icon: X, className: 'text-status-error/70' },
  unverified: { icon: CircleHelp, className: 'text-fg-dim' },
  pending: { icon: null, className: '' },
  unknown: { icon: null, className: '' },
  unsupported: { icon: Minus, className: 'text-fg-dim/40' },
  none: { icon: null, className: '' },
};

function MatrixCell({ cell, title }: { cell: Cell; title: string }) {
  const { icon: Icon, className } = CELL[cell];
  return (
    <span
      role="cell"
      title={title || undefined}
      aria-label={title || undefined}
      className="flex h-full items-center justify-center"
    >
      {Icon ? (
        <Icon
          className={cn('h-3.5 w-3.5', className)}
          strokeWidth={cell === 'allowed' || cell === 'denied' ? 2.5 : 2}
        />
      ) : cell === 'pending' ? (
        <span className="bg-fg/20 h-1.5 w-1.5 animate-pulse rounded-full" />
      ) : cell === 'unknown' ? (
        <span className="text-fg-dim/60">·</span>
      ) : null}
    </span>
  );
}

function FilterChip({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-app-sm flex h-7 shrink-0 items-center gap-1.5 border px-2 text-[11.5px] font-medium whitespace-nowrap transition [&>svg]:h-3 [&>svg]:w-3',
        active
          ? 'border-accent/50 bg-accent/10 text-accent'
          : 'border-border bg-surface-muted/70 text-fg-muted hover:text-fg hover:bg-surface-overlay',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Legend({ incomplete }: { incomplete: boolean }) {
  i18n.useLocale();
  const items: Array<[Cell, string]> = [
    ['allowed', i18n.t('Allowed')],
    ['restricted', i18n.t('Specific names only')],
    ['denied', i18n.t('Denied')],
    ...(incomplete ? ([['unverified', i18n.t('Unverified')]] as Array<[Cell, string]>) : []),
    ['unsupported', i18n.t('Not served')],
  ];
  return (
    <div className="text-fg-dim ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      {items.map(([cell, label]) => {
        const { icon: Icon, className } = CELL[cell];
        return (
          <span key={cell} className="inline-flex items-center gap-1">
            {Icon && <Icon className={cn('h-3 w-3', className)} strokeWidth={2.5} />}
            {label}
          </span>
        );
      })}
    </div>
  );
}

function RulesTab({ rules, loading }: { rules: AccessRules | null; loading: boolean }) {
  i18n.useLocale();
  if (!rules)
    return (
      <p className="text-fg-dim px-4 py-8 text-center text-[12px]">
        {loading ? i18n.t('Loading…') : i18n.t('No rules available.')}
      </p>
    );
  const list = (values: string[], empty = '—') => values.join(', ') || empty;
  return (
    <div className="space-y-4 p-4">
      <MiniTable
        rows={rules.resource_rules}
        rowKey={(_, i) => String(i)}
        empty={i18n.t('No rules')}
        columns={[
          {
            label: i18n.t('Verbs'),
            cell: (r) => <span className="text-fg">{list(r.verbs)}</span>,
          },
          {
            label: i18n.t('API groups'),
            cell: (r) => <MonoText>{list(r.api_groups.map((g) => g || '""'))}</MonoText>,
          },
          {
            label: i18n.t('Resources'),
            cell: (r) => <MonoText>{list(r.resources)}</MonoText>,
          },
          {
            label: i18n.t('Names'),
            cell: (r) => <MonoText>{list(r.resource_names, '*')}</MonoText>,
          },
        ]}
      />
      {rules.non_resource_rules.length > 0 && (
        <div>
          <h4 className="text-fg-dim mb-2 text-[10.5px] font-semibold tracking-[0.12em] uppercase">
            {i18n.t('Non-resource URLs')}
          </h4>
          <MiniTable
            rows={rules.non_resource_rules}
            rowKey={(_, i) => String(i)}
            columns={[
              {
                label: i18n.t('Verbs'),
                cell: (r) => <span className="text-fg">{list(r.verbs)}</span>,
              },
              {
                label: i18n.t('URLs'),
                cell: (r) => <MonoText>{list(r.non_resource_urls)}</MonoText>,
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
