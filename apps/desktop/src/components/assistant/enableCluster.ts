import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import type { ConfirmRequest } from '@/store/types';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterDef } from '@/types';

/**
 * Turns the assistant on for one cluster (spec §6). Production clusters
 * first ask for the typed cluster name, then send the acknowledgement the
 * backend requires (`aiClusterSet(id, true, true)`); other clusters are
 * enabled at once. The saved settings replace the app store's, like every
 * other settings save. Resolves to false when the confirmation is
 * cancelled (or replaced by another one) or the save fails.
 */
export function enableAssistantFor(cluster: ClusterDef): Promise<boolean> {
  const save = async (acknowledgeProduction: boolean) => {
    const saved = await ipc.aiClusterSet(cluster.id, true, acknowledgeProduction);
    useAppStore.getState().setSettings(saved);
  };

  if (cluster.environment !== 'production')
    return save(false).then(
      () => true,
      (error: unknown) => {
        useAppStore
          .getState()
          .pushToast(
            'error',
            assistantErrorMessage(error instanceof Error ? error.message : String(error)),
          );
        return false;
      },
    );

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let saving = false;
    const settle = (enabled: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(enabled);
    };
    const request: ConfirmRequest = {
      title: i18n.t('Enable the assistant for {name}?', { name: cluster.name }),
      message: i18n.t(
        '{name} is a production cluster. When you ask the assistant about it, context from this cluster (objects, events, logs) is sent to your model provider after you review it. Type the cluster name to confirm.',
        { name: cluster.name },
      ),
      confirmLabel: i18n.t('Enable assistant'),
      tone: 'danger',
      typeToConfirm: cluster.name,
      // A failed save throws: the dialog stays open and shows the error.
      onConfirm: async () => {
        saving = true;
        try {
          await save(true);
        } catch (error) {
          saving = false;
          if (useAppStore.getState().confirm !== request) settle(false);
          throw error;
        }
        settle(true);
      },
    };
    // The dialog closing (or another confirmation taking its place) without
    // a save means "cancelled"; while a save runs, its result decides.
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.confirm !== request && !saving) settle(false);
    });
    useAppStore.getState().requestConfirm(request);
  });
}
