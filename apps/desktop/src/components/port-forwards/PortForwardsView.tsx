import * as i18n from '@/i18n';
import { Copy, ExternalLink, Network, Square } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { copyText, forwardUrl } from '@/components/panels/PortForwardsPanel';
import { clusterColor } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { ipc } from '@/lib/ipc';
import { openObject } from '@/lib/navigation';
import { openExternal } from '@/lib/openExternal';
import { useAppStore } from '@/store/useAppStore';

/** Fleet-wide port forward table (Freelens "Port Forwarding", across every cluster). */
export function PortForwardsView() {
  i18n.useLocale();
  const forwards = useAppStore((s) => s.portForwards);
  const clusters = useAppStore((s) => s.clusters);

  return (
    <div className="bg-surface flex min-h-0 flex-1 flex-col">
      <header className="border-border/70 bg-surface-raised/30 flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <Network className="text-accent h-4 w-4" />
        <h1 className="text-fg text-[13px] font-semibold">{i18n.t('Port forwards')}</h1>
        <span className="bg-surface-muted text-fg-muted rounded-app-sm px-1.5 text-[10px] tabular-nums">
          {forwards.length}
        </span>
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
        {forwards.length === 0 ? (
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
              {forwards.map((f) => {
                const cluster = clusters.find((c) => c.id === f.cluster_id);
                return (
                  <tr key={f.id} className="border-border/40 hover:bg-fg/3 border-b">
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() =>
                          openObject(
                            f.cluster_id,
                            f.kind === 'pod' ? 'Pod' : 'Service',
                            f.namespace,
                            f.name,
                          )
                        }
                        className="text-fg hover:text-accent font-medium"
                      >
                        {f.kind}/{f.name}
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
                        {cluster?.name ?? f.cluster_id}
                      </span>
                    </td>
                    <td className="text-fg-muted px-3 py-2 font-mono text-[11.5px]">
                      {f.namespace}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11.5px]">
                      <span className="text-accent">localhost:{f.local_port}</span>
                      <span className="text-fg-dim"> → {f.remote_port}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 text-[11.5px]',
                          f.state === 'active'
                            ? 'text-status-running'
                            : f.state === 'error'
                              ? 'text-status-error'
                              : 'text-status-starting',
                        )}
                        title={f.error ?? undefined}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        {f.state === 'active'
                          ? i18n.t('Active')
                          : f.state === 'error'
                            ? i18n.t('Error')
                            : f.state === 'starting'
                              ? i18n.t('Starting')
                              : i18n.t('Stopped')}
                      </span>
                    </td>
                    <td className="text-fg-dim px-3 py-2 tabular-nums">
                      {formatAge(f.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-0.5">
                        <IconButton
                          label={i18n.t('Open in browser')}
                          icon={<ExternalLink />}
                          size="xs"
                          onClick={() => void openExternal(forwardUrl(f))}
                        />
                        <IconButton
                          label={i18n.t('Copy URL')}
                          icon={<Copy />}
                          size="xs"
                          onClick={() => void copyText(forwardUrl(f))}
                        />
                        <IconButton
                          label={i18n.t('Stop')}
                          icon={<Square />}
                          size="xs"
                          tone="danger"
                          onClick={() => void ipc.portForwardStop(f.id)}
                        />
                      </div>
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
