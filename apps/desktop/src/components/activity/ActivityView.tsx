import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import { useState } from 'react';
import { CircleSlash, Download, History, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select, type SelectOption } from '@/components/ui/Select';
import { useDebounced } from '@/components/workbench/changes/useChanges';
import { refreshPolledPrefix, usePolled } from '@/components/workbench/data/polled';
import { pickSavePath } from '@/components/workbench/dock/shared/saveFile';
import { downloadText } from '@/components/workbench/dock/shared/platform';
import { useNow } from '@/components/workbench/util';
import { clusterColor } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import {
  AUDIT_ACTIONS,
  AUDIT_RANGES,
  EMPTY_QUERY,
  actionLabel,
  exportFileName,
  groupByDay,
  historySettings,
  isFiltered,
  rangeLabel,
  toFilter,
  type AuditQuery,
  type AuditRange,
} from '@/lib/history/audit';
import { ipc, isTauri } from '@/lib/ipc';
import { useVisibleStore } from '@/lib/useVisibleStore';
import { useAppStore } from '@/store/useAppStore';
import type { AuditAction, AuditEntry, AuditObject, AuditPage } from '@/types';
import { ActivityRow } from './ActivityRow';
import { RevertDialog } from './RevertDialog';

const PAGE = 200;
const MAX_LIMIT = 1000;
const POLL_MS = 5_000;

type Outcome = 'all' | 'ok' | 'error';

/**
 * Activity: every change Kubepit made, on every cluster, from the local
 * audit log (`history.db`). Filters by cluster, action, outcome, text and
 * time; entries expand to their targets and before/after diff, with a
 * reviewed "Revert" where the before-state can be re-applied. The filtered
 * list exports as JSON lines.
 */
