import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { KubepitMark } from '@/components/ui/KubepitMark';
import { StatusDot } from '@/components/ui/StatusDot';
import { openAndConnect } from '@/lib/clusterActions';
import { connState, environmentMeta } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef } from '@/types';
import {
  appActions,
  clusterActions,
  resourceJumps,
  type PaletteFilter,
  type PaletteItem,
} from './paletteItems';
import { createItems } from './createItems';
import { explainKindItems } from './explainItems';
import { fleetSearchItem } from './fleetSearchItem';
import { updateActions, workbenchItems } from './workbenchItems';
// Power user: custom actions for the selected object / cluster.
import { customActionItems } from './customActionItems';

const FILTERS: Array<{ key: PaletteFilter; label: () => string }> = [
  { key: 'all', label: () => i18n.t('All') },
  { key: 'clusters', label: () => i18n.t('Clusters') },
  { key: 'resources', label: () => i18n.t('Resources') },
  { key: 'actions', label: () => i18n.t('Actions') },
];

function matches(query: string, ...parts: Array<string | undefined | null>) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

const selectable = (item: PaletteItem | undefined) => !!item && item.type !== 'header';

/**
 * In-window command palette (⌘K) styled after RunHQ's Quick Action panel:
 * clusters first, then resource jumps for the active cluster, then app
 * actions. → drills into a cluster's own action list.
 */
