import type { Gvk } from './index';

/** Frozen, local evidence. The backend always redacts before persistence. */
export type InvestigationEvidenceKind =
  'object' | 'pods' | 'events' | 'logs' | 'changes' | 'metrics';
export type InvestigationEvidenceStatus = 'captured' | 'empty' | 'unavailable' | 'truncated';
export type InvestigationEvidenceReason =
  | 'timeout'
  | 'forbidden'
  | 'not-found'
  | 'not-available'
  | 'no-pods'
  | 'not-recording'
  | 'capture-limit'
  | 'request-failed'
  | 'no-selector';

export interface InvestigationEvidence {
  id: string;
  kind: InvestigationEvidenceKind;
  /** Kubernetes identifier, not translated. */
  label: string;
  status: InvestigationEvidenceStatus;
  format: 'yaml' | 'json' | 'text';
  content: string;
  reason: InvestigationEvidenceReason | null;
}

export interface InvestigationCaptureRequest {
  gvk: Gvk;
  namespace: string;
  name: string;
  title: string;
  lookback_minutes: 15 | 60;
}

export interface InvestigationTarget {
  api_version: string;
  kind: string;
  namespace: string;
  name: string;
}

export interface InvestigationSummary {
  id: string;
  title: string;
  cluster_id: string | null;
  cluster_name: string;
  target: InvestigationTarget;
  captured_at: number;
  updated_at: number;
  imported: boolean;
  evidence_count: number;
  incomplete_count: number;
}

/** Both native persistence and the portable JSON bundle use version 1. */
export interface Investigation extends InvestigationSummary {
  version: 1;
  notes: string;
  lookback_minutes: 15 | 60;
  evidence: InvestigationEvidence[];
}
