import { openAndConnect } from '@/lib/clusterActions';
import { openWizardEntry, WIZARDS } from '@/components/workbench/wizards/catalog';
import { sharedNamespacesOf } from '@/store/useWorkbenchStore';
import type { ClusterDef } from '@/types';
import type { PaletteItem } from './paletteItems';

/**
 * Resource wizards in the palette (`create secret`, `create configmap`,
 * `expose`, …) for the active cluster. They start in the namespace the
 * workbench shows; read-only clusters get none (nothing could be applied).
 */
export function createItems(cluster: ClusterDef): PaletteItem[] {
  if (cluster.read_only) return [];
  return WIZARDS.map((w) => ({
    type: 'action' as const,
    id: `wizard:${cluster.id}:${w.id}`,
    label: w.label(),
    hint: w.command,
    icon: w.icon,
    keywords: `${w.keywords} ${w.command} wizard`,
    group: 'resources' as const,
    run: () => {
      openAndConnect(cluster.id);
      const selected = sharedNamespacesOf(cluster.id) ?? [];
      const namespace =
        selected.length === 1 ? selected[0]! : (cluster.default_namespace ?? 'default');
      openWizardEntry(w, cluster.id, namespace);
    },
  }));
}