export function ActivityView({ visible }: { visible: boolean }) {
  i18n.useLocale();
  const clusters = useVisibleStore(useAppStore, (s) => s.clusters, visible);
  const settings = useVisibleStore(useAppStore, (s) => s.settings, visible);
  const history = historySettings(settings);
  const [query, setQuery] = useState<AuditQuery>(EMPTY_QUERY);
  const [text, setText] = useState('');
  const debounced = useDebounced(text.trim(), 250);
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [revert, setRevert] = useState<{ entry: AuditEntry; object: AuditObject } | null>(null);
  const [exporting, setExporting] = useState(false);
  const now = useNow(30_000, visible);
  const effective: AuditQuery = { ...query, text: debounced };
  const key = `activity|list|${JSON.stringify(effective)}|${limit}`;
  const page = usePolled<AuditPage>(
    visible ? key : null,
    () => ipc.historyAuditList(toFilter(effective, Date.now(), limit)),
    POLL_MS,
    visible,
  );
  const entries = useMemo(() => page.data?.entries ?? [], [page.data]);
  const groups = useMemo(() => groupByDay(entries, now), [entries, now]);
  const total = page.data?.total ?? 0;
  const filtered = isFiltered(effective);

  const set = (patch: Partial<AuditQuery>) => {
    setQuery((q) => ({ ...q, ...patch }));
    setLimit(PAGE);
  };
  const clear = () => {
    setText('');
    setQuery((q) => ({ ...EMPTY_QUERY, range: q.range }));
    setLimit(PAGE);
  };

  const clusterOptions: SelectOption[] = [
    { value: '', label: i18n.t('All clusters') },
    ...clusters.map((c) => ({ value: c.id, label: c.name, color: clusterColor(c) })),
  ];
  const actionOptions: SelectOption[] = [
    { value: '', label: i18n.t('All actions') },
    ...AUDIT_ACTIONS.map((a) => ({ value: a, label: actionLabel(a) })),
  ];
  const outcome: Outcome = query.outcome ?? 'all';

  const exportList = async () => {
    setExporting(true);
    try {
      const jsonl = await ipc.historyAuditExport(toFilter(effective, Date.now(), MAX_LIMIT));
      const name = exportFileName(Date.now());
      if (!isTauri) {
        downloadText(name, jsonl);
        return;
      }
      const path = await pickSavePath(name, {
        name: i18n.t('JSON lines'),
        extensions: ['jsonl', 'json'],
      });
      if (!path) return;
      await ipc.saveTextFile(path, jsonl);
      useAppStore.getState().pushToast('success', i18n.t('Saved {path}', { path }));
    } catch (e) {
      useAppStore.getState().pushToast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const turnOnAudit = async () => {
    if (!settings) return;
    try {
      const saved = await ipc.settingsSet({ ...settings, history: { ...history, audit: true } });
      useAppStore.getState().setSettings(saved);
    } catch (e) {
      useAppStore.getState().pushToast('error', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="bg-surface @container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2">
        <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
          <History className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg shrink-0 text-[13px] font-semibold">{i18n.t('Activity')}</h2>
        <span className="bg-surface-muted text-fg-dim shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {total}
        </span>
        <span className="text-fg-dim hidden min-w-0 truncate text-[11px] @3xl:block">
          {i18n.t('What Kubepit changed on your clusters, recorded on this machine only.')}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <div className="bg-fg/4 inline-flex gap-0.5 rounded-md p-0.5" role="group">
            {(Object.keys(AUDIT_RANGES) as AuditRange[]).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={query.range === r}
                onClick={() => set({ range: r })}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] tabular-nums transition-colors',
                  query.range === r
                    ? 'bg-surface-raised text-fg font-medium shadow-sm'
                    : 'text-fg-dim hover:text-fg',
                )}
              >
                {rangeLabel(r)}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={
              exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )
            }
            disabled={exporting || !entries.length}
            onClick={() => void exportList()}
            title={i18n.t('Export the filtered list as JSON lines')}
            aria-label={i18n.t('Export the filtered list as JSON lines')}
            className="gap-0 @2xl:gap-1.5"
          >
            <span className="hidden @2xl:inline">{i18n.t('Export')}</span>
          </Button>
          <IconButton
            label={i18n.t('Refresh')}
            icon={page.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            onClick={() => refreshPolledPrefix('activity|')}
          />
        </div>
      </div>

      <div className="border-border/60 flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-1.5">
        <div className="bg-surface border-border focus-within:border-accent/50 flex h-7 w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 @lg:w-56">
          <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setLimit(PAGE);
            }}
            placeholder={i18n.t('Filter by object, cluster, user, error…')}
            aria-label={i18n.t('Filter activity')}
            className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
          />
          {text && (
            <button
              type="button"
              onClick={() => setText('')}
              aria-label={i18n.t('Clear filter')}
              className="text-fg-dim hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <Select
          ariaLabel={i18n.t('Cluster')}
          value={query.clusterId ?? ''}
          onChange={(v) => set({ clusterId: v || null })}
          options={clusterOptions}
          className="max-w-[180px]"
        />
        <Select
          ariaLabel={i18n.t('Action')}
          value={query.action ?? ''}
          onChange={(v) => set({ action: (v || null) as AuditAction | null })}
          options={actionOptions}
          className="max-w-[180px]"
        />
        <div className="bg-fg/4 inline-flex gap-0.5 rounded-md p-0.5" role="group">
          {(['all', 'ok', 'error'] as Outcome[]).map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={outcome === o}
              onClick={() => set({ outcome: o === 'all' ? null : o })}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] transition-colors',
                outcome === o
                  ? 'bg-surface-raised text-fg font-medium shadow-sm'
                  : 'text-fg-dim hover:text-fg',
              )}
            >
              {o === 'all' ? i18n.t('All') : o === 'ok' ? i18n.t('Succeeded') : i18n.t('Failed')}
            </button>
          ))}
        </div>
        {filtered && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={clear}>
            {i18n.t('Clear filters')}
          </Button>
        )}
      </div>

      {!history.audit && (
        <div className="border-border/60 bg-fg/3 flex shrink-0 flex-wrap items-center gap-2.5 border-b px-4 py-2 text-[12px]">
          <CircleSlash className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <span className="text-fg-muted min-w-0 flex-1">
            {i18n.t('The audit log is off: new actions are not recorded.')}
          </span>
          <Button size="xs" variant="secondary" onClick={() => void turnOnAudit()}>
            {i18n.t('Turn on')}
          </Button>
        </div>
      )}

      {!page.data ? (
        <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
          {page.error ? (
            <span className="text-status-error px-6 text-center break-words">{page.error}</span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {i18n.t('Loading activity…')}
            </>
          )}
        </div>
      ) : !entries.length ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <div className="bg-fg/5 text-fg-dim mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
              <History className="h-5 w-5" />
            </div>
            <h3 className="text-fg text-[13.5px] font-semibold">
              {filtered ? i18n.t('Nothing matches the filters') : i18n.t('No actions yet')}
            </h3>
            <p className="text-fg-muted mt-1.5 text-[12px] leading-relaxed">
              {filtered
                ? i18n.t('Clear the filters or widen the time range.')
                : i18n.t(
                    'Edits, scaling, deletes, Helm and node operations you run from Kubepit appear here, on every cluster.',
                  )}
            </p>
            {filtered && (
              <Button className="mt-4" size="sm" variant="secondary" onClick={clear}>
                {i18n.t('Clear filters')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="overlay-scroll min-h-0 flex-1 overflow-auto pb-4">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h3 className="border-border/50 bg-surface/95 text-fg-dim sticky top-0 z-10 flex h-8 items-center gap-2 border-b px-4 text-[10.5px] font-semibold tracking-[0.08em] uppercase backdrop-blur">
                {group.label}
                <span className="text-fg-dim/70 tabular-nums">{group.entries.length}</span>
              </h3>
              <ol className="py-1">
                {group.entries.map((entry) => (
                  <ActivityRow
                    key={entry.id}
                    entry={entry}
                    now={now}
                    expanded={expanded === entry.id}
                    onToggle={() => setExpanded((id) => (id === entry.id ? null : entry.id))}
                    onRevert={(e, object) => setRevert({ entry: e, object })}
                  />
                ))}
              </ol>
            </section>
          ))}
          <div className="text-fg-dim flex flex-col items-center gap-2 px-4 pt-4 text-center text-[11px]">
            {page.data.next_cursor !== null && limit < MAX_LIMIT ? (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => setLimit((l) => Math.min(MAX_LIMIT, l + PAGE))}
              >
                {i18n.t('Load older actions')}
              </Button>
            ) : page.data.next_cursor !== null ? (
              <span>
                {i18n.t('Showing the newest actions only. Narrow the filters to see older ones.')}
              </span>
            ) : (
              <span>
                {i18n.plural(
                  'Actions are kept for {count} day.',
                  'Actions are kept for {count} days.',
                  history.audit_retention_days,
                )}
              </span>
            )}
          </div>
        </div>
      )}
      {revert && (
        <RevertDialog entry={revert.entry} object={revert.object} onClose={() => setRevert(null)} />
      )}
    </div>
  );
}
