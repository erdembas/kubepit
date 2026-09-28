import * as i18n from '@/i18n';
import { useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  Lock,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Kbd } from '@/components/ui/Kbd';
import { Switch } from '@/components/ui/Switch';
import { customActionIcon } from '@/components/workbench/actions/custom/icons';
import { pickOpenPath, pickSavePath } from '@/components/workbench/dock/shared/saveFile';
import { downloadText } from '@/components/workbench/dock/shared/platform';
import { conflictText } from '@/components/workbench/keyboard/KeymapTables';
import { cn } from '@/lib/cn';
import { builtinExamples } from '@/lib/customActionExamples';
import { blankAction, exportActions, scopeSummary, withUniqueIds } from '@/lib/customActions';
import { ipc, isTauri } from '@/lib/ipc';
import { formatChord, shortcutConflicts } from '@/lib/keymap';
import { useAppStore } from '@/store/useAppStore';
import { useCustomActionsStore } from '@/store/useCustomActionsStore';
import type { CustomAction, CustomActionImport, CustomActionMode } from '@/types';
import { ActionEditor } from './customActions/ActionEditor';
import { ImportDialog } from './customActions/ImportDialog';
import { SettingsPageShell, SettingsSection } from './SettingsView';

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function modeLabel(mode: CustomActionMode) {
  if (mode === 'background') return i18n.t('Background');
  if (mode === 'open-url') return i18n.t('Open URL');
  return i18n.t('Terminal');
}

