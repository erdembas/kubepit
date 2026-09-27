import * as i18n from '@/i18n';
import { Network } from 'lucide-react';
import { clusterColor } from '@/lib/clusterMeta';
import { formatAge } from '@/lib/format';
import { ipc } from '@/lib/ipc';
import { openObject } from '@/lib/navigation';
import { forwardRows, forwardTitle, rowLocalPort } from '@/lib/portForwards';
import { useAppStore } from '@/store/useAppStore';
import { useConnectivityStore } from '@/store/useConnectivityStore';
import { ForwardRowActions, ForwardStateLabel } from './ForwardRowParts';

/** Fleet-wide port forward table (Freelens "Port Forwarding", across every cluster). */
export function PortForwardsView() {
  i18n.useLocale();
  const forwards = useAppStore((s) => s.portForwards);
  const saved = useConnectivityStore((s) => s.savedForwards);
  const clusters = useAppStore((s) => s.clusters);
  const rows = forwardRows(forwards, saved);

  return (
    <div className="bg-surface flex min-h-0 flex-1 flex-col">
      <header className="border-border/70 bg-surface-raised/30 flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <Network className="text-accent h-4 w-4" />
        <h1 className="text-fg text-[13px] font-semibold">{i18n.t('Port forwards')}</h1>
        <span className="bg-surface-muted text-fg-muted rounded-app-sm px-1.5 text-[10px] tabular-nums">
          {forwards.length}
        </span>
        {saved.length > 0 && (
          <span className="text-fg-dim text-[11px]">
            {i18n.plural('{count} saved', '{count} saved', saved.length)}
          </span>
        )}
        {forwards.length > 0 && (
          <button
            type="button"
            onClick={() => {
              for (const f of forwards) void ipc.portForwardStop(f.id);
            }}
            className="text-status-error hover:bg-status-error/10 ml-auto rounded-md px-2 py-1 text-[11.5px]"
          >
            {i18n.t('Stop all')}
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="text-fg-dim flex h-full flex-col items-center justify-center gap-2 text-[12px]">
            <Network className="h-6 w-6 opacity-50" />
            <p>{i18n.t('No active port forwards. Start one from a pod or service.')}</p>
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="bg-surface sticky top-0 z-10">
              <tr className="text-fg-dim border-border/60 border-b text-left text-[10.5px] tracking-[0.12em] uppercase">
                <th className="px-4 py-2 font-semibold">{i18n.t('Target')}</th>
                <th className="px-3 py-2 font-semibold">{i18n.t('Cluster')}</th>
                <th className="px-3 py-2 font-semibold">{i18n.t('Namespace')}</th>
                <th className="px-3 py-2 font-semibold">{i18n.t('Ports')}</th>
                <th className="px-3 py-2 font-semibold">{i18n.t('Status')}</th>
                <th className="px-3 py-2 font-semibold">{i18n.t('Age')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const cluster = clusters.find((c) => c.id === row.cluster_id);
                const local = rowLocalPort(row);
                return (
                  <tr key={row.key} className="border-border/40 hover:bg-fg/3 border-b">
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        title={`${row.kind}/${row.name}`}
                        onClick={() =>
                          openObject(
                            row.cluster_id,
                            row.kind === 'pod' ? 'Pod' : 'Service',
                            row.namespace,
                            row.name,
                          )
                        }
                        className="text-fg hover:text-accent font-medium"
                      >
                        {forwardTitle({ ...row, label: row.saved?.label })}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-fg-muted inline-flex items-center gap-1.5">
                        {cluster && (
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: clusterColor(cluster) }}
                          />
                        )}
                        {cluster?.name ?? row.cluster_id}
                      </span>
                    </td>
                    <td className="text-fg-muted px-3 py-2 font-mono text-[11.5px]">
                      {row.namespace}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11.5px]">
                      <span className={row.live ? 'text-accent' : 'text-fg-dim'}>
                        localhost:{local ?? i18n.t('auto')}
                      </span>
                      <span className="text-fg-dim"> → {row.remote_port}</span>
                    </td>
                    <td className="px-3 py-2 text-[11.5px]">
                      <ForwardStateLabel row={row} />
                    </td>
                    <td className="text-fg-dim px-3 py-2 tabular-nums">
                      {row.live ? formatAge(row.live.created_at) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <ForwardRowActions row={row} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
