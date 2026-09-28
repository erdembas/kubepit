import * as i18n from '@/i18n';
import { useEffect } from 'react';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { actionApplies, isClusterLevel, isMultiSelect } from '@/lib/customActions';
import { chordFromEvent, globalShortcutFor, keymapCommandFor, type KeyBinding } from '@/lib/keymap';
import { useAppStore } from '@/store/useAppStore';
import { enabledCustomActions, useCustomActionsStore } from '@/store/useCustomActionsStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { CustomAction } from '@/types';
import { useActionDialogs } from '../actions/dialogStore';
import { runCustomAction } from '../actions/custom/runCustomAction';
import { isTypingTarget } from '../util';
import { CommandBar } from './CommandBar';
import { useKeyboardUi } from './commandBarModel';
import { runRowCommand } from './keyCommands';
import { KeymapTables } from './KeymapTables';
import { useTableKeyboard, type TableController } from './tableKeyboard';

/**
 * Keyboard glue mounted once in the app overlays. With keyboard mode on,
 * vim / k9s-style keys drive the focused table (see `lib/keymap.ts`); custom
 * action shortcuts work either way. Keys are ignored while typing (inputs,
 * Monaco, terminals, the dock), while a dialog, menu or the palette is open,
 * and for chords the app's global shortcuts own.
 */
export function KeyboardHost() {
  i18n.useLocale();
  const commandOpen = useKeyboardUi((s) => s.commandOpen);
  const helpOpen = useKeyboardUi((s) => s.helpOpen);

  useEffect(() => {
    // Esc is shared with the details panel and the selection bar: remember
    // what was open before any of them reacts (capture runs first).
    let escapeState: { details: boolean; checked: boolean } | null = null;
    const onCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const controller = useTableKeyboard.getState().controller;
      escapeState = controller
        ? { details: controller.hasDetails(), checked: controller.checked().length > 0 }
        : null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || blocked(e)) return;
      const chord = chordFromEvent(e);
      if (!chord || globalShortcutFor(chord)) return;
      const keyboardMode = useAppStore.getState().settings?.keyboard_mode ?? false;
      const controller = inWorkbench(e.target) ? useTableKeyboard.getState().controller : null;
      const binding = keyboardMode ? keymapCommandFor(chord) : undefined;
      if (binding && handleBinding(e, binding, controller, escapeState)) return;
      if (e.repeat) return;
      const actions = enabledCustomActions().filter((a) => a.shortcut === chord);
      if (actions.length && runShortcut(actions, controller, inWorkbench(e.target))) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <>
      {commandOpen && <CommandBar />}
      {helpOpen && <KeyboardHelp />}
    </>
  );
}

/** Dialogs, menus, the palette or typing own the keyboard. */
function blocked(e: KeyboardEvent): boolean {
  if (isTypingTarget(e.target)) return true;
  const app = useAppStore.getState();
  if (app.paletteOpen || app.confirm || useActionDialogs.getState().dialog) return true;
  const ui = useKeyboardUi.getState();
  if (ui.commandOpen || ui.helpOpen) return true;
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
}

/** Focus is on the page (nothing focused) or inside a cluster workbench. */
function inWorkbench(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target === document.body) return true;
  return !!target.closest('[data-workbench]');
}

function interactive(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      'button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"]',
    )
  );
}

/** Returns true when the key was handled. */
function handleBinding(
  e: KeyboardEvent,
  binding: KeyBinding,
  controller: TableController | null,
  escapeState: { details: boolean; checked: boolean } | null,
): boolean {
  const ui = useKeyboardUi.getState();
  switch (binding.command) {
    case 'command':
      e.preventDefault();
      ui.openCommand();
      return true;
    case 'help':
      e.preventDefault();
      ui.toggleHelp(true);
      return true;
    default:
      break;
  }
  if (!controller) return false;
  switch (binding.command) {
    case 'down':
    case 'up':
    case 'top':
    case 'bottom':
      e.preventDefault();
      controller.move(binding.command);
      return true;
    case 'open':
      if (interactive(e.target) || e.repeat) return false;
      e.preventDefault();
      controller.open();
      return true;
    case 'filter':
      e.preventDefault();
      controller.focusFilter();
      return true;
    case 'back':
      // The details panel and the selection bar handle their own Esc.
      if (escapeState?.details || escapeState?.checked) return false;
      if (controller.clearFilter()) {
        e.preventDefault();
        return true;
      }
      return false;
    default:
      if (e.repeat) return true;
      e.preventDefault();
      runRowCommand(binding.command, controller, binding.label());
      return true;
  }
}

/** Run the first shortcut action that applies to the current row (or cluster). */
function runShortcut(
  actions: CustomAction[],
  controller: TableController | null,
  workbench: boolean,
): boolean {
  const clusterId = useAppStore.getState().selectedClusterId;
  if (!clusterId || !workbench) return false;
  const cluster = useAppStore.getState().clusters.find((c) => c.id === clusterId);
  const obj = controller?.clusterId === clusterId ? controller.current() : null;
  const checked = controller?.clusterId === clusterId ? controller.checked() : [];
  for (const action of actions) {
    if (controller && checked.length > 1 && isMultiSelect(action)) {
      const { gvk } = controller;
      const all = checked.every((o) =>
        actionApplies(action, {
          cluster,
          kind: gvk.kind,
          group: gvk.group,
          namespace: o.metadata.namespace ?? null,
        }),
      );
      if (all) {
        runCustomAction({ action, clusterId, gvk, objects: checked });
        return true;
      }
    }
    if (controller && obj) {
      const { gvk } = controller;
      if (
        actionApplies(action, {
          cluster,
          kind: gvk.kind,
          group: gvk.group,
          namespace: obj.metadata.namespace ?? null,
        })
      ) {
        runCustomAction({ action, clusterId, gvk, objects: [obj], anchor: controller.anchor(obj) });
        return true;
      }
    }
    if (
      isClusterLevel(action) &&
      actionApplies(action, { cluster, kind: null, group: '', namespace: null })
    ) {
      const namespaces = useWorkbenchStore.getState().namespaces[clusterId];
      runCustomAction({
        action,
        clusterId,
        objects: [],
        namespace: namespaces?.length === 1 ? namespaces[0] : (cluster?.default_namespace ?? null),
      });
      return true;
    }
  }
  return false;
}

function KeyboardHelp() {
  i18n.useLocale();
  const actions = useCustomActionsStore((s) => s.actions);
  const close = () => useKeyboardUi.getState().toggleHelp(false);
  return (
    <Dialog
      title={i18n.t('Keyboard mode')}
      subtitle={i18n.t('Keys work in the workbench, outside text fields, editors and terminals.')}
      size="lg"
      onClose={close}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Settings2 className="h-3.5 w-3.5" />}
            onClick={() => {
              close();
              useAppStore.getState().openSettings('keyboard');
            }}
          >
            {i18n.t('Keyboard settings')}
          </Button>
          <Button variant="primary" size="sm" onClick={close}>
            {i18n.t('Close')}
          </Button>
        </>
      }
    >
      <KeymapTables actions={actions} />
    </Dialog>
  );
}
