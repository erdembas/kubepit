import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { Kbd } from '@/components/ui/Kbd';
import { buildNav, flattenNav } from '@/lib/kube/nav';
import { cn } from '@/lib/cn';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';

/** Header quick search: jump to any kind by name, plural or short name (`deploy`, `svc`). */
export function KindJump({
  clusterId,
  apiResources,
}: {
  clusterId: string;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const items = useMemo(() => flattenNav(buildNav(apiResources)), [apiResources]);
  const q = query.trim().toLowerCase();
  const matches = q
    ? items
        .filter(
          (i) =>
            i.label.toLowerCase().includes(q) || i.terms.split(' ').some((t) => t.startsWith(q)),
        )
        .sort(
          (a, b) =>
            Number(!a.label.toLowerCase().startsWith(q)) -
            Number(!b.label.toLowerCase().startsWith(q)),
        )
        .slice(0, 9)
    : [];

  const go = (key: string) => {
    useWorkbenchStore.getState().setActiveKind(clusterId, key);
    setQuery('');
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="relative hidden w-56 min-w-28 shrink-[2] lg:block">
      <div className="bg-surface border-border/70 focus-within:border-accent/50 flex h-8 items-center gap-2 rounded-lg border px-2.5 transition-colors">
        <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
        <input
          ref={input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(matches.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && matches[active]) {
              e.preventDefault();
              go(matches[active].key);
            } else if (e.key === 'Escape') {
              setQuery('');
              input.current?.blur();
            }
          }}
          placeholder={i18n.t('Go to resource…')}
          aria-label={i18n.t('Go to resource kind')}
          role="combobox"
          aria-expanded={open && matches.length > 0}
          className="dashboard-search-input text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
        />
      </div>
      {open && matches.length > 0 && (
        <div
          role="listbox"
          className="border-border bg-surface-overlay animate-fade-in absolute top-9 left-0 z-50 w-72 overflow-hidden rounded-lg border p-1 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
        >
          {matches.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item.key)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]',
                  i === active ? 'bg-accent/12 text-accent' : 'text-fg-muted',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.gvk?.group && (
                  <span className="text-fg-dim max-w-28 truncate text-[10px]">
                    {item.gvk.group}
                  </span>
                )}
                {i === active && <CornerDownLeft className="h-3 w-3 shrink-0" />}
              </button>
            );
          })}
          <div className="text-fg-dim flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-[10.5px]">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span>{i18n.t('to move')}</span>
            <Kbd className="ml-2">↵</Kbd>
            <span>{i18n.t('to open')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
