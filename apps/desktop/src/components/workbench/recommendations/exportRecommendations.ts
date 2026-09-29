import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { exportFileName } from '@/lib/tableExport';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterId, RecommendationExportFormat, WorkloadRef } from '@/types';
import { saveTextAs } from '../dock/shared/saveFile';
import { errorText } from '../util';

/**
 * Recommendation exports: `recommendations_export` renders the JSON
 * document or the YAML resource fragments in the backend (locale-invariant,
 * no connection metadata); this saves them where the user picks.
 */

const FILTER: Record<RecommendationExportFormat, () => { name: string; extensions: string[] }> = {
  json: () => ({ name: i18n.t('JSON files'), extensions: ['json'] }),
  yaml: () => ({ name: i18n.t('YAML files'), extensions: ['yaml', 'yml'] }),
};

/** The fields `recommendations_export` picks workloads by. */
export function workloadRefs(rows: readonly WorkloadRef[]): WorkloadRef[] {
  return rows.map(({ kind, namespace, name }) => ({ kind, namespace, name }));
}

/**
 * The workloads to export for `rows` of a scan with `total` rows: none
 * (the backend then exports every row) when `rows` are all of them.
 */
export function exportSelection(rows: readonly WorkloadRef[], total: number): WorkloadRef[] {
  return rows.length > 0 && rows.length === total ? [] : workloadRefs(rows);
}

/**
 * Exports `workloads` (empty = every row) of run `runId` (null = the
 * latest) and saves the file as `<cluster>_recommendations_<time>.json|yaml`:
 * a save dialog in the desktop app, a download in browser previews. The
 * outcome is a toast; nothing is thrown.
 */
export async function exportRecommendations(
  clusterId: ClusterId,
  runId: number | null,
  workloads: WorkloadRef[],
  format: RecommendationExportFormat,
  clusterName: string,
): Promise<void> {
  try {
    const text = await ipc.recommendationsExport(clusterId, runId, workloads, format);
    const path = await saveTextAs(
      exportFileName([clusterName, 'recommendations'], format),
      text,
      FILTER[format](),
    );
    if (path) useAppStore.getState().pushToast('success', i18n.t('Saved {path}', { path }));
  } catch (e) {
    useAppStore.getState().pushToast('error', errorText(e));
  }
}
