import * as i18n from '@/i18n/core';
import { BookOpenText } from 'lucide-react';
import { openAndConnect } from '@/lib/clusterActions';
import { filterKinds, kindEntries } from '@/lib/kube/schema/kinds';
import { openExplain } from '@/store/useExplainStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ClusterDef } from '@/types';
import type { PaletteItem } from './paletteItems';

const MAX_KINDS = 12;

/** "Open API explorer" for a cluster. */
export function explainAction(cluster: ClusterDef, group: 'resources' | 'cluster'): PaletteItem {
  return {
    type: 'action',
    id: `explain:${group}:${cluster.id}`,
    label: i18n.t('Open API explorer'),
    hint: group === 'resources' ? cluster.name : undefined,
    icon: BookOpenText,
    keywords: 'explain schema openapi fields crd kubectl api explorer',
    group,
    run: () => {
      openAndConnect(cluster.id);
      openExplain(cluster.id);
    },
  };
}

/** `explain <kind>`: jump straight to a served kind's schema. */
export function explainKindItems(cluster: ClusterDef, query: string): PaletteItem[] {
  const m = /^explain\s+(.+)$/i.exec(query.trim());
  if (!m) return [];
  const kinds = kindEntries(useWorkbenchStore.getState().apiResources[cluster.id]);
  return filterKinds(kinds, m[1]!)
    .slice(0, MAX_KINDS)
    .map((kind) => ({
      type: 'action' as const,
      id: `explain-kind:${cluster.id}:${kind.key}`,
      label: i18n.t('Explain {kind}', { kind: kind.kind }),
      hint: kind.apiVersion,
      icon: BookOpenText,
      keywords: `explain ${kind.kind} ${kind.plural} ${kind.shortNames.join(' ')}`,
      group: 'resources' as const,
      run: () => {
        openAndConnect(cluster.id);
        openExplain(cluster.id, { apiVersion: kind.apiVersion, kind: kind.kind });
      },
    }));
}
