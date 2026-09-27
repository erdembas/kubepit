import * as i18n from '@/i18n/core';
import {
  AppWindow,
  Boxes,
  ChartSpline,
  Copy,
  FileSearch,
  FolderPlus,
  Languages,
  LayoutDashboard,
  Moon,
  Network,
  PanelLeft,
  Pencil,
  Plug,
  Plus,
  Settings,
  SquareTerminal,
  Unplug,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { connectCluster, disconnectCluster, openAndConnect } from '@/lib/clusterActions';
import { connState, isLive } from '@/lib/clusterMeta';
import { openObject } from '@/lib/navigation';
import { applyTheme, effectiveTheme } from '@/lib/theme';
import { duplicateWindow } from '@/lib/windowing';
import { IS_MAC, modChord } from '@/lib/platform';
import { copyText } from '@/components/panels/PortForwardsPanel';
import { useAppStore } from '@/store/useAppStore';
import { dock } from '@/store/useDockStore';
import type { ClusterDef } from '@/types';
import { explainAction } from './explainItems';
import { fleetSearchAction } from './fleetSearchItem';
import { VIEW_KEYS } from '@/lib/kube/nav';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';

/** Resource relationship map of a cluster (namespace picker scope). */
function resourceMapItem(cluster: ClusterDef, id: string, group: 'resources' | 'cluster') {
  return {
    type: 'action' as const,
    id,
    label: i18n.t('Open resource map'),
    hint: group === 'resources' ? cluster.name : undefined,
    icon: Workflow,
    keywords: 'resource map topology graph relationships dependencies',
    group,
    run: () => {
      openAndConnect(cluster.id);
      useWorkbenchStore.getState().setActiveKind(cluster.id, VIEW_KEYS.resourceMap);
    },
  };
}

export type PaletteFilter = 'all' | 'clusters' | 'resources' | 'actions';

export type PaletteItem =
  | { type: 'header'; id: string; label: string }
  | { type: 'cluster'; id: string; cluster: ClusterDef; section: string | null }
  | {
      type: 'action';
      id: string;
      label: string;
      hint?: string;
      icon: LucideIcon;
      keywords?: string;
      group: 'resources' | 'actions' | 'cluster';
      run: () => void;
    };

/** Kinds offered as "Go to …" jumps, Lens/Freelens order. */
const JUMP_KINDS = [
  'Pod',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'Service',
  'Ingress',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
  'Node',
  'Namespace',
  'Event',
  'HorizontalPodAutoscaler',
  'CustomResourceDefinition',
];

function kindPlural(kind: string) {
  if (kind.endsWith('ss')) return `${kind}es`;
  if (kind.endsWith('y')) return `${kind.slice(0, -1)}ies`;
  return `${kind}s`;
}

export function clusterActions(cluster: ClusterDef): PaletteItem[] {
  const state = connState(useAppStore.getState().statuses[cluster.id]);
  const items: PaletteItem[] = [
    {
      type: 'action',
      id: `open:${cluster.id}`,
      label: i18n.t('Open workbench'),
      icon: LayoutDashboard,
      group: 'cluster',
      run: () => openAndConnect(cluster.id),
    },
    isLive(state)
      ? {
          type: 'action',
          id: `disconnect:${cluster.id}`,
          label: i18n.t('Disconnect'),
          icon: Unplug,
          group: 'cluster',
          run: () => void disconnectCluster(cluster.id),
        }
      : {
          type: 'action',
          id: `connect:${cluster.id}`,
          label: i18n.t('Connect'),
          icon: Plug,
          group: 'cluster',
          run: () => void connectCluster(cluster.id),
        },
    {
      type: 'action',
      id: `shell:${cluster.id}`,
      label: i18n.t('Open cluster terminal'),
      hint: 'kubectl',
      icon: SquareTerminal,
      group: 'cluster',
      run: () => {
        openAndConnect(cluster.id);
        dock.shell(cluster.id, cluster.name);
      },
    },
    resourceMapItem(cluster, `map:${cluster.id}`, 'cluster'),
    {
      type: 'action',
      id: `promql:${cluster.id}`,
      label: i18n.t('Open PromQL console'),
      hint: 'Prometheus',
      icon: ChartSpline,
      group: 'cluster',
      run: () => {
        openAndConnect(cluster.id);
        dock.promql(cluster.id);
      },
    },
    explainAction(cluster, 'cluster'),
    {
      type: 'action',
      id: `edit:${cluster.id}`,
      label: i18n.t('Edit cluster'),
      icon: Pencil,
      group: 'cluster',
      run: () => useAppStore.getState().openClusterEditor({ mode: 'edit', cluster }),
    },
    {
      type: 'action',
      id: `copy:${cluster.id}`,
      label: i18n.t('Copy context name'),
      hint: cluster.context,
      icon: Copy,
      group: 'cluster',
      run: () => void copyText(cluster.context),
    },
  ];
  items.push({ type: 'header', id: `hdr-go:${cluster.id}`, label: i18n.t('Go to') });
  for (const kind of JUMP_KINDS) {
    items.push({
      type: 'action',
      id: `go:${cluster.id}:${kind}`,
      label: kindPlural(kind),
      icon: Boxes,
      keywords: kind,
      group: 'cluster',
      run: () => openObject(cluster.id, kind),
    });
  }
  return items;
}

export function resourceJumps(cluster: ClusterDef): PaletteItem[] {
  const jumps: PaletteItem[] = JUMP_KINDS.map((kind) => ({
    type: 'action' as const,
    id: `jump:${cluster.id}:${kind}`,
    label: i18n.t('Go to {kind}', { kind: kindPlural(kind) }),
    hint: cluster.name,
    icon: Boxes,
    keywords: kind,
    group: 'resources' as const,
    run: () => openObject(cluster.id, kind),
  }));
  return [
    ...jumps,
    resourceMapItem(cluster, `jump-map:${cluster.id}`, 'resources'),
    explainAction(cluster, 'resources'),
  ];
}

export function appActions(): PaletteItem[] {
  const store = useAppStore.getState();
  return [
    {
      type: 'action',
      id: 'add-cluster',
      label: i18n.t('Add cluster'),
      icon: Plus,
      group: 'actions',
      run: () => store.openClusterEditor({ mode: 'add' }),
    },
    {
      type: 'action',
      id: 'discover',
      label: i18n.t('Discover kubeconfig contexts'),
      icon: FileSearch,
      group: 'actions',
      run: () => store.setImportDialogOpen(true),
    },
    {
      type: 'action',
      id: 'new-section',
      label: i18n.t('New section'),
      icon: FolderPlus,
      group: 'actions',
      run: () => {
        const id = store.addSection(i18n.t('New section'));
        store.setSidebarGroupBy('none');
        store.setSidebarPinned(true);
        return id;
      },
    },
    {
      type: 'action',
      id: 'new-window',
      label: i18n.t('New Window'),
      hint: modChord(IS_MAC ? '⇧N' : 'Shift+N'),
      icon: AppWindow,
      keywords: 'window duplicate',
      group: 'actions',
      run: () => void duplicateWindow(),
    },
    {
      type: 'action',
      id: 'dashboard',
      label: i18n.t('Go to overview'),
      icon: LayoutDashboard,
      group: 'actions',
      run: () => store.goHome(),
    },
    {
      type: 'action',
      id: 'forwards',
      label: i18n.t('Port forwards'),
      icon: Network,
      group: 'actions',
      run: () => store.openMainTab({ kind: 'port-forwards' }),
    },
    {
      type: 'action',
      id: 'settings',
      label: i18n.t('Open Settings'),
      icon: Settings,
      group: 'actions',
      run: () => store.openSettings(),
    },
    {
      type: 'action',
      id: 'theme',
      label: i18n.t('Toggle theme'),
      icon: Moon,
      group: 'actions',
      run: () => {
        let current: 'light' | 'dark' | 'system' = 'system';
        try {
          const saved = localStorage.getItem('kp-theme');
          if (saved === 'light' || saved === 'dark') current = saved;
        } catch {
          /* ignore */
        }
        applyTheme(effectiveTheme(current) === 'dark' ? 'light' : 'dark');
      },
    },
    {
      type: 'action',
      id: 'sidebar',
      label: i18n.t('Toggle sidebar'),
      icon: PanelLeft,
      group: 'actions',
      run: () => store.setSidebarPinned(!store.sidebarPinned),
    },
    {
      type: 'action',
      id: 'language',
      label: i18n.getLocale() === 'tr' ? 'Switch to English' : 'Türkçe’ye geç',
      icon: Languages,
      keywords: 'language dil english türkçe',
      group: 'actions',
      run: () => i18n.setLocale(i18n.getLocale() === 'tr' ? 'en' : 'tr'),
    },
    fleetSearchAction(),
  ];
}
