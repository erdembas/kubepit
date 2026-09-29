import * as i18n from '@/i18n';
import { ShieldAlert } from 'lucide-react';
import { costSourceLabel } from '@/lib/cost';
import type { CostNote, CostSourceKind, RightsizingNote } from '@/types';

function costNoteText(note: CostNote, api: CostSourceKind | null): string {
  const detail = note.detail ?? '';
  switch (note.kind) {
    case 'api-failed':
      return i18n.t('{source} did not answer, so this is an estimate: {detail}', {
        source: api ? costSourceLabel(api) : i18n.t('The cost API'),
        detail,
      });
    case 'nodes-unavailable':
      return i18n.t('Nodes cannot be listed, so capacity and idle cost are unknown.');
    case 'volumes-unavailable':
      return i18n.t('Persistent volume claims cannot be listed, so storage is not priced.');
    case 'usage-failed':
      return i18n.t('Usage could not be read from Prometheus: {detail}', { detail });
    default:
      return i18n.t('The trend could not be loaded: {detail}', { detail });
  }
}

export function rightsizingNoteText(note: RightsizingNote): string {
  const detail = note.detail ?? '';
  switch (note.kind) {
    case 'prometheus-failed':
      return i18n.t(
        'Prometheus failed ({detail}); showing the last hour of metrics-server instead.',
        { detail },
      );
    case 'no-usage':
      return i18n.t(
        'No usage history: neither Prometheus nor metrics-server samples are available.',
      );
    case 'pods-unavailable':
      return i18n.t('Pods cannot be listed for the metrics-server fallback: {detail}', {
        detail,
      });
    case 'ownership-unavailable':
      return i18n.t(
        'kube-state-metrics owner series are missing, so pods are matched to workloads by name.',
      );
    case 'partial-data':
      return note.detail
        ? i18n.t('Some usage queries failed ({detail}); the affected rows are flagged.', {
            detail,
          })
        : i18n.t('Some usage queries returned warnings; the affected rows are flagged.');
    case 'namespace-failed':
      return i18n.t('Usage could not be queried for {namespaces}; their workloads have no data.', {
        namespaces: detail,
      });
    case 'query-budget-exceeded':
      return i18n.t(
        'The query budget ran out before {namespaces} could be queried; their workloads have no data.',
        { namespaces: detail },
      );
    case 'hpa-unavailable':
      return i18n.t(
        'HorizontalPodAutoscalers cannot be listed, so autoscaled workloads are not flagged.',
      );
  }
}

export function NoteBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-status-starting/30 bg-status-starting/8 text-fg-muted rounded-app flex items-start gap-2.5 border px-4 py-2.5 text-[12px]">
      <ShieldAlert className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function CostNotes({ notes, api }: { notes: CostNote[]; api: CostSourceKind | null }) {
  i18n.useLocale();
  if (!notes.length) return null;
  return (
    <div className="space-y-2">
      {notes.map((n) => (
        <NoteBanner key={n.kind}>{costNoteText(n, api)}</NoteBanner>
      ))}
    </div>
  );
}
