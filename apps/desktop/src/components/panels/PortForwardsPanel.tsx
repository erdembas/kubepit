import * as i18n from '@/i18n';
import { Network } from 'lucide-react';
import { ForwardRowActions, ForwardStateLabel } from '@/components/port-forwards/ForwardRowParts';
import { clusterColor } from '@/lib/clusterMeta';
import { formatAge } from '@/lib/format';
import { forwardRows, forwardTitle, rowLocalPort } from '@/lib/portForwards';
import { useAppStore } from '@/store/useAppStore';
import { useConnectivityStore } from '@/store/useConnectivityStore';
import type { PortForward } from '@/types';

export function forwardUrl(forward: PortForward) {
  return `http://localhost:${forward.local_port}`;
}

export async function copyText(text: string) {
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  }
}

/** Compact list used by the right rail; the full table lives in the Port forwards tab. */
export function PortForwardsPanel() {
  i18n.useLocale();
  const forwards = useAppStore((s) => s.portForwards);
  const saved = useConnectivityStore((s) => s.savedForwards);
  const clusters = useAppStore((s) => s.clusters);
  const openMainTab = useAppStore((s) => s.openMainTab);
  const rows = forwardRows(forwards, saved);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Network className="text-accent h-3.5 w-3.5" />
        <h2 className="text-fg text-[12px] font-semibold">{i18n.t('Port forwards')}</h2>
        <span className="bg-surface-muted text-fg-muted rounded-app-sm px-1.5 text-[10px] tabular-nums">
          {forwards.length}
        </span>
        <button
          type="button"
          onClick={() => openMainTab({ kind: 'port-forwards' })}
          className="text-fg-muted hover:text-fg ml-auto text-[11px]"
        >
          {i18n.t('Open table')}
        </button>
      </header>
      <div className="overlay-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {rows.map((row) => {
          const cluster = clusters.find((c) => c.id === row.cluster_id);
          const local = rowLocalPort(row);
          return (
            <div key={row.key} className="group hover:bg-fg/4 mb-1 rounded-md p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-fg min-w-0 flex-1 truncate text-[12px] font-medium">
                  {forwardTitle({ ...row, label: row.saved?.label })}
                </span>
                <span
                  className={
                    row.live
                      ? 'text-accent font-mono text-[11px] tabular-nums'
                      : 'text-fg-dim font-mono text-[11px] tabular-nums'
                  }
                >
                  :{local ?? i18n.t('auto')}
                </span>
              </div>
              <div className="text-fg-dim mt-1 flex items-center gap-1.5 text-[10.5px]">
                {cluster && (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: clusterColor(cluster) }}
                  />
                )}
                <span className="truncate">
                  {cluster?.name ?? row.cluster_id} · {row.namespace} · {row.remote_port}
                </span>
                {row.live && (
                  <span className="ml-auto tabular-nums">{formatAge(row.live.created_at)}</span>
                )}
              </div>
              {row.live?.error && (
                <p className="text-status-error mt-1 text-[10.5px] break-words">{row.live.error}</p>
              )}
              <div className="mt-1.5 flex items-center gap-1">
                <ForwardStateLabel row={row} className="text-[10.5px]" />
                <ForwardRowActions row={row} className="ml-auto" />
              </div>
            </div>
          );
        })}
        {!rows.length && (
          <p className="text-fg-dim px-3 py-10 text-center text-[12px]">
            {i18n.t('No active port forwards. Start one from a pod or service.')}
          </p>
        )}
      </div>
    </div>
  );
}
