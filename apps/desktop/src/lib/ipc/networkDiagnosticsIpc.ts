import type {
  NetworkDiagnosticsReport,
  NetworkDiagnosticsRequest,
} from '@/types/networkDiagnostics';
import { call } from './invoke';

export const networkDiagnosticsIpc = {
  networkDiagnosticsRun: (clusterId: string, request: NetworkDiagnosticsRequest) =>
    call<NetworkDiagnosticsReport>('network_diagnostics_run', { clusterId, request }),
};
