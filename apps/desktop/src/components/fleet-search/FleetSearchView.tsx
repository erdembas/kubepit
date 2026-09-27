import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Plug, ScanSearch, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { Select, type SelectOption } from '@/components/ui/Select';
import { connectCluster } from '@/lib/clusterActions';
import { ENVIRONMENTS } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { SEARCH_KINDS, isBroad } from '@/lib/fleet/searchQuery';
import { openObject } from '@/lib/navigation';
import { IS_MAC } from '@/lib/platform';
import { sectionColor } from '@/lib/sectionColors';
import { useVisibleStore } from '@/lib/useVisibleStore';
import { useAppStore } from '@/store/useAppStore';
import {
  searchSignature,
  targetClusters,
  useFleetSearchStore,
  type SearchScope,
} from '@/store/useFleetSearchStore';
import type { ClusterEnvironment } from '@/types';
import { ResultGroup, rowKey, type Row } from './ResultGroup';
import { EXAMPLES, SyntaxHints } from './SyntaxHints';

/** Environment → CSS colour for the scope select's dot. */
const ENV_COLOR: Record<string, string> = {
  production: 'rgb(var(--status-error))',
  staging: 'rgb(var(--status-starting))',
  testing: 'rgb(var(--cat-backend))',
  development: 'rgb(var(--cat-frontend))',
  local: 'rgb(var(--status-running))',
};

function scopeValue(scope: SearchScope): string {
  if (scope.kind === 'section') return `section:${scope.id}`;
  if (scope.kind === 'environment') return `env:${scope.env}`;
  return 'all';
}

function parseScope(value: string): SearchScope {
  if (value.startsWith('section:')) return { kind: 'section', id: value.slice(8) };
  if (value.startsWith('env:'))
    return { kind: 'environment', env: value.slice(4) as ClusterEnvironment };
  return { kind: 'all' };
}

export const SHORTCUT = IS_MAC ? '⌘⇧F' : 'Ctrl+Shift+F';

/**
 * Fleet search: one query, every connected cluster. Results stream in per
 * cluster; ↑↓ move through them from the search box and ⏎ opens the object
 * in its cluster's workbench.
 */
