export type NetworkProbeProtocol = 'tcp' | 'http' | 'https';
export type NetworkProbeStatus = 'passed' | 'failed' | 'unavailable' | 'timed_out' | 'skipped';

export interface NetworkDiagnosticsRequest {
  namespace: string;
  pod: string;
  container: string;
  target_namespace: string;
  service: string;
  port: number;
  protocol: NetworkProbeProtocol;
  path: string;
}

export interface NetworkProbeResult {
  kind: 'dns' | 'tcp' | 'tls' | 'http';
  status: NetworkProbeStatus;
  reason: string;
  command: string[];
  output: string;
  duration_ms: number;
}

export interface NetworkServiceContext {
  selector: Record<string, string>;
  cluster_ip: string | null;
  external_name: string | null;
  ready_endpoints: number;
  unready_endpoints: number;
  addresses: string[];
  endpoints_error: string | null;
  endpoints_truncated: boolean;
}

export interface NetworkDiagnosticsReport {
  request: NetworkDiagnosticsRequest;
  host: string;
  checked_at: string;
  probes: NetworkProbeResult[];
  service: NetworkServiceContext;
}
