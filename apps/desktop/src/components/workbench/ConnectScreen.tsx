import * as i18n from '@/i18n';
import { AlertTriangle, Loader2, Pencil, Plug, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { connectCluster } from '@/lib/clusterActions';
import { serverLabel } from '@/lib/clusterMeta';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef, ClusterStatus } from '@/types';
import { ClusterAvatar, EnvPill, ReadOnlyBadge } from './ClusterAvatar';

/** Centered connect / connecting / error state for a cluster tab. */
export function ConnectScreen({
  cluster,
  status,
}: {
  cluster: ClusterDef;
  status: ClusterStatus | undefined;
}) {
  i18n.useLocale();
  const state = status?.state ?? 'disconnected';
  const server = status?.server ? serverLabel(status.server) : cluster.context;
  const edit = () => useAppStore.getState().openClusterEditor({ mode: 'edit', cluster });

  return (
    <div className="bg-surface flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <ClusterAvatar cluster={cluster} size="lg" />
        <h2 className="text-fg mt-5 text-[20px] font-semibold tracking-tight">{cluster.name}</h2>
        <div className="mt-2 flex items-center gap-1.5">
          <EnvPill cluster={cluster} />
          {cluster.read_only && <ReadOnlyBadge />}
        </div>
        <p
          className="text-fg-muted mt-3 max-w-full truncate font-mono text-[11.5px]"
          title={status?.server ?? cluster.context}
        >
          {server}
        </p>

        {state === 'connecting' ? (
          <div
            className="text-status-starting mt-7 inline-flex items-center gap-2 text-[13px]"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Connecting to {name}…', { name: cluster.name })}
          </div>
        ) : state === 'error' ? (
          <>
            <div
              role="alert"
              className="border-status-error/25 bg-status-error/[0.06] text-status-error mt-6 flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[12px] leading-relaxed"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                {status?.error ?? i18n.t('Connection failed.')}
              </span>
            </div>
            <div className="mt-5 flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                onClick={() => void connectCluster(cluster.id)}
              >
                {i18n.t('Retry')}
              </Button>
              <Button
                variant="secondary"
                size="md"
                leftIcon={<Pencil className="h-3.5 w-3.5" />}
                onClick={edit}
              >
                {i18n.t('Edit cluster')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-fg-dim mt-5 text-[12.5px] leading-relaxed">
              {i18n.t(
                'Connect to browse workloads, open terminals and stream logs. Kubepit uses context {context}.',
                {
                  context: cluster.context,
                },
              )}
            </p>
            <div className="mt-6 flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                leftIcon={<Plug className="h-3.5 w-3.5" />}
                onClick={() => void connectCluster(cluster.id)}
              >
                {i18n.t('Connect')}
              </Button>
              <Button
                variant="ghost"
                size="md"
                leftIcon={<Pencil className="h-3.5 w-3.5" />}
                onClick={edit}
              >
                {i18n.t('Edit cluster')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
