import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { ChevronRight, FolderTree, Globe } from 'lucide-react';
import type { ColumnContext, ObjectRef } from '@/lib/kube/columns';
import type { StatusTone } from '@/lib/kube/pods';
import { toneText } from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';

/**
 * Managed objects of an Argo CD Application (`status.resources`) or a Flux
 * Kustomization (`status.inventory`), grouped by namespace and kind. Names
 * open the object when it lives in this cluster.
 */

export interface TreeCell {
  text: string;
  tone: StatusTone;
  title?: string;
}

export interface TreeItem {
  key: string;
  kind: string;
  namespace: string;
  name: string;
  /** `null`: not navigable (deployed to another cluster). */
  ref: ObjectRef | null;
  sync?: TreeCell;
  health?: TreeCell;
  /** Short flag after the name (hook, prune). */
  flag?: string;
  attention?: boolean;
}

type Filter = 'all' | 'attention';

export function ResourceTree({
  items,
  ctx,
  attentionLabel,
}: {
  items: TreeItem[];
  ctx: ColumnContext;
  /** Label of the "needs attention" filter; no filter bar when omitted. */
  attentionLabel?: string;
}) {
  i18n.useLocale();
  const [filter, setFilter] = useState<Filter>('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const attention = items.filter((i) => i.attention).length;
  const shown = filter === 'attention' ? items.filter((i) => i.attention) : items;
  const groups = useMemo(() => {
    const byNs = new Map<string, Map<string, TreeItem[]>>();
    for (const item of shown) {
      const kinds = byNs.get(item.namespace) ?? new Map<string, TreeItem[]>();
      kinds.set(item.kind, [...(kinds.get(item.kind) ?? []), item]);
      byNs.set(item.namespace, kinds);
    }
    return [...byNs.entries()]
      .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
      .map(([namespace, kinds]) => ({
        namespace,
        count: [...kinds.values()].reduce((n, l) => n + l.length, 0),
        kinds: [...kinds.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([kind, list]) => ({
            kind,
            items: list.sort((a, b) => a.name.localeCompare(b.name)),
          })),
      }));
  }, [shown]);

  if (!items.length) return <p className="text-fg-dim text-[12px]">{i18n.t('None')}</p>;
  return (
    <div className="space-y-2">
      {attentionLabel && (
        <div className="flex items-center gap-1" role="radiogroup">
          {(
            [
              ['all', i18n.t('All'), items.length],
              ['attention', attentionLabel, attention],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] transition',
                filter === id ? 'bg-fg/7 text-fg font-medium' : 'text-fg-dim hover:bg-fg/4',
              )}
            >
              {label}
              <span className="text-fg-dim tabular-nums">{count}</span>
            </button>
          ))}
        </div>
      )}
      {!shown.length ? (
        <p className="text-fg-dim text-[12px]">{i18n.t('Nothing needs attention.')}</p>
      ) : (
        <div className="border-border/60 overflow-hidden rounded-md border text-[11.5px]">
          {groups.map((g) => {
            const closed = collapsed[g.namespace] ?? false;
            const NsIcon = g.namespace ? FolderTree : Globe;
            return (
              <div
                key={g.namespace || '(cluster)'}
                className="border-border/40 border-b last:border-b-0"
              >
                <button
                  type="button"
                  aria-expanded={!closed}
                  onClick={() => setCollapsed((c) => ({ ...c, [g.namespace]: !closed }))}
                  className="hover:bg-fg/4 bg-fg/[0.02] flex w-full items-center gap-1.5 px-2 py-1 text-left"
                >
                  <ChevronRight
                    className={cn(
                      'text-fg-dim h-3 w-3 shrink-0 transition-transform',
                      !closed && 'rotate-90',
                    )}
                  />
                  <NsIcon className="text-fg-dim h-3 w-3 shrink-0" />
                  <span className="text-fg-muted truncate font-medium">
                    {g.namespace || i18n.t('Cluster-scoped')}
                  </span>
                  <span className="text-fg-dim ml-auto tabular-nums">{g.count}</span>
                </button>
                {!closed &&
                  g.kinds.map((k) => (
                    <div key={k.kind}>
                      <div className="text-fg-dim py-0.5 pr-2 pl-7 text-[10px] font-semibold tracking-[0.08em] uppercase">
                        {k.kind}
                      </div>
                      {k.items.map((item) => (
                        <div
                          key={item.key}
                          className="hover:bg-fg/3 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-0.5 pr-2 pl-9"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            {item.ref ? (
                              <button
                                type="button"
                                onClick={() => item.ref && ctx.navigate(item.ref)}
                                className="text-accent hover:text-accent-hover min-w-0 truncate text-left hover:underline"
                                title={`${item.kind} ${item.namespace ? `${item.namespace}/` : ''}${item.name}`}
                              >
                                {item.name}
                              </button>
                            ) : (
                              <span
                                className="text-fg-muted min-w-0 truncate"
                                title={i18n.t('Deployed to another cluster')}
                              >
                                {item.name}
                              </span>
                            )}
                            {item.flag && (
                              <span className="text-fg-dim shrink-0 text-[10px]">{item.flag}</span>
                            )}
                          </span>
                          <span
                            className={cn('text-right', item.sync && toneText(item.sync.tone))}
                            title={item.sync?.title}
                          >
                            {item.sync?.text ?? ''}
                          </span>
                          <span
                            className={cn(
                              'min-w-[72px] text-right',
                              item.health && toneText(item.health.tone),
                            )}
                            title={item.health?.title}
                          >
                            {item.health?.text ?? ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
