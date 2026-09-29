import { useLocaleMemo as useMemo } from '@/i18n';
import * as i18n from '@/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal } from 'lucide-react';
import { FilterMenuBody } from '@/components/sidebar-filter-menu/FilterMenuBody';
import { cn } from '@/lib/cn';
import { ENVIRONMENTS } from '@/lib/clusterMeta';
import { useAppStore } from '@/store/useAppStore';

const POPOVER_WIDTH = 264;
const POPOVER_GAP = 6;

export function SidebarFilterMenu() {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const environmentFilter = useAppStore((s) => s.environmentFilter);
  const tagFilter = useAppStore((s) => s.tagFilter);
  const statusFilter = useAppStore((s) => s.sidebarStatusFilter);
  const groupBy = useAppStore((s) => s.sidebarGroupBy);
  const toggleEnvironment = useAppStore((s) => s.toggleEnvironmentFilter);
  const toggleTag = useAppStore((s) => s.toggleTagFilter);
  const setStatusFilter = useAppStore((s) => s.setSidebarStatusFilter);
  const setGroupBy = useAppStore((s) => s.setSidebarGroupBy);
  const clearFilters = useAppStore((s) => s.clearFilters);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const { environmentBuckets, tagBuckets } = useMemo(() => {
    const envCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    for (const cluster of clusters) {
      const env = cluster.environment ?? 'none';
      envCounts.set(env, (envCounts.get(env) ?? 0) + 1);
      for (const tag of cluster.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    return {
      environmentBuckets: ENVIRONMENTS.filter((env) => envCounts.has(env.key)).map((env) => ({
        key: env.key,
        label: env.label,
        short: env.short,
        color: env.color,
        count: envCounts.get(env.key) ?? 0,
      })),
      tagBuckets: [...tagCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tag, count]) => ({ tag, count })),
    };
  }, [clusters]);

  const activeFilterCount =
    (statusFilter !== 'all' ? 1 : 0) +
    (groupBy !== 'none' ? 1 : 0) +
    environmentFilter.length +
    tagFilter.length;

  useEffect(() => {
    if (!open) return;

    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const compute = () => {
      const button = triggerRef.current;
      if (!button) return;

      const rect = button.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const left = Math.min(
        Math.max(8, rect.right - POPOVER_WIDTH),
        viewportWidth - POPOVER_WIDTH - 8,
      );
      const popoverHeight = popoverRef.current?.offsetHeight ?? 420;
      const belowTop = rect.bottom + POPOVER_GAP;
      const top =
        belowTop + popoverHeight > viewportHeight - 8
          ? Math.max(8, rect.top - POPOVER_GAP - popoverHeight)
          : belowTop;

      setPos({ top, left });
    };

    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  const popover = open && pos && (
    <div
      ref={popoverRef}
      role="menu"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
      className="border-border bg-surface-raised rounded-app-lg animate-fade-in z-[60] overflow-hidden border shadow-[0_20px_60px_rgba(0,0,0,0.55)]"
    >
      <FilterMenuBody
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        groupBy={groupBy}
        setGroupBy={setGroupBy}
        environmentBuckets={environmentBuckets}
        tagBuckets={tagBuckets}
        environmentFilter={environmentFilter}
        tagFilter={tagFilter}
        toggleEnvironment={toggleEnvironment}
        toggleTag={toggleTag}
        resetEnvironments={() => useAppStore.setState({ environmentFilter: [] })}
        resetTags={() => useAppStore.setState({ tagFilter: [] })}
        activeFilterCount={activeFilterCount}
        onClearAll={() => {
          clearFilters();
          setGroupBy('none');
        }}
      />
    </div>
  );

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={i18n.t('Filter & group')}
        aria-expanded={open}
        title={i18n.t('Filter & group')}
        className={cn(
          'rounded-app-sm text-fg-muted hover:bg-fg/10 hover:text-fg relative inline-flex h-6 w-6 items-center justify-center transition',
          open && 'bg-fg/10 text-fg',
          activeFilterCount > 0 && !open && 'text-accent',
        )}
      >
        <SlidersHorizontal className="h-3 w-3" />
        {activeFilterCount > 0 && (
          <span className="bg-accent text-accent-fg absolute top-0.5 right-0.5 flex h-1.5 w-1.5 items-center justify-center rounded-full" />
        )}
      </button>
      {popover && createPortal(popover, document.body)}
    </div>
  );
}
