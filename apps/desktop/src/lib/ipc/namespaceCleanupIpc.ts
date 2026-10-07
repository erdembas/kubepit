import { call } from './invoke';
import type {
  NamespaceCleanupPlan,
  NamespaceCleanupRequest,
  NamespaceCleanupResult,
} from '@/types/namespaceCleanup';

export const namespaceCleanupIpc = {
  namespaceCleanupPreview: (clusterId: string, namespace: string) =>
    call<NamespaceCleanupPlan>('namespace_cleanup_preview', { clusterId, namespace }),
  namespaceCleanupRun: (clusterId: string, request: NamespaceCleanupRequest) =>
    call<NamespaceCleanupResult>('namespace_cleanup_run', { clusterId, request }),
};