/** Settings → Custom actions: create, edit, reorder, import and export. */
export function CustomActionsCategory({ description }: { description: string }) {
  i18n.useLocale();
  const actions = useCustomActionsStore((s) => s.actions);
  const loaded = useCustomActionsStore((s) => s.loaded);
  const [editing, setEditing] = useState<{ action: CustomAction; isNew: boolean } | null>(null);
  const [imported, setImported] = useState<{ result: CustomActionImport; source: string } | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const conflicts = shortcutConflicts(actions);
  const toast = useAppStore.getState().pushToast;
  const missingExamples = builtinExamples().filter((e) => !actions.some((a) => a.id === e.id));

  const persist = async (next: CustomAction[], success?: string): Promise<string | null> => {
    try {
      await useCustomActionsStore.getState().save(next);
      if (success) toast('success', success);
      return null;
    } catch (e) {
      const message = errorMessage(e);
      toast('error', message);
      return message;
    }
  };

  const saveOne = async (action: CustomAction) => {
    const exists = actions.some((a) => a.id === action.id);
    const next = exists
      ? actions.map((a) => (a.id === action.id ? action : a))
      : [...actions, action];
    const error = await persist(next);
    if (!error) setEditing(null);
    return error;
  };
  const move = (index: number, delta: -1 | 1) => {
    const next = [...actions];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    void persist(next);
  };
  const remove = (action: CustomAction) =>
    useAppStore.getState().requestConfirm({
      title: i18n.t('Delete custom action'),
      message: i18n.t('Delete “{name}”? This cannot be undone.', { name: action.name }),
      confirmLabel: i18n.t('Delete'),
      tone: 'danger',
      onConfirm: () => void persist(actions.filter((a) => a.id !== action.id)),
    });
  const duplicate = (action: CustomAction) =>
    setEditing({
      action: {
        ...action,
        id: crypto.randomUUID(),
        name: i18n.t('{name} (copy)', { name: action.name }).slice(0, 80),
        shortcut: null,
      },
      isNew: true,
    });

  const startImport = async () => {
    if (!isTauri) {
      fileInput.current?.click();
      return;
    }
    const path = await pickOpenPath();
    if (!path) return;
    try {
      const result = await ipc.customActionsImport({ path });
      setImported({ result, source: path.split(/[\\/]/).pop() ?? path });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const importFile = async (file: File) => {
    try {
      const result = await ipc.customActionsImport({ text: await file.text() });
      setImported({ result, source: file.name });
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };
  const addImported = async (list: CustomAction[]) => {
    const next = [...actions, ...withUniqueIds(actions, list)];
    const error = await persist(
      next,
      i18n.plural('Added {count} custom action', 'Added {count} custom actions', list.length),
    );
    if (!error) setImported(null);
  };
  const exportAll = async () => {
    const text = exportActions(actions);
    const name = 'kubepit-custom-actions.json';
    if (!isTauri) return downloadText(name, text);
    const path = await pickSavePath(name, { name: 'JSON', extensions: ['json'] });
    if (!path) return;
    try {
      await ipc.saveTextFile(path, text);
      toast('success', i18n.t('Exported {count} custom actions', { count: actions.length }));
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };

  return (
    <SettingsPageShell description={description}>
      <SettingsSection
        title={i18n.t('Actions')}
        description={i18n.t(
          'Run your own commands on objects, selections or clusters from context menus, the details toolbar, the selection bar, the command palette and shortcuts. Commands run on this computer with KUBECONFIG set to the cluster.',
        )}
        trailing={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Upload className="h-3.5 w-3.5" />}
              onClick={() => void startImport()}
              title={i18n.t('Import a Kubepit export or a k9s plugins.yaml')}
            >
              {i18n.t('Import…')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Download className="h-3.5 w-3.5" />}
              disabled={!actions.length}
              onClick={() => void exportAll()}
            >
              {i18n.t('Export…')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              leftIcon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => setEditing({ action: blankAction(), isNew: true })}
            >
              {i18n.t('New action')}
            </Button>
          </div>
        }
      >
        <input
          ref={fileInput}
          type="file"
          accept=".json,.yaml,.yml"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importFile(file);
          }}
        />
        {!loaded ? (
          <p className="text-fg-dim text-[12px]">{i18n.t('Loading…')}</p>
        ) : actions.length === 0 ? (
          <div className="border-border rounded-app-sm border border-dashed px-4 py-6 text-center">
            <p className="text-fg-muted text-[12px]">{i18n.t('No custom actions yet.')}</p>
          </div>
        ) : (
          <ul className="border-border divide-border/60 rounded-app-sm divide-y border">
            {actions.map((action, index) => {
              const Icon = customActionIcon(action.icon);
              const own = conflicts.filter((c) => c.actionId === action.id);
              return (
                <li
                  key={action.id}
                  className={cn(
                    'group hover:bg-fg/4 @container flex items-center gap-3 px-3 py-2',
                    !action.enabled && 'opacity-70',
                  )}
                >
                  <span className="bg-accent/10 text-accent flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="text-fg truncate text-[12.5px] font-medium">
                        {action.name}
                      </span>
                      {action.mutating && (
                        <Lock
                          className="text-status-starting h-3 w-3 shrink-0"
                          aria-label={i18n.t('Changes the cluster')}
                        />
                      )}
                      {own.length > 0 && (
                        <span title={own.map(conflictText).join('\n')} className="shrink-0">
                          <AlertTriangle
                            className="text-status-starting h-3 w-3"
                            aria-label={own.map(conflictText).join(' ')}
                          />
                        </span>
                      )}
                    </div>
                    <p className="text-fg-dim truncate font-mono text-[11px]" lang="en">
                      {action.command}
                    </p>
                    <p className="text-fg-dim truncate text-[11px]">
                      {modeLabel(action.mode)} · {scopeSummary(action.scopes)}
                    </p>
                  </div>
                  {action.shortcut && (
                    <Kbd className="hidden h-5 px-1.5 text-[10.5px] @md:inline-flex">
                      <span lang="en">{formatChord(action.shortcut)}</span>
                    </Kbd>
                  )}
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton
                      size="xs"
                      label={i18n.t('Move up')}
                      icon={<ArrowUp />}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    />
                    <IconButton
                      size="xs"
                      label={i18n.t('Move down')}
                      icon={<ArrowDown />}
                      disabled={index === actions.length - 1}
                      onClick={() => move(index, 1)}
                    />
                    <IconButton
                      size="xs"
                      label={i18n.t('Edit')}
                      icon={<Pencil />}
                      onClick={() => setEditing({ action, isNew: false })}
                    />
                    <IconButton
                      size="xs"
                      label={i18n.t('Duplicate')}
                      icon={<Copy />}
                      onClick={() => duplicate(action)}
                    />
                    <IconButton
                      size="xs"
                      tone="danger"
                      label={i18n.t('Delete')}
                      icon={<Trash2 />}
                      onClick={() => remove(action)}
                    />
                  </div>
                  <Switch
                    bare
                    checked={action.enabled}
                    onChange={(enabled) =>
                      void persist(actions.map((a) => (a.id === action.id ? { ...a, enabled } : a)))
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
        {missingExamples.length > 0 && loaded && (
          <div className="mt-3 flex items-center gap-2">
            <Sparkles className="text-accent h-3.5 w-3.5 shrink-0" />
            <span className="text-fg-dim text-[11.5px]">
              {i18n.plural(
                '{count} built-in example is not in your list.',
                '{count} built-in examples are not in your list.',
                missingExamples.length,
              )}
            </span>
            <button
              type="button"
              onClick={() =>
                void persist(
                  [...actions, ...missingExamples],
                  i18n.plural(
                    'Added {count} example (disabled)',
                    'Added {count} examples (disabled)',
                    missingExamples.length,
                  ),
                )
              }
              className="text-accent text-[11.5px] hover:underline"
            >
              {i18n.t('Add examples')}
            </button>
          </div>
        )}
      </SettingsSection>
      {editing && (
        <ActionEditor
          key={editing.action.id}
          initial={editing.action}
          isNew={editing.isNew}
          others={actions}
          onSave={saveOne}
          onClose={() => setEditing(null)}
        />
      )}
      {imported && (
        <ImportDialog
          result={imported.result}
          source={imported.source}
          onAdd={(list) => void addImported(list)}
          onClose={() => setImported(null)}
        />
      )}
    </SettingsPageShell>
  );
}
