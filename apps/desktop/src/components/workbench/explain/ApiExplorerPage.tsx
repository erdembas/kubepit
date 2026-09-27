import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useCallback, useDeferredValue, useEffect, useState, type ReactNode } from 'react';
import {
  BookOpenText,
  ChevronsDownUp,
  ChevronsUpDown,
  FileQuestion,
  Loader2,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { fieldAtPath, type FieldInfo } from '@/lib/kube/schema/fields';
import { kindEntries, versionsOf, type KindEntry } from '@/lib/kube/schema/kinds';
import {
  ancestorIds,
  expandableIds,
  filteredRows,
  rowId,
  visibleRows,
  type TreeRow,
} from '@/lib/kube/schema/tree';
import { cn } from '@/lib/cn';
import { useExplainStore, type ExplainTarget } from '@/store/useExplainStore';
import type { ApiResourceInfo } from '@/types';
import { FieldDetails } from './FieldDetails';
import { FieldTree } from './FieldTree';
import { KindList } from './KindList';
import { useExplainData } from './useExplainData';

/** Deployment when served, else the first kind: something useful on first open. */
function defaultTarget(kinds: KindEntry[]): ExplainTarget | null {
  const pick = kinds.find((k) => k.group === 'apps' && k.kind === 'Deployment') ?? kinds[0];
  return pick ? { apiVersion: pick.apiVersion, kind: pick.kind } : null;
}

function ExplainState({
  icon,
  tone = 'bg-fg/5 text-fg-dim',
  title,
  message,
  children,
}: {
  icon: ReactNode;
  tone?: string;
  title: string;
  message?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div
          className={cn(
            'mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl [&>svg]:h-5 [&>svg]:w-5',
            tone,
          )}
        >
          {icon}
        </div>
        <h3 className="text-fg text-[13.5px] font-semibold">{title}</h3>
        {message && (
          <p className="text-fg-muted mt-1.5 text-[12px] leading-relaxed break-words whitespace-pre-line">
            {message}
          </p>
        )}
        {children && <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>}
      </div>
    </div>
  );
}

/**
 * API explorer ("explain"): every kind the cluster serves, builtins and
 * CRDs, with its schema as a browsable, searchable field tree — like
 * `kubectl explain --recursive` — and the selected field's details.
 */
export function ApiExplorerPage({
  clusterId,
  isActive,
  apiResources,
}: {
  clusterId: string;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const kinds = useMemo(() => kindEntries(apiResources), [apiResources]);
  const stored = useExplainStore((s) => s.target[clusterId] ?? null);
  const focus = useExplainStore((s) => s.focus[clusterId] ?? null);
  const setTarget = useExplainStore((s) => s.setTarget);
  const target = stored ?? defaultTarget(kinds);
  const [refreshKey, setRefreshKey] = useState(0);
  const { index, indexError, schema } = useExplainData(clusterId, target, refreshKey, isActive);

  const [kindQuery, setKindQuery] = useState('');
  const [fieldQuery, setFieldQuery] = useState('');
  const deferredQuery = useDeferredValue(fieldQuery);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string[] | null>(null);
  const [revealKey, setRevealKey] = useState(0);

  const targetKey = target ? `${target.apiVersion}/${target.kind}` : '';
  useEffect(() => {
    setExpanded(new Set());
    setSelected(null);
    setFieldQuery('');
  }, [targetKey]);

  // Reveal a field requested from an editor or a link.
  useEffect(() => {
    if (!focus) return;
    setFieldQuery('');
    setSelected(focus.path.length ? focus.path : null);
    setExpanded((prev) => new Set([...prev, ...ancestorIds(focus.path)]));
    setRevealKey((n) => n + 1);
  }, [focus]);

  const entry = useMemo(() => {
    if (!target) return null;
    const group = target.apiVersion.includes('/') ? target.apiVersion.split('/')[0]! : '';
    return kinds.find((k) => k.group === group && k.kind === target.kind) ?? null;
  }, [kinds, target]);
  const versions = useMemo(
    () =>
      target && entry
        ? versionsOf(index, entry.group, target.apiVersion).map((v) => ({ value: v, label: v }))
        : [],
    [index, entry, target],
  );

  const resolution = schema.status === 'done' ? schema.resolution : null;
  const ok = resolution?.status === 'ok' ? resolution : null;
  const filtering = deferredQuery.trim().length > 0;
  const rows = useMemo<TreeRow[]>(() => {
    if (!ok) return [];
    return filtering
      ? filteredRows(ok.set, ok.root, deferredQuery)
      : visibleRows(ok.set, ok.root, expanded);
  }, [ok, filtering, deferredQuery, expanded]);

  // The deepest part of the selected path the schema knows.
  const selectedField = useMemo<FieldInfo | null>(() => {
    if (!ok || !selected) return null;
    for (let n = selected.length; n > 0; n--) {
      const field = fieldAtPath(ok.set, ok.root, selected.slice(0, n));
      if (field) return field;
    }
    return null;
  }, [ok, selected]);
  const selectedId = selectedField ? rowId(selectedField.path) : null;

  const pickKind = (kind: KindEntry) =>
    setTarget(clusterId, { apiVersion: kind.apiVersion, kind: kind.kind });
  const toggle = useCallback((row: TreeRow, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(row.id)) next.add(row.id);
      else next.delete(row.id);
      return next;
    });
  }, []);
  const openField = useCallback((field: FieldInfo) => {
    setSelected(field.path);
    setExpanded((prev) => new Set([...prev, ...ancestorIds(field.path)]));
    setRevealKey((n) => n + 1);
  }, []);
  const clearFilter = () => {
    setFieldQuery('');
    if (selectedField) openField(selectedField);
  };
  const refresh = () => setRefreshKey((n) => n + 1);

  let body: ReactNode;
  if (!apiResources) {
    body = (
      <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {i18n.t('Discovering API resources…')}
      </div>
    );
  } else if (!target) {
    body = <ExplainState icon={<BookOpenText />} title={i18n.t('Pick a kind to explore')} />;
  } else if (indexError && !ok) {
    body = (
      <ExplainState
        icon={<TriangleAlert />}
        tone="bg-status-error/12 text-status-error"
        title={i18n.t('Could not load the cluster’s API schemas')}
        message={indexError}
      >
        <Button size="sm" variant="secondary" onClick={refresh}>
          {i18n.t('Retry')}
        </Button>
      </ExplainState>
    );
  } else if (!resolution) {
    body = (
      <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {i18n.t('Loading the schema of {kind}…', { kind: target.kind })}
      </div>
    );
  } else if (!ok) {
    body = (
      <ExplainState
        icon={<FileQuestion />}
        title={i18n.t('No schema for {kind}', { kind: target.kind })}
        message={
          resolution.status === 'unknown-kind'
            ? i18n.t('{apiVersion} does not serve {kind} on this cluster.', {
                apiVersion: target.apiVersion,
                kind: target.kind,
              })
            : resolution.status === 'unknown-version'
              ? i18n.t('This cluster does not serve {apiVersion}.', {
                  apiVersion: target.apiVersion,
                })
              : i18n.t('The cluster publishes no OpenAPI schema for {apiVersion} {kind}.', {
                  apiVersion: target.apiVersion,
                  kind: target.kind,
                })
        }
      >
        <Button size="sm" variant="secondary" onClick={refresh}>
          {i18n.t('Reload schemas')}
        </Button>
      </ExplainState>
    );
  } else if (filtering && rows.length === 0) {
    body = (
      <ExplainState
        icon={<Search />}
        title={i18n.t('No matching fields')}
        message={i18n.t('No field of {kind} matches "{query}".', {
          kind: target.kind,
          query: deferredQuery.trim(),
        })}
      >
        <Button size="sm" variant="secondary" onClick={clearFilter}>
          {i18n.t('Clear filter')}
        </Button>
      </ExplainState>
    );
  } else {
    body = (
      <FieldTree
        rows={rows}
        selectedId={selectedId}
        revealKey={revealKey}
        filtering={filtering}
        onSelect={(row) => setSelected(row.field.path)}
        onToggle={toggle}
      />
    );
  }

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2">
        <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
          <BookOpenText className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg hidden shrink-0 text-[13px] font-semibold @lg:block">
          {i18n.t('API Explorer')}
        </h2>
        {target && (
          <>
            <span aria-hidden className="bg-border/70 mx-1 hidden h-4 w-px shrink-0 @lg:block" />
            <span className="text-fg shrink-0 font-mono text-[12.5px] font-medium">
              {target.kind}
            </span>
            {versions.length > 1 ? (
              <Select
                ariaLabel={i18n.t('API version')}
                value={target.apiVersion}
                onChange={(apiVersion) => setTarget(clusterId, { apiVersion, kind: target.kind })}
                options={versions}
                className="h-6.5 max-w-48 shrink-0 font-mono"
              />
            ) : (
              <span className="text-fg-dim border-border/70 shrink-0 rounded border px-1 font-mono text-[10.5px] leading-4">
                {target.apiVersion}
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-1.5">
          <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-60 min-w-24 shrink items-center gap-2 rounded-lg border px-2.5 transition-colors">
            <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
            <input
              value={fieldQuery}
              onChange={(e) => setFieldQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && clearFilter()}
              disabled={!ok}
              placeholder={i18n.t('Search fields (name or a.b.path)…')}
              aria-label={i18n.t('Search fields')}
              className="dashboard-search-input text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            />
            {fieldQuery && (
              <button
                type="button"
                onClick={clearFilter}
                aria-label={i18n.t('Clear filter')}
                className="text-fg-dim hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <IconButton
            label={i18n.t('Expand all')}
            icon={<ChevronsUpDown />}
            disabled={!ok || filtering}
            onClick={() => ok && setExpanded(expandableIds(ok.set, ok.root))}
          />
          <IconButton
            label={i18n.t('Collapse all')}
            icon={<ChevronsDownUp />}
            disabled={!ok || filtering || expanded.size === 0}
            onClick={() => setExpanded(new Set())}
          />
          <IconButton
            label={i18n.t('Reload schemas')}
            icon={<RefreshCw className={cn(schema.status === 'loading' && 'animate-spin')} />}
            onClick={refresh}
          />
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <KindList
          kinds={kinds}
          activeKey={entry?.key ?? null}
          query={kindQuery}
          onQuery={setKindQuery}
          onPick={pickKind}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
        {ok && target && (
          <FieldDetails
            set={ok.set}
            root={ok.root}
            entry={entry}
            apiVersion={target.apiVersion}
            field={selectedField}
            onOpen={openField}
          />
        )}
      </div>
    </div>
  );
}
