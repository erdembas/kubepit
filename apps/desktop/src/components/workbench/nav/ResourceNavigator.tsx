import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, EyeOff, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { SECTION_ICONS } from '@/lib/kube/icons';
import { buildNav, flattenNav, type NavGroup, type NavItem } from '@/lib/kube/nav';
import { cn } from '@/lib/cn';
import { useAccessStore } from '@/store/useAccessStore';
import { NAV_WIDTH, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';
import { useKindAccess } from '../access/hooks';
import { useSelectedNamespaces } from '../data/hooks';
import { useDragWidth } from '../useDragWidth';
import { NavItemRow } from './NavItemRow';

function matches(item: NavItem, q: string) {
  return item.label.toLowerCase().includes(q) || item.terms.includes(q);
}

function GroupHeader({
  label,
  icon: Icon,
  collapsed,
  onToggle,
  small = false,
}: {
  label: string;
  icon?: NavGroup['icon'];
  collapsed: boolean;
  onToggle: () => void;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className={cn(
        'text-fg-dim hover:text-fg-muted hover:bg-fg/3 flex w-full items-center gap-2 rounded-md text-left transition-colors',
        small
          ? 'py-1 pr-2 pl-4 text-[11px]'
          : 'mt-1 px-2.5 py-1.5 text-[10.5px] font-semibold tracking-[0.12em] uppercase',
      )}
    >
      <ChevronDown
        className={cn('h-3 w-3 shrink-0 transition-transform', collapsed && '-rotate-90')}
      />
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      <span className={cn('min-w-0 flex-1 truncate', small && 'font-mono')}>{label}</span>
    </button>
  );
}

/** Inner left panel: searchable, collapsible kind tree (Freelens layout, RunHQ look). */
export function ResourceNavigator({
  clusterId,
  activeKind,
  apiResources,
}: {
  clusterId: string;
  activeKind: string;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const id = useId();
  const [query, setQuery] = useState('');
  const navWidth = useWorkbenchStore((s) => s.navWidth);
  const collapsedNav = useWorkbenchStore((s) => s.navCollapsed);
  const collapsedGroups = useWorkbenchStore((s) => s.collapsedGroups);
  const pinnedKinds = useWorkbenchStore((s) => s.pinnedKinds);
  const store = useWorkbenchStore.getState;
  const drag = useDragWidth({
    width: navWidth,
    setWidth: (w) => store().setNavWidth(w),
    min: NAV_WIDTH.min,
    max: NAV_WIDTH.max,
    defaultWidth: NAV_WIDTH.default,
    edge: 'right',
  });

  const allGroups = useMemo(() => buildNav(apiResources), [apiResources]);
  const all = useMemo(() => flattenNav(allGroups), [allGroups]);
  // RBAC: kinds the user cannot list in the current scope are dimmed (or hidden).
  const namespaces = useSelectedNamespaces(clusterId);
  const access = useKindAccess(clusterId, all, namespaces);
  const hideLocked = useAccessStore((s) => s.hideInaccessible);
  const lockedCount = all.filter((i) => access.get(i.key)?.state === 'denied').length;
  const lockOf = (item: NavItem) => access.get(item.key)?.message ?? null;
  const groups = useMemo(() => {
    if (!hideLocked) return allGroups;
    const keep = (i: NavItem) => i.key === activeKind || access.get(i.key)?.state !== 'denied';
    return allGroups.map((g) => ({
      ...g,
      items: g.items.filter(keep),
      subgroups: g.subgroups
        .map((sg) => ({ ...sg, items: sg.items.filter(keep) }))
        .filter((sg) => sg.items.length),
    }));
  }, [allGroups, access, hideLocked, activeKind]);
  const pinned = useMemo(
    () =>
      pinnedKinds
        .map((k) => all.find((i) => i.key === k))
        .filter((i): i is NavItem => !!i)
        .filter((i) => !hideLocked || access.get(i.key)?.state !== 'denied'),
    [pinnedKinds, all, hideLocked, access],
  );
  const q = query.trim().toLowerCase();
  const navRef = useRef<HTMLElement>(null);

  // Keep the active kind visible when it changes from elsewhere (links, quick jump, palette).
  useEffect(() => {
    navRef.current
      ?.querySelector(`[data-nav-item="${CSS.escape(activeKind)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeKind]);

  const select = useCallback(
    (key: string) => store().setActiveKind(clusterId, key),
    [clusterId, store],
  );
  const togglePin = useCallback((key: string) => store().togglePinned(key), [store]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-nav-item]')];
    if (!buttons.length) return;
    e.preventDefault();
    const current = buttons.findIndex((b) => b === document.activeElement);
    const from =
      current >= 0 ? current : buttons.findIndex((b) => b.dataset.navItem === activeKind);
    const next =
      buttons[Math.max(0, Math.min(buttons.length - 1, from + (e.key === 'ArrowDown' ? 1 : -1)))];
    next?.focus();
    next?.click();
  };

  if (collapsedNav) {
    return (
      <aside
        aria-label={i18n.t('Resource navigator')}
        className="border-border bg-surface flex w-11 shrink-0 flex-col items-center gap-1 border-r py-2"
      >
        <button
          type="button"
          onClick={() => store().setNavCollapsed(false)}
          aria-label={i18n.t('Show resource navigator')}
          title={i18n.t('Show resource navigator')}
          className="text-fg-muted hover:bg-fg/5 hover:text-fg mb-1 rounded-md p-1.5"
        >
          <PanelLeftOpen className="h-3.5 w-3.5" />
        </button>
        {groups.map((g) => {
          const Icon = SECTION_ICONS[g.id];
          const containsActive = [...g.items, ...g.subgroups.flatMap((s) => s.items)].some(
            (i) => i.key === activeKind,
          );
          return (
            <button
              key={g.id}
              type="button"
              title={g.label}
              aria-label={g.label}
              onClick={() => {
                store().setNavCollapsed(false);
                if (collapsedGroups[g.id]) store().toggleGroup(g.id);
              }}
              className={cn(
                'rounded-md p-1.5 transition-colors',
                containsActive ? 'bg-fg/7 text-accent' : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </aside>
    );
  }

  const renderItems = (items: NavItem[], indent = false) =>
    items.map((item) => (
      <NavItemRow
        key={item.key}
        item={item}
        active={item.key === activeKind}
        pinned={pinnedKinds.includes(item.key)}
        indent={indent}
        locked={lockOf(item)}
        onSelect={select}
        onTogglePin={togglePin}
      />
    ));

  return (
    <aside
      id={id}
      aria-label={i18n.t('Resource navigator')}
      className="border-border bg-surface relative flex min-w-0 shrink-0 flex-col border-r"
      style={{ width: drag.width }}
    >
      <div className="border-border/60 flex h-12 shrink-0 items-center gap-1.5 border-b px-2.5">
        <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 transition-colors">
          <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder={i18n.t('Find a kind…')}
            aria-label={i18n.t('Find a resource kind')}
            className="dashboard-search-input text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={i18n.t('Clear search')}
              className="text-fg-dim hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {(lockedCount > 0 || hideLocked) && (
          <button
            type="button"
            aria-pressed={hideLocked}
            onClick={() => useAccessStore.getState().setHideInaccessible(!hideLocked)}
            aria-label={i18n.t('Hide inaccessible kinds')}
            title={
              hideLocked ? i18n.t('Show inaccessible kinds') : i18n.t('Hide inaccessible kinds')
            }
            className={cn(
              'shrink-0 rounded-md p-1.5 transition-colors',
              hideLocked ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-fg/5 hover:text-fg',
            )}
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => store().setNavCollapsed(true)}
          aria-label={i18n.t('Hide resource navigator')}
          title={i18n.t('Hide resource navigator')}
          aria-controls={id}
          className="text-fg-muted hover:bg-fg/5 hover:text-fg shrink-0 rounded-md p-1.5"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </div>
      <nav
        ref={navRef}
        className="overlay-scroll min-h-0 flex-1 overflow-auto px-2 pt-1 pb-3"
        onKeyDown={onKeyDown}
        aria-label={i18n.t('Resource kinds')}
      >
        {q ? (
          <SearchResults groups={groups} q={q} render={renderItems} />
        ) : (
          <>
            {pinned.length > 0 && (
              <section>
                <GroupHeader
                  label={i18n.t('Pinned')}
                  icon={SECTION_ICONS.pinned}
                  collapsed={!!collapsedGroups.pinned}
                  onToggle={() => store().toggleGroup('pinned')}
                />
                {!collapsedGroups.pinned && renderItems(pinned)}
              </section>
            )}
            {groups.map((g) => {
              const collapsed = !!collapsedGroups[g.id];
              if (!g.items.length && !g.subgroups.length) return null;
              return (
                <section key={g.id}>
                  <GroupHeader
                    label={g.label}
                    icon={g.icon}
                    collapsed={collapsed}
                    onToggle={() => store().toggleGroup(g.id)}
                  />
                  {!collapsed && (
                    <>
                      {renderItems(g.items)}
                      {g.subgroups.map((s) => {
                        const sc = collapsedGroups[s.id] ?? true;
                        const hasActive = s.items.some((i) => i.key === activeKind);
                        return (
                          <div key={s.id}>
                            <GroupHeader
                              label={s.label}
                              small
                              collapsed={sc && !hasActive}
                              onToggle={() =>
                                useWorkbenchStore.setState((st) => ({
                                  collapsedGroups: {
                                    ...st.collapsedGroups,
                                    [s.id]: !(st.collapsedGroups[s.id] ?? true),
                                  },
                                }))
                              }
                            />
                            {(!sc || hasActive) && renderItems(s.items, true)}
                          </div>
                        );
                      })}
                      {g.id === 'custom' &&
                        apiResources &&
                        !allGroups.some((x) => x.id === 'custom' && x.subgroups.length) && (
                          <p className="text-fg-dim px-2.5 py-1.5 text-[11px]">
                            {i18n.t('No custom resources installed')}
                          </p>
                        )}
                    </>
                  )}
                </section>
              );
            })}
          </>
        )}
      </nav>
      <div className="border-border/60 text-fg-dim flex items-center justify-between border-t px-3 py-2 text-[11px]">
        <span>
          {i18n.t('{count} kinds', { count: all.filter((i) => i.gvk).length })}
          {lockedCount > 0 && (
            <>
              {' · '}
              {hideLocked
                ? i18n.t('{count} hidden', { count: lockedCount })
                : i18n.t('{count} locked', { count: lockedCount })}
            </>
          )}
        </span>
        {!apiResources && <span className="animate-pulse">{i18n.t('Discovering…')}</span>}
      </div>
      <ResizeHandle
        handleProps={drag.handleProps}
        dragging={drag.dragging}
        className="focus-visible:bg-accent/15 absolute inset-y-0 -right-1 w-2 touch-none focus-visible:outline-none"
        title={i18n.t('Resize navigator · drag or use ←/→ · double-click to reset')}
      />
    </aside>
  );
}

function SearchResults({
  groups,
  q,
  render,
}: {
  groups: NavGroup[];
  q: string;
  render: (items: NavItem[], indent?: boolean) => React.ReactNode;
}) {
  i18n.useLocale();
  const found = groups
    .map((g) => ({
      group: g,
      items: [...g.items, ...g.subgroups.flatMap((s) => s.items)].filter((i) => matches(i, q)),
    }))
    .filter((x) => x.items.length);
  if (!found.length)
    return (
      <p className="text-fg-dim px-3 py-8 text-center text-[12px]">{i18n.t('No matching kinds')}</p>
    );
  return (
    <>
      {found.map(({ group, items }) => (
        <section key={group.id}>
          <div className="text-fg-dim mt-1 flex items-center gap-2 px-2.5 py-1.5 text-[10.5px] font-semibold tracking-[0.12em] uppercase">
            <group.icon className="h-3.5 w-3.5" />
            {group.label}
          </div>
          {render(items)}
        </section>
      ))}
    </>
  );
}
