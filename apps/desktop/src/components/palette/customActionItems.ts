import * as i18n from '@/i18n/core';
import { Settings2 } from 'lucide-react';
import {
  clusterCustomActions,
  customActionsFor,
  multiCustomActionsFor,
} from '@/components/workbench/actions/custom/customActions';
import { customActionIcon } from '@/components/workbench/actions/custom/icons';
import { runCustomAction } from '@/components/workbench/actions/custom/runCustomAction';
import { useTableKeyboard } from '@/components/workbench/keyboard/tableKeyboard';
import { formatChord } from '@/lib/keymap';
import { useAppStore } from '@/store/useAppStore';
import { sharedNamespacesOf } from '@/store/useWorkbenchStore';
import type { CustomAction } from '@/types';
import type { PaletteFilter, PaletteItem } from './paletteItems';

/**
 * Palette entries for custom actions: the ones that apply to the object
 * selected in the focused table (or its checked rows), the cluster-level
 * ones of the active cluster, and a way to manage them.
 */

function matches(query: string, ...parts: Array<string | undefined | null>) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function customActionItems(query: string, filter: PaletteFilter): PaletteItem[] {
  if (filter !== 'all' && filter !== 'actions') return [];
  const q = query.trim();
  const app = useAppStore.getState();
  const clusterId = app.selectedClusterId;
  const cluster = app.clusters.find((c) => c.id === clusterId);
  const items: PaletteItem[] = [];
  const item = (action: CustomAction, hint: string, run: () => void): PaletteItem => ({
    type: 'action',
    id: `custom-action:${action.id}:${hint}`,
    label: action.name,
    hint: action.shortcut ? `${hint} · ${formatChord(action.shortcut)}` : hint,
    icon: customActionIcon(action.icon),
    keywords: `${action.description} custom action`,
    group: 'actions',
    run,
  });

  if (clusterId) {
    const controller = useTableKeyboard.getState().controller;
    if (controller?.clusterId === clusterId) {
      const { gvk } = controller;
      const checked = controller.checked();
      const obj = controller.current();
      if (checked.length > 1)
        for (const action of multiCustomActionsFor(cluster, gvk, checked))
          items.push(
            item(action, i18n.t('{count} selected', { count: checked.length }), () =>
              runCustomAction({ action, clusterId, gvk, objects: checked }),
            ),
          );
      if (obj)
        for (const action of customActionsFor(cluster, gvk, obj))
          items.push(
            item(action, `${gvk.kind.toLowerCase()}/${obj.metadata.name}`, () =>
              runCustomAction({ action, clusterId, gvk, objects: [obj] }),
            ),
          );
    }
    const namespaces = sharedNamespacesOf(clusterId);
    const namespace =
      namespaces?.length === 1 ? namespaces[0]! : (cluster?.default_namespace ?? null);
    for (const action of clusterCustomActions(cluster))
      items.push(
        item(action, cluster?.name ?? clusterId, () =>
          runCustomAction({ action, clusterId, objects: [], namespace }),
        ),
      );
  }
  items.push({
    type: 'action',
    id: 'custom-actions:manage',
    label: i18n.t('Manage custom actions…'),
    icon: Settings2,
    keywords: 'custom actions plugins k9s shortcuts settings',
    group: 'actions',
    run: () => useAppStore.getState().openSettings('custom-actions'),
  });

  const shown = items.filter((i) => i.type === 'action' && matches(q, i.label, i.keywords, i.hint));
  // Without a query only offer the manage entry when there is something to run.
  if (!shown.length || (!q && shown.length === 1)) return [];
  return [{ type: 'header', id: 'hdr-custom-actions', label: i18n.t('Custom actions') }, ...shown];
}
