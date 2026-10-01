export interface NodeMaintenanceOwner {
  uid: string;
  kind: string;
  name: string;
}
export interface NodeMaintenanceVolume {
  kind: 'empty-dir' | 'host-path' | 'local-pv' | 'persistent-volume-unknown';
  name: string;
}
export interface NodeMaintenancePod {
  namespace: string;
  name: string;
  uid: string;
  action: 'evict' | 'unmanaged' | 'daemonset' | 'mirror';
  phase: string;
  ready: boolean;
  terminating: boolean;
  owner: NodeMaintenanceOwner | null;
  volumes: NodeMaintenanceVolume[];
  pdbs: string[];
}
export interface NodeMaintenancePdb {
  namespace: string;
  name: string;
  uid: string;
  selector: string;
  matched_pods: string[];
  disruptions_allowed: number | null;
  required_disruptions: number;
  unhealthy_policy: string;
}
export interface NodeMaintenanceWorkload {
  namespace: string;
  owner: NodeMaintenanceOwner;
  baseline_uids: string[];
  expected_replacements: number;
  complete: boolean;
}
export interface NodeMaintenancePlan {
  plan_id: string;
  node_name: string;
  node_uid: string;
  fingerprint: string;
  checked_at: number;
  unschedulable: boolean;
  read_only: boolean;
  inventory_complete: boolean;
  pdbs_complete: boolean;
  pods: NodeMaintenancePod[];
  pdbs: NodeMaintenancePdb[];
  workloads: NodeMaintenanceWorkload[];
  /** Fixed codes; never API error prose. */
  warnings: string[];
}
export interface NodeMaintenanceDrainRequest {
  plan_id: string;
  name: string;
  node_uid: string;
  fingerprint: string;
}
export interface NodeMaintenanceEviction {
  namespace: string;
  name: string;
  uid: string;
  status: 'accepted' | 'already-gone' | 'pdb-blocked' | 'failed' | 'timeout' | 'not-attempted';
  /** Raw Kubernetes response, if available. */
  error: string | null;
}
export interface NodeMaintenanceReceipt {
  plan_id: string;
  started_at: number;
  node_cordoned: boolean;
  evictions: NodeMaintenanceEviction[];
}
export interface NodeMaintenanceSourceProgress {
  namespace: string;
  name: string;
  uid: string;
  state: 'present' | 'terminating' | 'gone' | 'unknown';
}
export interface NodeMaintenanceWorkloadProgress {
  namespace: string;
  owner: NodeMaintenanceOwner;
  expected_replacements: number;
  replacements: { name: string; uid: string; node: string; ready: boolean; phase: string }[];
  complete: boolean;
}
export interface NodeMaintenanceProgress {
  checked_at: number;
  node_uid_matches: boolean;
  node_cordoned: boolean | null;
  sources: NodeMaintenanceSourceProgress[];
  workloads: NodeMaintenanceWorkloadProgress[];
  warnings: string[];
}
