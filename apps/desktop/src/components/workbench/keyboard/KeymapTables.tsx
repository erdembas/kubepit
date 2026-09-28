import * as i18n from '@/i18n';
import { AlertTriangle } from 'lucide-react';
import { Kbd } from '@/components/ui/Kbd';
import {
  formatChord,
  GLOBAL_SHORTCUTS,
  KEY_GROUPS,
  KEYMAP,
  shortcutConflicts,
  type ShortcutConflict,
} from '@/lib/keymap';
import type { CustomAction } from '@/types';
import { VIEW_COMMANDS } from './commandBarModel';

/**
 * Every key of keyboard mode, the command bar, custom action shortcuts
 * (with conflicts) and the global shortcuts. Shared by the `?` overlay and
 * Settings → Keyboard.
 */

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1" lang="en">
      {keys.map((k) => (
        <Kbd key={k} className="h-5 min-w-[20px] px-1.5 text-[10.5px]">
          {formatChord(k)}
        </Kbd>
      ))}
    </span>
  );
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="hover:bg-fg/4 flex min-h-7 items-center gap-3 rounded-md px-2 py-1">
      <span className="text-fg-muted min-w-0 flex-1 text-[12px]">{label}</span>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="text-fg-dim mb-1 px-2 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
        {title}
      </h4>
      <div>{children}</div>
    </section>
  );
}

export function conflictText(conflict: ShortcutConflict): string {
  switch (conflict.kind) {
    case 'global':
      return i18n.t('Taken by the app shortcut “{name}”; the app wins.', { name: conflict.with });
    case 'keymap':
      return i18n.t('Taken by the keyboard mode key “{name}”; keyboard mode wins.', {
        name: conflict.with,
      });
    case 'action':
      return i18n.t('Also used by “{name}”; the first action in the list wins.', {
        name: conflict.with,
      });
  }
}

export function KeymapTables({
  actions,
  showKeymap = true,
}: {
  actions: readonly CustomAction[];
  showKeymap?: boolean;
}) {
  i18n.useLocale();
  const withShortcut = actions.filter((a) => a.enabled && a.shortcut);
  const conflicts = shortcutConflicts(actions);
  const commandRows: Array<[string, string]> = [
    [':pods  :po  :deploy', i18n.t('Jump to a kind by name or short name')],
    [':deploy kube-system', i18n.t('Jump to a kind in a namespace')],
    [':ns kube-system  :ns all', i18n.t('Switch the namespace')],
    [':ctx staging', i18n.t('Switch to another cluster')],
    [`:${Object.keys(VIEW_COMMANDS).slice(0, 4).join('  :')}`, i18n.t('Open a page')],
    [':q', i18n.t('Close the current tab')],
  ];
  return (
    <div className="@container">
      <div className="grid gap-x-6 gap-y-4 @2xl:grid-cols-2">
        {showKeymap &&
          KEY_GROUPS.map((group) => (
            <Section key={group.id} title={group.label()}>
              {KEYMAP.filter((b) => b.group === group.id).map((b) => (
                <Row key={b.command} label={b.label()}>
                  <Keys keys={b.keys} />
                </Row>
              ))}
            </Section>
          ))}
        {showKeymap && (
          <Section title={i18n.t('Command bar')}>
            {commandRows.map(([command, label]) => (
              <Row key={command} label={label}>
                <code className="text-fg shrink-0 font-mono text-[11px]" lang="en">
                  {command}
                </code>
              </Row>
            ))}
          </Section>
        )}
        <Section title={i18n.t('Custom action shortcuts')}>
          {withShortcut.length === 0 && (
            <p className="text-fg-dim px-2 py-1 text-[12px]">
              {i18n.t('No enabled custom action has a shortcut.')}
            </p>
          )}
          {withShortcut.map((a) => {
            const own = conflicts.filter((c) => c.actionId === a.id);
            return (
              <Row
                key={a.id}
                label={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{a.name}</span>
                    {own.length > 0 && (
                      <span title={own.map(conflictText).join('\n')} className="shrink-0">
                        <AlertTriangle
                          className="text-status-starting h-3 w-3"
                          aria-label={own.map(conflictText).join(' ')}
                        />
                      </span>
                    )}
                  </span>
                }
              >
                <Keys keys={[a.shortcut!]} />
              </Row>
            );
          })}
        </Section>
        <Section title={i18n.t('App shortcuts')}>
          {GLOBAL_SHORTCUTS.map((s) => (
            <Row key={s.keys[0]} label={s.label()}>
              <Keys keys={s.keys.length > 3 ? [s.keys[0]!, s.keys.at(-1)!] : s.keys} />
            </Row>
          ))}
        </Section>
      </div>
    </div>
  );
}