export function CommandPalette() {
  i18n.useLocale();
  const close = () => useAppStore.getState().setPaletteOpen(false);
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const sections = useAppStore((s) => s.sections);
  const clusterSection = useAppStore((s) => s.clusterSection);
  const selectedClusterId = useAppStore((s) => s.selectedClusterId);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PaletteFilter>('all');
  const [drill, setDrill] = useState<ClusterDef | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), [drill]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    if (drill) {
      return clusterActions(drill).filter(
        (item) =>
          item.type === 'header' ||
          (item.type === 'action' && matches(q, item.label, item.keywords, item.hint)),
      );
    }
    const out: PaletteItem[] = [];
    if (filter === 'all' || filter === 'clusters') {
      const list = clusters
        .filter((c) => {
          const section = sections.find((s) => s.id === clusterSection[c.id])?.name;
          return matches(q, c.name, c.context, c.environment, section, c.tags.join(' '));
        })
        .sort((a, b) => {
          // Live clusters first, then alphabetical.
          const la = connState(statuses[a.id]) === 'connected' ? 0 : 1;
          const lb = connState(statuses[b.id]) === 'connected' ? 0 : 1;
          return la - lb || a.name.localeCompare(b.name);
        });
      if (list.length) out.push({ type: 'header', id: 'hdr-clusters', label: i18n.t('Clusters') });
      for (const cluster of list)
        out.push({
          type: 'cluster',
          id: `cluster:${cluster.id}`,
          cluster,
          section: sections.find((s) => s.id === clusterSection[cluster.id])?.name ?? null,
        });
    }
    const active = clusters.find((c) => c.id === selectedClusterId);
    if (active && (filter === 'all' || filter === 'resources')) {
      const jumps = [
        ...resourceJumps(active),
        ...explainKindItems(active, q),
        ...createItems(active),
      ].filter((item) => item.type === 'action' && matches(q, item.label, item.keywords));
      // Without a query, keep the list short: resources only when filtered.
      if (jumps.length && (q || filter === 'resources')) {
        out.push({
          type: 'header',
          id: 'hdr-resources',
          label: i18n.t('Resources in {cluster}', { cluster: active.name }),
        });
        out.push(...jumps);
      }
    }
    // Fleet search: any typed text can be searched on every cluster.
    if (q && (filter === 'all' || filter === 'resources')) {
      out.push({ type: 'header', id: 'hdr-fleet', label: i18n.t('Fleet search') });
      out.push(fleetSearchItem(q));
    }
    // Bookmarks, saved views and exports of the focused table.
    out.push(...workbenchItems(q, filter));
    out.push(...customActionItems(q, filter));
    if (filter === 'all' || filter === 'actions') {
      const acts = [...appActions(), ...updateActions()].filter(
        (item) => item.type === 'action' && matches(q, item.label, item.keywords),
      );
      if (acts.length) {
        out.push({ type: 'header', id: 'hdr-actions', label: i18n.t('Actions') });
        out.push(...acts);
      }
    }
    return out;
  }, [query, filter, drill, clusters, statuses, sections, clusterSection, selectedClusterId]);

  // Keep the cursor on a selectable row whenever the list changes.
  useEffect(() => {
    const first = items.findIndex(selectable);
    setCursor(first < 0 ? 0 : first);
  }, [items]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const execute = (item: PaletteItem | undefined) => {
    if (!item || item.type === 'header') return;
    if (item.type === 'cluster') {
      close();
      openAndConnect(item.cluster.id);
      return;
    }
    close();
    item.run();
  };

  const move = (delta: number) => {
    setCursor((i) => {
      for (let n = i + delta; n >= 0 && n < items.length; n += delta) {
        if (selectable(items[n])) return n;
      }
      return i;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (drill) setDrill(null);
      else close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'ArrowRight') {
      const item = items[cursor];
      if (item?.type === 'cluster' && !query.length) {
        e.preventDefault();
        setDrill(item.cluster);
        setQuery('');
      }
    } else if (e.key === 'ArrowLeft' || (e.key === 'Backspace' && !query)) {
      if (drill) {
        e.preventDefault();
        setDrill(null);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(items[cursor]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const idx = FILTERS.findIndex((f) => f.key === filter);
      const next = FILTERS[(idx + (e.shiftKey ? -1 : 1) + FILTERS.length) % FILTERS.length];
      if (next) setFilter(next.key);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh]"
      onClick={close}
    >
      <div
        className="quick-action-panel animate-fade-in flex w-[620px] max-w-[92vw] flex-col overflow-hidden"
        style={{ maxHeight: 'min(560px, 78vh)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3.5">
          {drill ? (
            <button
              type="button"
              onClick={() => setDrill(null)}
              className="text-fg-dim hover:text-fg hover:bg-surface-muted/60 flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition"
              aria-label={i18n.t('Back')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : (
            <KubepitMark className="text-accent h-[18px] w-[18px] shrink-0" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              drill
                ? i18n.t('Actions for {name}…', { name: drill.name })
                : i18n.t('Search clusters, resources, actions…')
            }
            className="text-fg placeholder:text-fg-dim/80 h-7 w-full bg-transparent text-[15px] tracking-[-0.01em]"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>

        {!drill && (
          <div className="border-border/40 flex items-center gap-1 border-y px-3 py-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                  filter === f.key
                    ? 'bg-accent/15 text-accent'
                    : 'text-fg-dim hover:text-fg hover:bg-surface-muted/60',
                )}
              >
                {f.label()}
              </button>
            ))}
          </div>
        )}

        <div ref={listRef} className="qa-list min-h-0 flex-1 overflow-y-auto">
          {items.map((item, index) => {
            if (item.type === 'header')
              return (
                <div key={item.id} className="qa-section-header">
                  {item.label}
                </div>
              );
            const active = index === cursor;
            const row = cn(
              'flex cursor-pointer items-center gap-3 px-4 py-2 transition',
              active ? 'bg-accent/10' : 'hover:bg-surface-muted/50',
            );
            if (item.type === 'cluster') {
              const state = connState(statuses[item.cluster.id]);
              const env = environmentMeta(item.cluster.environment);
              return (
                <div
                  key={item.id}
                  data-active={active ? '' : undefined}
                  className={row}
                  onClick={() => execute(item)}
                  onMouseEnter={() => setCursor(index)}
                >
                  <StatusDot status={state} />
                  <span className="text-fg min-w-0 truncate text-[13px] font-medium">
                    {item.cluster.name}
                  </span>
                  {item.cluster.read_only && <Lock className="text-fg-dim h-3 w-3 shrink-0" />}
                  {item.section && (
                    <span className="text-fg-dim truncate text-[11px]">{item.section}</span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {env && (
                      <span className={cn('font-mono text-[9.5px] font-semibold', env.color)}>
                        {env.short}
                      </span>
                    )}
                    <ChevronRight
                      className={cn(
                        'text-fg-dim h-3.5 w-3.5',
                        active ? 'opacity-100' : 'opacity-0',
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDrill(item.cluster);
                        setQuery('');
                      }}
                    />
                  </span>
                </div>
              );
            }
            const Icon = item.icon;
            return (
              <div
                key={item.id}
                data-active={active ? '' : undefined}
                className={row}
                onClick={() => execute(item)}
                onMouseEnter={() => setCursor(index)}
              >
                <Icon className="text-fg-dim h-3.5 w-3.5 shrink-0" />
                <span className="text-fg min-w-0 truncate text-[12.5px]">{item.label}</span>
                {item.hint && (
                  <span className="text-fg-dim ml-auto truncate font-mono text-[10.5px]">
                    {item.hint}
                  </span>
                )}
              </div>
            );
          })}
          {items.length === 0 && (
            <p className="text-fg-dim px-4 py-8 text-center text-[12px]">
              {i18n.t('Nothing matches “{query}”.', { query })}
            </p>
          )}
        </div>

        <div className="border-border/30 bg-surface-muted/30 border-t px-4 py-1.5">
          <div className="text-fg-dim flex items-center gap-3 text-[10px]">
            <span>{i18n.t('↑↓ navigate')}</span>
            <span>{i18n.t('⏎ select')}</span>
            {drill ? <span>{i18n.t('← back')}</span> : <span>{i18n.t('→ cluster actions')}</span>}
            {!drill && <span>{i18n.t('↹ category')}</span>}
            <span>{i18n.t('esc close')}</span>
            <span className="ml-auto flex items-center gap-1">
              <KubepitMark className="text-accent h-2.5 w-2.5" />
              Kubepit
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
