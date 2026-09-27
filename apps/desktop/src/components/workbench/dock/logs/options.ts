import * as i18n from '@/i18n/core';
import type { SelectOption } from '@/components/ui/Select';

const TAIL_VALUES = [100, 500, 1_000, 5_000, 10_000];

/** "Since" choices shared by the pod and workload log toolbars ('all' = no limit). */
export function sinceSelectOptions(): SelectOption[] {
  return [
    { value: 'all', label: i18n.t('All time') },
    { value: '300', label: i18n.t('Last 5 minutes') },
    { value: '900', label: i18n.t('Last 15 minutes') },
    { value: '3600', label: i18n.t('Last hour') },
    { value: '21600', label: i18n.t('Last 6 hours') },
    { value: '86400', label: i18n.t('Last 24 hours') },
  ];
}

/** "Tail" choices, including the configured default ('all' = whole log). */
export function tailSelectOptions(defaultTail: number): SelectOption[] {
  const tails = [...new Set([...TAIL_VALUES, defaultTail])].sort((a, b) => a - b);
  return [
    ...tails.map((n) => ({
      value: String(n),
      label: i18n.t('Last {count} lines', { count: i18n.number(n) }),
    })),
    { value: 'all', label: i18n.t('All lines') },
  ];
}
