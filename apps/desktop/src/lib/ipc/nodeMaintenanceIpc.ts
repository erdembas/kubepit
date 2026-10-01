import { call } from './invoke';
import type {
  NodeMaintenanceDrainRequest,
  NodeMaintenancePlan,
  NodeMaintenanceProgress,
  NodeMaintenanceReceipt,
} from '@/types/nodeMaintenance';

export const nodeMaintenanceIpc = {
  nodeMaintenancePreflight: (clusterId: string, name: string) =>
    call<NodeMaintenancePlan>('node_maintenance_preflight', { clusterId, name }),
  nodeMaintenanceDrain: (clusterId: string, request: NodeMaintenanceDrainRequest) =>
    call<NodeMaintenanceReceipt>('node_maintenance_drain', { clusterId, request }),
  nodeMaintenanceProgress: (clusterId: string, planId: string) =>
    call<NodeMaintenanceProgress>('node_maintenance_progress', { clusterId, planId }),
};
