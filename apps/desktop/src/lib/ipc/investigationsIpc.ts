import { call } from './invoke';
import type {
  Investigation,
  InvestigationCaptureRequest,
  InvestigationSummary,
} from '@/types/investigations';

export const investigationsIpc = {
  investigationsList: (clusterId: string | null = null) =>
    call<InvestigationSummary[]>('investigations_list', { clusterId }),
  investigationGet: (id: string) => call<Investigation>('investigation_get', { id }),
  investigationCapture: (clusterId: string, request: InvestigationCaptureRequest) =>
    call<Investigation>('investigation_capture', { clusterId, request }),
  investigationUpdate: (id: string, title: string, notes: string) =>
    call<Investigation>('investigation_update', { id, title, notes }),
  investigationDelete: (id: string) => call<void>('investigation_delete', { id }),
  investigationExport: (id: string, evidenceIds: string[] | null = null) =>
    call<string>('investigation_export', { id, evidenceIds }),
  investigationImport: (bundle: string) => call<Investigation>('investigation_import', { bundle }),
};
