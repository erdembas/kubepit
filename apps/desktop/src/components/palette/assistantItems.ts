import * as i18n from '@/i18n/core';
import { Sparkles } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useAssistantStore } from '@/store/useAssistantStore';
import type { AiIntent } from '@/types';
import type { PaletteItem } from './paletteItems';

export function assistantItems(): PaletteItem[] {
  const app = useAppStore.getState();
  if (!app.settings?.ai.enabled || !app.selectedClusterId) return [];
  const entries: [AiIntent, string][] = [
    ['chat', i18n.t('Ask assistant…')],
    ['kubectl', i18n.t('kubectl from description…')],
    ['promql', i18n.t('PromQL from description…')],
    ['logql', i18n.t('LogQL from description…')],
  ];
  return entries.map(([intent, label]) => ({
    type: 'action',
    id: `assistant:${intent}`,
    label,
    icon: Sparkles,
    group: 'actions',
    run: () => useAssistantStore.getState().openComposer(intent),
  }));
}
