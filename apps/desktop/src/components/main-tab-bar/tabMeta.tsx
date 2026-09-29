import * as i18n from '@/i18n/core';
import {
  BookOpen,
  History,
  LayoutDashboard,
  Network,
  ScanSearch,
  Settings as SettingsIcon,
} from 'lucide-react';
import type { MainTab } from '@/store/useAppStore';
import type { ClusterDef, ClusterStatus, ConnState } from '@/types';

export interface TabMeta {
  label: string;
  icon: React.ReactNode;
  status?: ConnState;
  closable: boolean;
}

export function resolveTabMeta(
  tab: MainTab,
  clusters: ClusterDef[],
  statuses: Record<string, ClusterStatus>,
): TabMeta {
  switch (tab.kind) {
    case 'dashboard':
      return {
        label: i18n.t('Overview'),
        icon: <LayoutDashboard className="h-3 w-3" />,
        closable: false,
      };
    case 'settings':
      return {
        label: i18n.t('Settings'),
        icon: <SettingsIcon className="h-3 w-3" />,
        closable: true,
      };
    case 'ai-guide':
      return {
        label: i18n.t('AI capabilities'),
        icon: <BookOpen className="h-3 w-3" />,
        closable: true,
      };
    case 'port-forwards':
      return {
        label: i18n.t('Port forwards'),
        icon: <Network className="h-3 w-3" />,
        closable: true,
      };
    case 'search':
      return {
        label: i18n.t('Fleet search'),
        icon: <ScanSearch className="h-3 w-3" />,
        closable: true,
      };
    case 'activity':
      return {
        label: i18n.t('Activity'),
        icon: <History className="h-3 w-3" />,
        closable: true,
      };
    case 'cluster': {
      const cluster = clusters.find((item) => item.id === tab.refId);
      return {
        label: cluster?.name ?? i18n.t('Unknown cluster'),
        icon: null,
        status: statuses[tab.refId]?.state ?? 'disconnected',
        closable: true,
      };
    }
  }
}
