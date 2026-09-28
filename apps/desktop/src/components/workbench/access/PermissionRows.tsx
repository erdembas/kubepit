import * as i18n from '@/i18n';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { rowResource, type PermissionRow } from '@/lib/kube/rbac';
import { BindingPath } from './rbacLinks';

/**
 * A subject's permissions grouped by scope (cluster-wide first, then per
 * namespace): resource, verbs, name restrictions and the bindings behind
 * each row. Compact enough for the details panel.
 */

const PAGE = 60;

function ScopeTitle({ scope }: { scope: string | null }) {
  i18n.useLocale();
  if (scope === null) return <>{i18n.t('Cluster-wide')}</>;
  return (
    <>
      {i18n.t('Namespace')}{' '}
      <span lang="en" className="font-mono normal-case">
        {scope}
      </span>
    </>
  );
}

export function PermissionRows({
  clusterId,
  rows,
  empty,
}: {
  clusterId: string;
  rows: readonly PermissionRow[];
  empty: string;
}) {
  i18n.useLocale();
  const [limit, setLimit] = useState(PAGE);
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (!rows.length) return <p className="text-fg-dim text-[12px]">{empty}</p>;
  const shown = rows.slice(0, limit);
  const groups: Array<[string | null, PermissionRow[]]> = [];
  for (const r of shown) {
    const last = groups[groups.length - 1];
    if (last && last[0] === r.scope) last[1].push(r);
    else groups.push([r.scope, [r]]);
  }
  return (
    <div className="space-y-3">
      {groups.map(([scope, list]) => (
        <div key={scope ?? ''}>
          <h5 className="text-fg-dim mb-1 text-[10px] font-semibold tracking-[0.12em] uppercase">
            <ScopeTitle scope={scope} />
          </h5>
          <ul className="border-border/60 divide-border/40 divide-y rounded-md border">
            {list.map((r) => {
              const key = `${r.scope ?? ''}|${r.group}|${r.resource}|${r.names.join(',')}|${r.nonResource}`;
              const open = openKey === key;
              const wild = r.verbs.includes('*') || r.resource === '*' || r.group === '*';
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => setOpenKey(open ? null : key)}
                    aria-expanded={open}
                    className="hover:bg-fg/3 flex w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2.5 py-1.5 text-left"
                  >
                    <span
                      className={cn(
                        'min-w-0 truncate font-mono text-[11px]',
                        wild ? 'text-status-starting' : 'text-fg',
                      )}
                      title={rowResource(r)}
                    >
                      {r.group === '*' && !r.nonResource ? `${r.resource}.*` : rowResource(r)}
                    </span>
                    <span className="text-fg-muted min-w-0 flex-1 truncate text-right font-mono text-[10.5px]">
                      {r.verbs.join(', ')}
                    </span>
                    {r.names.length > 0 && (
                      <span className="text-fg-dim w-full truncate font-mono text-[10.5px]">
                        {i18n.t('only: {names}', { names: r.names.join(', ') })}
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className="space-y-0.5 px-2.5 pb-1.5">
                      {r.sources.map((s) => (
                        <BindingPath
                          key={s.binding.uid}
                          clusterId={clusterId}
                          binding={s.binding}
                          role={s.role}
                        />
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {rows.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + PAGE * 4)}
          className="text-accent text-[11.5px] hover:underline"
        >
          {i18n.t('Show {count} more', { count: rows.length - limit })}
        </button>
      )}
    </div>
  );
}
