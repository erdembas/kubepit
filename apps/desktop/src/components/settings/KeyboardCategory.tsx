import * as i18n from '@/i18n';
import { AlertTriangle } from 'lucide-react';
import { Switch } from '@/components/ui/Switch';
import { conflictText, KeymapTables } from '@/components/workbench/keyboard/KeymapTables';
import { formatChord, shortcutConflicts } from '@/lib/keymap';
import { useAppStore } from '@/store/useAppStore';
import { useCustomActionsStore } from '@/store/useCustomActionsStore';
import { NavigatorShortcutsSection } from './NavigatorShortcuts';
import { useSettingsDraft } from './categories';
import { SettingsPageShell, SettingsSection } from './SettingsView';

/** Settings → Keyboard: keyboard mode, the key map and shortcut conflicts. */
export function KeyboardCategory({ description }: { description: string }) {
  i18n.useLocale();
  const { draft, update, footer } = useSettingsDraft();
  const actions = useCustomActionsStore((s) => s.actions);
  const conflicts = shortcutConflicts(actions);
  return (
    <SettingsPageShell description={description} footer={footer}>
      {draft ? (
        <SettingsSection title={i18n.t('Keyboard mode')}>
          <Switch
            checked={draft.keyboard_mode}
            onChange={(v) => update('keyboard_mode', v)}
            label={i18n.t('Use vim / k9s-style keys in the workbench')}
            description={i18n.t(
              'j and k move through a table, Enter opens the details, : jumps to a kind, a namespace or a cluster, and ? lists every key. Keys are ignored while you type in a field, an editor or a terminal. Actions keep their permission checks and confirmations.',
            )}
          />
        </SettingsSection>
      ) : (
        <p className="text-fg-dim mb-6 text-[12px]">{i18n.t('Loading settings…')}</p>
      )}
      {conflicts.length > 0 && (
        <SettingsSection
          title={i18n.t('Shortcut conflicts')}
          description={i18n.t('These custom action shortcuts do not run while the conflict lasts.')}
        >
          <ul className="space-y-1">
            {conflicts.map((c, i) => {
              const action = actions.find((a) => a.id === c.actionId);
              return (
                <li
                  key={`${c.actionId}-${c.kind}-${i}`}
                  className="border-status-starting/25 bg-status-starting/8 flex items-start gap-2 rounded-md border px-2.5 py-1.5"
                >
                  <AlertTriangle className="text-status-starting mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="text-fg text-[12px]">
                    <span className="font-medium">{action?.name}</span>
                    <span className="text-fg-dim font-mono" lang="en">
                      {' '}
                      {formatChord(c.chord)}
                    </span>
                    {' — '}
                    {conflictText(c)}
                  </span>
                </li>
              );
            })}
          </ul>
        </SettingsSection>
      )}
      <SettingsSection
        title={i18n.t('Key map')}
        description={i18n.t('Custom action shortcuts work with keyboard mode off too.')}
        trailing={
          <button
            type="button"
            onClick={() => useAppStore.getState().openSettings('custom-actions')}
            className="text-accent text-[11.5px] hover:underline"
          >
            {i18n.t('Edit custom actions')}
          </button>
        }
      >
        <KeymapTables actions={actions} />
      </SettingsSection>
      <SettingsSection
        title={i18n.t('Navigator shortcuts')}
        description={i18n.t(
          'Keyboard shortcuts for the cluster navigator’s left menu. Only the most-used kinds have a default; assign any other kind you reach often.',
        )}
      >
        <NavigatorShortcutsSection />
      </SettingsSection>
    </SettingsPageShell>
  );
}
