import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { Waypoints } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import type { ClusterDef, ClusterProxyInfo } from '@/types';

/** The proxy a cluster's connections go through; renders nothing without one. */
export function ClusterProxyLine({
  cluster,
  className,
}: {
  cluster: ClusterDef;
  className?: string;
}) {
  i18n.useLocale();
  const [info, setInfo] = useState<ClusterProxyInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ipc
      .clusterProxyInfo(cluster.id)
      .then((next) => !cancelled && setInfo(next))
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
  }, [cluster.id, cluster.proxy_url, cluster.context, cluster.kubeconfig_path]);
  if (!info?.url) return null;
  const source =
    info.source === 'cluster'
      ? i18n.t('Set in the cluster settings')
      : i18n.t("From the kubeconfig's proxy-url");
  return (
    <span
      className={cn(
        'text-fg-dim inline-flex max-w-full min-w-0 items-center gap-1.5 text-[11px]',
        className,
      )}
      title={source}
    >
      <Waypoints className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {i18n.rich('via proxy {url}', {
          url: <span className="text-fg-muted font-mono">{info.url}</span>,
        })}
      </span>
    </span>
  );
}
