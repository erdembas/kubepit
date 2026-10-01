export type ConnectionDoctorStage =
  'kubeconfig' | 'auth-helper' | 'network' | 'tls' | 'api' | 'authentication' | 'permissions';
export type ConnectionDoctorStatus = 'passed' | 'warning' | 'failed' | 'skipped';
export type ConnectionDoctorCode =
  | 'previous-step-failed'
  | 'namespace-invalid'
  | 'kubeconfig-invalid'
  | 'kubeconfig-ready'
  | 'legacy-auth-provider'
  | 'no-auth-helper'
  | 'auth-helper-missing'
  | 'auth-interactive'
  | 'auth-helper-failed'
  | 'auth-helper-timeout'
  | 'auth-helper-ready'
  | 'auth-expired'
  | 'endpoint-invalid'
  | 'network-timeout'
  | 'dns-failed'
  | 'tcp-failed'
  | 'proxy-reachable'
  | 'endpoint-reachable'
  | 'tls-not-used'
  | 'tls-unverified'
  | 'tls-verified'
  | 'tls-failed'
  | 'tls-unknown'
  | 'client-invalid'
  | 'api-ready'
  | 'api-timeout'
  | 'api-failed'
  | 'api-unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'anonymous'
  | 'identity-confirmed'
  | 'identity-unavailable'
  | 'permissions-incomplete'
  | 'permissions-limited'
  | 'permissions-ready';

export interface ConnectionDoctorStep {
  stage: ConnectionDoctorStage;
  status: ConnectionDoctorStatus;
  code: ConnectionDoctorCode;
}

export type ConnectionDoctorCapabilityId =
  'namespaces' | 'pods' | 'watches' | 'logs' | 'metrics' | 'helm' | 'exec' | 'rollouts';
export interface ConnectionDoctorCapability {
  id: ConnectionDoctorCapabilityId;
  allowed: boolean | null;
  blocked_by_read_only: boolean;
}

export interface ConnectionDoctorReport {
  cluster_id: string;
  namespace: string;
  checked_at: number;
  elapsed_ms: number;
  steps: ConnectionDoctorStep[];
  capabilities: ConnectionDoctorCapability[];
  tools: { id: 'kubectl' | 'helm'; available: boolean }[];
  metrics_api: 'available' | 'missing' | 'unavailable' | 'unchecked';
}
