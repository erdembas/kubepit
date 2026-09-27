import * as i18n from '@/i18n/core';
import { ScanSearch } from 'lucide-react';
import { IS_MAC } from '@/lib/platform';
import { openFleetSearch } from '@/store/useFleetSearchStore';
import type { PaletteItem } from './paletteItems';

const SHORTCUT = IS_MAC ? '⌘⇧F' : 'Ctrl+Shift+F';

/** "Search all clusters for “…”" — hands the palette query to Fleet search. */
export function fleetSearchItem(query: string): PaletteItem {
  return {
    type: 'action',
    id: 'fleet-search:query',
    label: i18n.t('Search all clusters for “{query}”', { query }),
    hint: SHORTCUT,
    icon: ScanSearch,
    group: 'resources',
    run: () => openFleetSearch(query),
  };
}

/** The plain "Fleet search" action (no query). */
export function fleetSearchAction(): PaletteItem {
  return {
    type: 'action',
    id: 'fleet-search',
    label: i18n.t('Fleet search'),
    hint: SHORTCUT,
    icon: ScanSearch,
    keywords: 'search find all clusters fleet grep',
    group: 'actions',
    run: () => openFleetSearch(),
  };
}
