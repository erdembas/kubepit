import * as i18n from '@/i18n';
import { Activity } from 'lucide-react';
import type { ClusterOverview } from '@/types';
import { RangeToggle, UsageHistory } from '../metrics/UsageHistory';
import { Card } from './charts';

const CLUSTER_QUERY = { scope: 'cluster' } as const;

/** Cluster overview: CPU and memory over the last hour next to the rings. */
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
    <Card title={i18n.t('Usage history')} icon={<Activity />} actions={<RangeToggle />}>
      <div className="p-4">
        <UsageHistory
          clusterId={clusterId}
          query={CLUSTER_QUERY}
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
