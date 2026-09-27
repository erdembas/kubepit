import * as i18n from '@/i18n';
import { Activity } from 'lucide-react';
import type { ClusterOverview } from '@/types';
import { MetricsRangeToggle } from '../metrics/PrometheusControls';
import { UsageMetrics } from '../metrics/UsageMetrics';
import { Card } from './charts';

const CLUSTER_QUERY = { scope: 'cluster' } as const;
const CLUSTER_TARGET = { kind: 'cluster' } as const;

/**
 * Cluster overview: CPU and memory next to the rings; from Prometheus
 * (with ranges up to 7 days, network, filesystem and restarts) when the
 * cluster has one, otherwise the metrics-server history of the last hour.
 */
export function ClusterUsageHistory({
  clusterId,
  isActive,
  overview,
}: {
  clusterId: string;
  isActive: boolean;
  overview: ClusterOverview;
}) {
  i18n.useLocale();
  return (
    <Card
      title={i18n.t('Usage history')}
      icon={<Activity />}
      actions={<MetricsRangeToggle clusterId={clusterId} enabled={isActive} />}
    >
      <div className="p-4">
        <UsageMetrics
          clusterId={clusterId}
          historyQuery={CLUSTER_QUERY}
          promTarget={CLUSTER_TARGET}
          enabled={isActive}
          prefsKey="cluster"
          layout="row"
          height={150}
          defaultRefs={['requests']}
          refs={{
            cpu: {
              requests: overview.requests.cpu_millicores,
              limits: overview.limits.cpu_millicores,
              allocatable: overview.allocatable.cpu_millicores,
              capacity: overview.capacity.cpu_millicores,
            },
            memory: {
              requests: overview.requests.memory_bytes,
              limits: overview.limits.memory_bytes,
              allocatable: overview.allocatable.memory_bytes,
              capacity: overview.capacity.memory_bytes,
            },
          }}
        />
      </div>
    </Card>
  );
}
