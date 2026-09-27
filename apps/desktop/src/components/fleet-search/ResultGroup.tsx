import * as i18n from '@/i18n';
import { memo } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  Copy,
  GitCompareArrows,
  Loader2,
  Plug,
  ShieldAlert,
} from 'lucide-react';
import { ClusterAvatar, EnvPill } from '@/components/workbench/ClusterAvatar';
import { copyText } from '@/components/workbench/util';
import { connectCluster, openAndConnect } from '@/lib/clusterActions';
import { cn } from '@/lib/cn';
import { matchRanges } from '@/lib/fleet/nameMatch';
import { isRegexText } from '@/lib/fleet/searchQuery';
import { formatAge } from '@/lib/format';
import { kindKey } from '@/lib/kube/catalog';
import { kindIcon } from '@/lib/kube/icons';
import { dock } from '@/store/useDockStore';
import type { ClusterResult } from '@/store/useFleetSearchStore';
import type { ClusterDef, FleetSearchItem } from '@/types';

export interface Row {
  clusterId: string;
  item: FleetSearchItem;
}

export function rowKey(row: Row): string {
  const i = row.item;
  return `${row.clusterId}/${i.uid || `${i.gvk.plural}/${i.namespace ?? ''}/${i.name}`}`;
}

/** Name with the matched parts of the query highlighted. */
function Highlighted({ name, query }: { name: string; query: string }) {
  const text = isRegexText(query.trim())
    ? query.trim()
    : query
        .split(/\s+/)
        .filter((t) => t && !t.includes(':') && !/[=!]/.test(t))
        .join(' ');
  const ranges = matchRanges(text, name);
  if (!ranges.length) return <>{name}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(name.slice(at, start));
    parts.push(
      <mark key={start} className="bg-accent/20 text-fg rounded-[2px]">
        {name.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < name.length) parts.push(name.slice(at));
  return <>{parts}</>;
}

function GroupStatus({ cluster, result }: { cluster: ClusterDef; result: ClusterResult }) {
  i18n.useLocale();
  const seconds = result.elapsed !== null ? result.elapsed / 1000 : null;
  const time =
    seconds !== null
      ? i18n.t('{seconds} s', { seconds: i18n.number(seconds, { maximumFractionDigits: 1 }) })
      : null;
  switch (result.state) {
    case 'running':
      return (
        <span className="text-fg-dim flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          {result.items.length
            ? i18n.t('{count} so far', { count: result.items.length })
            : i18n.t('searching…')}
        </span>
      );
    case 'skipped':
      return (
        <span className="text-fg-dim flex items-center gap-2">
          {i18n.t('not connected')}
          <button
            type="button"
            onClick={() => void connectCluster(cluster.id)}
            className="text-fg-muted hover:text-accent inline-flex items-center gap-1"
          >
            <Plug className="h-3 w-3" />
            {i18n.t('Connect')}
          </button>
        </span>
      );
    case 'error':
      return (
        <span className="text-status-error max-w-[420px] truncate" title={result.error ?? ''}>
          {result.error}
        </span>
      );
    case 'done':
      return (
        <span className="text-fg-dim flex items-center gap-2 tabular-nums">
          {i18n.plural('{count} result', '{count} results', result.items.length)}
          {time && <span className="text-fg-dim/70">{time}</span>}
        </span>
      );
  }
}

