import * as i18n from '@/i18n/core';
import type { SidebarGroupBy, SidebarStatusFilter } from '@/store/useAppStore';

export const STATUS_OPTIONS: Array<{ key: SidebarStatusFilter; label: string; hint: string }> = [
  {
    key: 'all',
    get label() {
      return i18n.t('All');
    },
    get hint() {
      return i18n.t('Show every cluster');
    },
  },
  {
    key: 'connected',
    get label() {
      return i18n.t('Connected');
    },
    get hint() {
      return i18n.t('Live connections only');
    },
  },
  {
    key: 'disconnected',
    get label() {
      return i18n.t('Offline');
    },
    get hint() {
      return i18n.t('Disconnected or failing clusters');
    },
  },
];

export const GROUP_OPTIONS: Array<{ key: SidebarGroupBy; label: string }> = [
  {
    key: 'none',
    get label() {
      return i18n.t('Sections');
    },
  },
  {
    key: 'environment',
    get label() {
      return i18n.t('Env');
    },
  },
  {
    key: 'tag',
    get label() {
      return i18n.t('Tag');
    },
  },
  {
    key: 'status',
    get label() {
      return i18n.t('Status');
    },
  },
];
