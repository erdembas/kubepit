import type { Settings, SettingsChanged } from '@/types';

/**
 * The settings to apply from a `settings://changed` event, or null when this
 * window saved them itself: it already holds them, and applying its own
 * broadcast again would reset an open settings draft.
 */
export function remoteSettings(event: SettingsChanged, ownLabel: string): Settings | null {
  return event.source === ownLabel ? null : event.settings;
}
