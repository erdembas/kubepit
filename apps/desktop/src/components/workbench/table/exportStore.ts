import * as i18n from '@/i18n/core';
import { create } from 'zustand';
import { ipc, isTauri } from '@/lib/ipc';
import { EXPORT_EXTENSION, type ExportFormat } from '@/lib/tableExport';
import { downloadText } from '../dock/shared/platform';
import { pickSavePath } from '../dock/shared/saveFile';

/**
 * The open table export dialog. Toolbar, selection bar and palette ask for
 * one with `requestExport`; the resource page of that cluster and kind
 * renders it with its live rows (one page per cluster and kind exists).
 */
export interface ExportRequest {
  clusterId: string;
  kindKey: string;
  format: ExportFormat;
  /** Start on "selected rows" (selection bar). */
  selection?: boolean;
}

interface ExportState {
  request: ExportRequest | null;
  open: (request: ExportRequest) => void;
  close: () => void;
}

export const useTableExport = create<ExportState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function requestExport(request: ExportRequest) {
  useTableExport.getState().open(request);
}

const FILTER_NAME: Record<ExportFormat, () => string> = {
  csv: () => i18n.t('CSV files'),
  json: () => i18n.t('JSON files'),
  yaml: () => i18n.t('YAML files'),
};

/**
 * Save dialog + `save_text_file` in the desktop app, a download in browser
 * previews. Resolves to the written path; null when cancelled or downloaded.
 */
export async function saveExportFile(
  defaultName: string,
  text: string,
  format: ExportFormat,
): Promise<string | null> {
  if (!isTauri) {
    downloadText(defaultName, text);
    return null;
  }
  const extension = EXPORT_EXTENSION[format];
  const path = await pickSavePath(defaultName, {
    name: FILTER_NAME[format](),
    extensions: format === 'yaml' ? [extension, 'yml'] : [extension],
  });
  if (!path) return null;
  await ipc.saveTextFile(path, text);
  return path;
}