export function FleetSearchView({ visible }: { visible: boolean }) {
  i18n.useLocale();
  const clusters = useVisibleStore(useAppStore, (s) => s.clusters, visible);
  const statuses = useVisibleStore(useAppStore, (s) => s.statuses, visible);
  const sections = useVisibleStore(useAppStore, (s) => s.sections, visible);
  const clusterSection = useVisibleStore(useAppStore, (s) => s.clusterSection, visible);
  const input = useFleetSearchStore((s) => s.input);
  const kinds = useFleetSearchStore((s) => s.kinds);
  const scope = useFleetSearchStore((s) => s.scope);
  const running = useFleetSearchStore((s) => s.running);
  const error = useFleetSearchStore((s) => s.error);
  const query = useFleetSearchStore((s) => s.query);
  const parsed = useFleetSearchStore((s) => s.parsed);
  const order = useFleetSearchStore((s) => s.order);
  const results = useFleetSearchStore((s) => s.results);
  const startedAt = useFleetSearchStore((s) => s.startedAt);
  const finishedAt = useFleetSearchStore((s) => s.finishedAt);
  const focusToken = useFleetSearchStore((s) => s.focusToken);
  const { setInput, toggleKind, setScope, run, cancel, reset } = useFleetSearchStore.getState();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible, focusToken]);

  // Search as you type (debounced); cleared input returns to the landing page.
  useEffect(() => {
    if (!visible) return;
    if (!input.trim()) {
      if (useFleetSearchStore.getState().signature) reset();
      return;
    }
    if (useFleetSearchStore.getState().signature === searchSignature(input, kinds, scope)) return;
    const timer = window.setTimeout(() => void run(), 280);
    return () => window.clearTimeout(timer);
  }, [input, kinds, scope, visible, run, reset]);

  const byId = useMemo(() => new Map(clusters.map((c) => [c.id, c])), [clusters]);
  const rows = useMemo<Row[]>(
    () =>
      order.flatMap((id) =>
        collapsed[id] ? [] : (results[id]?.items ?? []).map((item) => ({ clusterId: id, item })),
      ),
    [order, results, collapsed],
  );
  const activeIndex = Math.max(
    0,
    rows.findIndex((r) => rowKey(r) === activeKey),
  );
  const active = rows[activeIndex];

  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  const open = (row: Row | undefined) => {
    if (!row) return;
    openObject(row.clusterId, row.item.gvk.kind, row.item.namespace, row.item.name);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = rows[Math.min(rows.length - 1, Math.max(0, activeIndex + step))];
      if (next) setActiveKey(rowKey(next));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const stale =
        useFleetSearchStore.getState().signature !== searchSignature(input, kinds, scope);
      if (stale || !active) void run();
      else open(active);
    } else if (e.key === 'Escape') {
      if (input) {
        e.preventDefault();
        setInput('');
      } else inputRef.current?.blur();
    }
  };

  const insertToken = (token: string) => {
    const base = input.trim();
    setInput(base ? `${base} ${token}` : token);
    inputRef.current?.focus();
  };

  const connectedCount = clusters.filter((c) => statuses[c.id]?.state === 'connected').length;
  const scopeTargets = targetClusters(clusters, scope, clusterSection, null);
  const scopeConnected = scopeTargets.filter((c) => statuses[c.id]?.state === 'connected');
  const scopeOffline = scopeTargets.filter((c) => statuses[c.id]?.state !== 'connected');
  const total = order.reduce((n, id) => n + (results[id]?.items.length ?? 0), 0);
  const withHits = order.filter((id) => results[id]?.items.length).length;
  const searched = order.filter((id) => results[id]?.state !== 'skipped');
  const skipped = order.filter((id) => results[id]?.state === 'skipped');
  const truncated = order.some((id) => results[id]?.truncated);
  const elapsed = ((finishedAt ?? Date.now()) - startedAt) / 1000;
  const kindOverride = !!parsed?.kinds.length && query === input;

  const scopeOptions: SelectOption[] = [
    { value: 'all', label: i18n.t('All clusters') },
    ...sections.map((s) => ({
      value: `section:${s.id}`,
      label: s.name,
      description: i18n.t('Section'),
      color: sectionColor(s.color).solid,
    })),
    ...ENVIRONMENTS.filter((env) => clusters.some((c) => c.environment === env.key)).map((env) => ({
      value: `env:${env.key}`,
      label: env.label,
      description: i18n.t('Environment'),
      color: ENV_COLOR[env.key],
    })),
  ];

  return (
    <div className="bg-surface relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[260px]"
        style={{
          background:
            'radial-gradient(800px 260px at 50% -30%, rgb(var(--accent) / 0.07), transparent 70%)',
        }}
      />
      <header className="relative mx-auto w-full max-w-5xl shrink-0 px-8 pt-7 pb-3">
        <div className="text-fg-dim mb-3 flex items-center gap-2 text-[11px] tabular-nums">
          <span className="bg-accent/15 text-accent inline-flex h-5 w-5 items-center justify-center rounded-md">
            <ScanSearch className="h-3.5 w-3.5" />
          </span>
          <span className="text-fg-muted font-semibold tracking-[0.22em] uppercase">
            {i18n.t('Fleet search')}
          </span>
          <span className="text-fg-dim/40">·</span>
          <span>
            {i18n.t('{connected} of {total} clusters connected', {
              connected: connectedCount,
              total: clusters.length,
            })}
          </span>
          <Kbd className="ml-auto">{SHORTCUT}</Kbd>
        </div>

        <div className="border-border/80 bg-surface-raised/70 focus-within:border-accent/45 flex h-11 items-center gap-2.5 rounded-xl border px-3.5 transition focus-within:shadow-[0_0_0_3px_rgb(var(--accent)/0.10)]">
          {running ? (
            <Loader2 className="text-accent h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <ScanSearch className="text-fg-dim h-4 w-4 shrink-0" />
          )}
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={i18n.t('Search every connected cluster by name, label, kind…')}
            aria-label={i18n.t('Fleet search')}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="text-fg placeholder:text-fg-dim/80 h-full min-w-0 flex-1 bg-transparent font-mono text-[13.5px] tracking-[-0.01em] outline-none"
          />
          {running && (
            <button
              type="button"
              onClick={cancel}
              className="text-fg-dim hover:text-fg hover:bg-fg/6 flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              {i18n.t('Stop')}
            </button>
          )}
          {input && (
            <button
              type="button"
              aria-label={i18n.t('Clear search')}
              onClick={() => {
                setInput('');
                inputRef.current?.focus();
              }}
              className="text-fg-dim hover:text-fg hover:bg-fg/6 flex h-6 w-6 items-center justify-center rounded-md"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <SyntaxHints onInsert={insertToken} parsed={query === input ? parsed : null} />

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {SEARCH_KINDS.map(({ def, label }) => {
            const on = kinds.includes(def.key);
            return (
              <button
                key={def.key}
                type="button"
                aria-pressed={on}
                disabled={kindOverride}
                onClick={() => toggleKind(def.key)}
                title={kindOverride ? i18n.t('kind: in the query overrides these') : undefined}
                className={cn(
                  'rounded-md px-2 py-0.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
                  on
                    ? 'bg-accent/15 text-accent ring-accent/25 ring-1'
                    : 'text-fg-dim hover:text-fg hover:bg-fg/5 ring-border/70 ring-1',
                )}
              >
                {label}
              </button>
            );
          })}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.08em] uppercase">
              {i18n.t('Scope')}
            </span>
            <Select
              value={scopeValue(scope)}
              onChange={(v) => setScope(parseScope(v))}
              options={scopeOptions}
              ariaLabel={i18n.t('Search scope')}
              className="min-w-[150px]"
            />
          </div>
        </div>
      </header>

      <div
        ref={listRef}
        className="overlay-scroll relative min-h-0 flex-1 overflow-y-auto"
        role="listbox"
        aria-label={i18n.t('Search results')}
      >
        <div className="mx-auto w-full max-w-5xl px-8 pb-10">
          {error && (
            <p className="bg-status-error/8 text-status-error border-status-error/20 mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
          {!query && !error && (
            <Landing
              connected={scopeConnected.length}
              offline={scopeOffline.length}
              onExample={(q) => {
                setInput(q);
                inputRef.current?.focus();
              }}
              onConnectAll={() => {
                for (const c of scopeOffline) void connectCluster(c.id, { quiet: true });
              }}
            />
          )}
          {query && !error && (
            <>
              <div className="border-border/60 text-fg-dim mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 text-[11.5px] tabular-nums">
                <span className="text-fg-muted">
                  {i18n.plural('{count} result', '{count} results', total)}
                </span>
                <span>
                  {i18n.t('in {hits} of {searched} clusters', {
                    hits: withHits,
                    searched: searched.length,
                  })}
                </span>
                <span>
                  {running
                    ? i18n.t('searching…')
                    : i18n.t('{seconds} s', {
                        seconds: i18n.number(elapsed, { maximumFractionDigits: 1 }),
                      })}
                </span>
                {truncated && (
                  <span className="text-status-starting">
                    {i18n.t('Some kinds show only their first 200 matches; refine the query.')}
                  </span>
                )}
                {parsed && isBroad(parsed) && !running && (
                  <span>{i18n.t('Tip: add a name or label to narrow this down.')}</span>
                )}
                {skipped.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      for (const id of skipped) void connectCluster(id, { quiet: true });
                    }}
                    className="text-fg-dim hover:text-accent ml-auto inline-flex items-center gap-1"
                  >
                    <Plug className="h-3 w-3" />
                    {i18n.plural(
                      'Connect {count} skipped cluster',
                      'Connect {count} skipped clusters',
                      skipped.length,
                    )}
                  </button>
                )}
              </div>
              {order.map((id) => {
                const cluster = byId.get(id);
                const result = results[id];
                if (!cluster || !result) return null;
                return (
                  <ResultGroup
                    key={id}
                    cluster={cluster}
                    result={result}
                    query={query}
                    collapsed={!!collapsed[id]}
                    onToggle={() => setCollapsed((c) => ({ ...c, [id]: !c[id] }))}
                    activeKey={active ? rowKey(active) : null}
                    onActivate={setActiveKey}
                    onOpen={open}
                  />
                );
              })}
              {!running && total === 0 && searched.length > 0 && (
                <p className="text-fg-dim py-10 text-center text-[12px]">
                  {i18n.t('Nothing matches “{query}” on {count} clusters.', {
                    query,
                    count: searched.length,
                  })}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {query && rows.length > 0 && (
        <footer className="border-border/40 bg-surface-muted/30 text-fg-dim flex shrink-0 items-center gap-3 border-t px-8 py-1.5 text-[10px]">
          <span>{i18n.t('↑↓ navigate')}</span>
          <span>{i18n.t('⏎ open in workbench')}</span>
          <span>{i18n.t('esc clear')}</span>
        </footer>
      )}
    </div>
  );
}

function Landing({
  connected,
  offline,
  onExample,
  onConnectAll,
}: {
  connected: number;
  offline: number;
  onExample: (query: string) => void;
  onConnectAll: () => void;
}) {
  i18n.useLocale();
  return (
    <div className="glass animate-fade-in mx-auto mt-6 max-w-xl p-6">
      <h2 className="text-fg text-[15px] font-semibold tracking-tight">
        {i18n.t('One query, every cluster')}
      </h2>
      <p className="text-fg-muted mt-1.5 text-[12.5px] leading-relaxed">
        {i18n.t(
          'Kubepit lists object names (metadata only) on every connected cluster in parallel and streams the matches in as each cluster answers.',
        )}
      </p>
      {connected === 0 ? (
        <div className="mt-4 flex items-center gap-3">
          <p className="text-status-starting text-[12px]">
            {i18n.t('No cluster in this scope is connected yet.')}
          </p>
          {offline > 0 && (
            <Button
              size="xs"
              variant="secondary"
              leftIcon={<Plug className="h-3 w-3" />}
              onClick={onConnectAll}
            >
              {i18n.plural('Connect {count} cluster', 'Connect {count} clusters', offline)}
            </Button>
          )}
        </div>
      ) : null}
      <h3 className="text-fg-dim mt-5 mb-2 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
        {i18n.t('Try')}
      </h3>
      <ul className="space-y-0.5">
        {EXAMPLES().map((ex) => (
          <li key={ex.query}>
            <button
              type="button"
              onClick={() => onExample(ex.query)}
              className="hover:bg-fg/5 group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition"
            >
              <code className="text-accent min-w-[190px] font-mono text-[12px]">{ex.query}</code>
              <span className="text-fg-dim group-hover:text-fg-muted text-[11.5px]">
                {ex.description}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