export const ResultGroup = memo(function ResultGroup({
  cluster,
  result,
  query,
  collapsed,
  onToggle,
  activeKey,
  onActivate,
  onOpen,
}: {
  cluster: ClusterDef;
  result: ClusterResult;
  query: string;
  collapsed: boolean;
  onToggle: () => void;
  activeKey: string | null;
  onActivate: (key: string) => void;
  onOpen: (row: Row) => void;
}) {
  i18n.useLocale();
  const empty = result.state === 'done' && !result.items.length && !result.forbidden.length;
  const now = Date.now();
  return (
    <section className={cn('mb-1.5', empty && 'opacity-60')}>
      <div className="bg-surface/92 hover:bg-fg/3 sticky top-0 z-[1] flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[11.5px] backdrop-blur-sm transition">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <ChevronDown
            className={cn(
              'text-fg-dim h-3 w-3 shrink-0 transition-transform',
              collapsed && '-rotate-90',
            )}
          />
          <ClusterAvatar cluster={cluster} />
          <span className="text-fg truncate text-[12.5px] font-semibold tracking-tight">
            {cluster.name}
          </span>
          <EnvPill cluster={cluster} />
        </button>
        <span className="flex shrink-0 items-center gap-3">
          {result.forbidden.length > 0 && (
            <span
              className="text-status-starting flex items-center gap-1"
              title={i18n.t('RBAC does not allow listing: {kinds}', {
                kinds: result.forbidden.join(', '),
              })}
            >
              <ShieldAlert className="h-3 w-3" />
              {i18n.t('{kinds} not allowed', { kinds: result.forbidden.join(', ') })}
            </span>
          )}
          {result.truncated && (
            <span className="text-status-starting">{i18n.t('first 200 per kind')}</span>
          )}
          <GroupStatus cluster={cluster} result={result} />
        </span>
      </div>
      {!collapsed && result.items.length > 0 && (
        <div className="mt-0.5">
          {result.items.map((item) => {
            const row = { clusterId: cluster.id, item };
            const key = rowKey(row);
            const active = key === activeKey;
            const Icon = kindIcon(kindKey(item.gvk));
            const labels = Object.entries(item.labels);
            return (
              <div
                key={key}
                role="option"
                aria-selected={active}
                data-active={active ? '' : undefined}
                onMouseEnter={() => onActivate(key)}
                onClick={() => onOpen(row)}
                className={cn(
                  'group flex h-8 cursor-pointer items-center gap-3 rounded-md pr-2 pl-7 transition-colors',
                  active
                    ? 'bg-accent/10 shadow-[inset_2px_0_0_rgb(var(--accent))]'
                    : 'hover:bg-fg/4',
                )}
              >
                <Icon className="text-fg-dim h-3.5 w-3.5 shrink-0" />
                <span className="text-fg-dim w-[92px] shrink-0 truncate text-[11px]">
                  {item.gvk.kind}
                </span>
                <span className="min-w-[140px] flex-1 truncate font-mono text-[12px]">
                  {item.namespace && <span className="text-fg-dim">{item.namespace}/</span>}
                  <span className="text-fg">
                    <Highlighted name={item.name} query={query} />
                  </span>
                </span>
                <span
                  className="hidden max-w-[34%] min-w-0 shrink items-center justify-end gap-1 overflow-hidden lg:flex"
                  title={labels.map(([k, v]) => `${k}=${v}`).join('\n')}
                >
                  {labels.slice(0, 2).map(([k, v]) => (
                    <span
                      key={k}
                      className="bg-fg/5 text-fg-muted min-w-0 truncate rounded px-1.5 py-px font-mono text-[10px]"
                    >
                      {k}={v}
                    </span>
                  ))}
                  {labels.length > 2 && (
                    <span className="text-fg-dim shrink-0 text-[10px]">+{labels.length - 2}</span>
                  )}
                </span>
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-0.5',
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  <RowAction
                    label={i18n.t('Compare across clusters')}
                    onClick={() => {
                      openAndConnect(cluster.id);
                      dock.compare(cluster.id, item.gvk, item.namespace, item.name);
                    }}
                  >
                    <GitCompareArrows />
                  </RowAction>
                  <RowAction
                    label={i18n.t('Copy name')}
                    onClick={() => void copyText(item.name, item.name)}
                  >
                    <Copy />
                  </RowAction>
                  <RowAction label={i18n.t('Open in workbench')} onClick={() => onOpen(row)}>
                    <ArrowUpRight />
                  </RowAction>
                </span>
                <span className="text-fg-dim w-10 shrink-0 text-right text-[11px] tabular-nums">
                  {formatAge(item.created, now)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
});

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="text-fg-dim hover:text-fg hover:bg-fg/10 flex h-6 w-6 items-center justify-center rounded-md [&>svg]:h-3.5 [&>svg]:w-3.5"
    >
      {children}
    </button>
  );
}
