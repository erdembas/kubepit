import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { toGvk } from '@/lib/kube/catalog';
import { useAppStore } from '@/store/useAppStore';
import type { KubeObject } from '@/types';
import { errorText } from '../util';
import {
  buildConfigImpact,
  IMPACT_KINDS,
  MAX_IMPACT_OBJECTS,
  MAX_SOURCE_OBJECTS,
  type ConfigImpact,
  type ConfigImpactMode,
  type ConfigKeyChange,
  type ConfigReference,
} from './model';

export interface ImpactSource {
  kind: string;
  state: 'complete' | 'limited' | 'unavailable';
  inspected: number;
  error?: string;
}
export interface ImpactScan extends ConfigImpact {
  sources: ImpactSource[];
  scannedAt: number;
}

async function within<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(i18n.t('The impact scan timed out.'))), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** On-demand, namespace-scoped reads. No watches, Secret reads, or background reconnects. */
export async function scanConfigImpact(
  clusterId: string,
  target: ConfigReference,
  changes: readonly ConfigKeyChange[],
  mode: ConfigImpactMode = 'changed-keys',
): Promise<ImpactScan> {
  const deadline = Date.now() + 25_000;
  const results: { items: KubeObject[]; source: ImpactSource }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < IMPACT_KINDS.length) {
      const index = next++;
      const kind = IMPACT_KINDS[index]!;
      try {
        if (useAppStore.getState().statuses[clusterId]?.state !== 'connected')
          throw new Error(i18n.t('Connect to the cluster to inspect configuration consumers.'));
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(i18n.t('The impact scan timed out.'));
        const list = await within(
          ipc.resourceList(clusterId, toGvk(kind), target.namespace),
          Math.min(10_000, remaining),
        );
        results[index] = {
          items: list.items.slice(0, MAX_SOURCE_OBJECTS),
          source: {
            kind: kind.kind,
            state: list.items.length > MAX_SOURCE_OBJECTS ? 'limited' : 'complete',
            inspected: Math.min(list.items.length, MAX_SOURCE_OBJECTS),
          },
        };
      } catch (error) {
        results[index] = {
          items: [],
          source: { kind: kind.kind, state: 'unavailable', inspected: 0, error: errorText(error) },
        };
      }
    }
  };
  await Promise.all([worker(), worker()]);
  const objects = results.flatMap((result) => result.items);
  let remaining = MAX_IMPACT_OBJECTS;
  const sources = results.map(({ source }) => {
    const inspected = Math.min(source.inspected, remaining);
    remaining -= inspected;
    return {
      ...source,
      inspected,
      state: inspected < source.inspected ? ('limited' as const) : source.state,
    };
  });
  return { ...buildConfigImpact(target, changes, objects, mode), sources, scannedAt: Date.now() };
}
