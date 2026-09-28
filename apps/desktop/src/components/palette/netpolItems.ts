import * as i18n from '@/i18n/core';
import { Radar } from 'lucide-react';
import { openAndConnect } from '@/lib/clusterActions';
import { openNetpolSimulator } from '@/components/workbench/netpol/netpolStore';
import type { ClusterDef } from '@/types';
import type { PaletteItem } from './paletteItems';

/** "Open network policy simulator" for a cluster. */
export function netpolAction(cluster: ClusterDef, group: 'resources' | 'cluster'): PaletteItem {
  return {
    type: 'action',
    id: `netpol:${group}:${cluster.id}`,
    label: i18n.t('Open network policy simulator'),
    hint: group === 'resources' ? cluster.name : undefined,
    icon: Radar,
    keywords:
      'network policy policies netpol simulator reachability can talk connectivity isolation',
    group,
    run: () => {
      openAndConnect(cluster.id);
      openNetpolSimulator(cluster.id);
    },
  };
}
