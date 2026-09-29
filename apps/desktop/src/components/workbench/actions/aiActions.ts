import * as i18n from '@/i18n/core';
import { gatherExplainContext } from '@/lib/ai/context/gather';
import { useAssistantStore } from '@/store/useAssistantStore';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterId, Gvk, KubeObject } from '@/types';

let gather: AbortController | null = null;
export async function explainObject(
  clusterId: ClusterId,
  gvk: Gvk,
  obj: KubeObject,
): Promise<void> {
  gather?.abort();
  const pending = new AbortController();
  gather = pending;
  const currentCluster = useAppStore.getState().selectedClusterId;
  try {
    const sections = await gatherExplainContext(clusterId, gvk, obj, pending.signal);
    if (pending.signal.aborted || useAppStore.getState().selectedClusterId !== currentCluster)
      return;
    await useAssistantStore
      .getState()
      .ask({
        intent: 'explain',
        message: i18n.t('Explain the selected workload and its current problems.'),
        sections,
        scope: {
          cluster_id: clusterId,
          namespace: obj.metadata.namespace ?? null,
          object: {
            api_version: obj.apiVersion,
            kind: obj.kind,
            name: obj.metadata.name,
            namespace: obj.metadata.namespace ?? null,
          },
        },
      });
  } catch (error) {
    if (!pending.signal.aborted) useAppStore.getState().pushToast('error', String(error));
  } finally {
    if (gather === pending) gather = null;
  }
}
