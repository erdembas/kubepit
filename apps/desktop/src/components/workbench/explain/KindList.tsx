import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { filterKinds, type KindEntry } from '@/lib/kube/schema/kinds';
import { cn } from '@/lib/cn';

/** Searchable list of every served kind, grouped by API group. */
export function KindList({
  kinds,
  activeKey,
  query,
  onQuery,
  onPick,
}: {
  kinds: KindEntry[];
  activeKey: string | null;
  query: string;
  onQuery: (query: string) => void;
  onPick: (kind: KindEntry) => void;
}) {
  i18n.useLocale();
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const out: Array<{ group: string; kinds: KindEntry[] }> = [];
    for (const kind of filterKinds(kinds, query)) {
      const last = out[out.length - 1];
      if (last?.group === kind.group) last.kinds.push(kind);
      else out.push({ group: kind.group, kinds: [kind] });
    }
    return out;
  }, [kinds, query]);

  // Keep the active kind visible when it is picked from elsewhere.
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  return (
    <nav
      aria-label={i18n.t('Kinds')}
      className="border-border/60 flex w-56 shrink-0 flex-col border-r"
    >
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onQuery('')}
          placeholder={i18n.t('Filter kinds…')}
          aria-label={i18n.t('Filter kinds')}
          className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery('')}
            aria-label={i18n.t('Clear filter')}
            className="text-fg-dim hover:text-fg"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {groups.length === 0 && (
          <p className="text-fg-dim px-3 py-4 text-center text-[11.5px]">
            {i18n.t('No kinds match "{query}".', { query })}
          </p>
        )}
        {groups.map(({ group, kinds: list }) => (
          <div key={group || 'core'} className="pb-1">
            {/* API groups are identifiers: uppercase them with English rules. */}
            <div
              lang="en"
              className="text-fg-dim truncate px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase"
            >
              {group || 'core'}
            </div>
            {list.map((kind) => {
              const active = kind.key === activeKey;
              return (
                <button
                  key={kind.key}
                  type="button"
                  data-active={active || undefined}
                  onClick={() => onPick(kind)}
                  title={`${kind.apiVersion} ${kind.kind}`}
                  className={cn(
                    'flex h-7 w-full min-w-0 items-center gap-2 px-3 text-left text-[12px] transition-colors',
                    active
                      ? 'bg-fg/7 text-fg shadow-[inset_2px_0_0_rgb(var(--accent))]'
                      : 'text-fg-muted hover:bg-fg/4 hover:text-fg',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{kind.kind}</span>
                  <span className="text-fg-dim shrink-0 font-mono text-[10.5px]">
                    {kind.apiVersion.slice(kind.apiVersion.lastIndexOf('/') + 1)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
