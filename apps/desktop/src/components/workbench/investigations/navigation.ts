import * as i18n from '@/i18n/core';
import { create } from 'zustand';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import type { Gvk, KubeObject } from '@/types';
import type { Investigation } from '@/types/investigations';
import { investigationError } from './labels';

export interface InvestigationDraft {
  title: string;
  notes: string;
}
interface InvestigationState {
  selected: Record<string, string>;
  capturing: Record<string, boolean>;
  drafts: Record<string, InvestigationDraft>;
  revision: number;
  select: (scope: string, id: string) => void;
  draft: (id: string, draft: InvestigationDraft) => void;
  clearDraft: (id: string) => void;
  saved: (record: Investigation) => void;
}

/** Drafts stay alive when switching investigations, panes or main tabs. */
export const useInvestigationStore = create<InvestigationState>((set) => ({
  selected: {},
  capturing: {},
  drafts: {},
  revision: 0,
  select: (scope, id) => set((state) => ({ selected: { ...state.selected, [scope]: id } })),
  draft: (id, draft) => set((state) => ({ drafts: { ...state.drafts, [id]: draft } })),
  clearDraft: (id) =>
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[id];
      return { drafts };
    }),
  saved: (record) =>
    set((state) => ({
      revision: state.revision + 1,
      selected: {
        ...state.selected,
        all: record.id,
        ...(record.cluster_id ? { [record.cluster_id]: record.id } : {}),
      },
    })),
}));

export async function startInvestigation(
  clusterId: string,
  gvk: Gvk,
  object: KubeObject,
  lookback: 15 | 60 = 15,
): Promise<void> {
  const app = useAppStore.getState();
  if (app.statuses[clusterId]?.state !== 'connected') {
    app.pushToast('error', investigationError('investigations:disconnected'));
    return;
  }
  if (useInvestigationStore.getState().capturing[clusterId]) return;
  app.openCluster(clusterId);
  useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.investigations);
  useInvestigationStore.setState((state) => ({
    capturing: { ...state.capturing, [clusterId]: true },
  }));
  try {
    const record = await ipc.investigationCapture(clusterId, {
      gvk,
      namespace: object.metadata.namespace ?? 'default',
      name: object.metadata.name,
      title: `${gvk.kind}/${object.metadata.name}`,
      lookback_minutes: lookback,
    });
    useInvestigationStore.getState().saved(record);
    useAppStore.getState().pushToast('success', i18n.t('Investigation saved locally.'));
  } catch (error) {
    useAppStore.getState().pushToast('error', investigationError(error));
  } finally {
    useInvestigationStore.setState((state) => ({
      capturing: { ...state.capturing, [clusterId]: false },
    }));
  }
}
