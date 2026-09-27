import * as i18n from '@/i18n';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FileCode2, Loader2, RotateCcw, Save } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ipc } from '@/lib/ipc';
import { modChord } from '@/lib/platform';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ClusterId } from '@/types';
import { isConflictError } from './documents';
import { EditorBanner, EditorBar, ReadOnlyNotice } from './EditorChrome';
import { YamlEditor } from './YamlEditor';

type EditTab = Extract<DockTab, { kind: 'editor'; mode: 'edit' }>;

type LoadState = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/** Edit an existing object's YAML; Save replaces it (optimistic concurrency via resourceVersion). */
export const EditEditor = memo(function EditEditor({
  clusterId,
  tab,
}: {
  clusterId: ClusterId;
  tab: EditTab;
}) {
  i18n.useLocale();
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId) ?? null);
  const fontSize = useAppStore((s) => s.settings?.terminal_font_size ?? 13);
  const pushToast = useAppStore((s) => s.pushToast);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const setDirty = useDockStore((s) => s.setDirty);
  const readOnly = cluster?.read_only ?? false;
  const objectLabel = `${tab.gvk.kind}/${tab.name}`;

  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [yaml, setYaml] = useState('');
  const [original, setOriginal] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const dirty = load.state === 'ready' && yaml !== original;
  const gvkKey = JSON.stringify(tab.gvk);
  // Cmd+S can fire before React re-renders after the last keystroke, so
  // save() reads the editor text from refs updated synchronously.
  const yamlRef = useRef(yaml);
  const originalRef = useRef(original);
  const setText = useCallback((text: string) => {
    yamlRef.current = text;
    setYaml(text);
  }, []);

  useEffect(() => {
    setDirty(tab.id, dirty);
  }, [dirty, setDirty, tab.id]);

  const requestId = useRef(0);
  const fetchYaml = useCallback(async () => {
    const id = ++requestId.current;
    setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'loading' }));
    try {
      const text = await ipc.resourceGetYaml(
        clusterId,
        JSON.parse(gvkKey),
        tab.namespace,
        tab.name,
      );
      if (id !== requestId.current) return;
      setText(text);
      originalRef.current = text;
      setOriginal(text);
      setSaveError(null);
      setLoad({ state: 'ready' });
    } catch (err) {
      if (id !== requestId.current) return;
      setLoad({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [clusterId, gvkKey, tab.namespace, tab.name, setText]);

  useEffect(() => {
    setLoad({ state: 'loading' });
    void fetchYaml();
  }, [fetchYaml]);

  const reload = useCallback(() => {
    if (!dirty) return void fetchYaml();
    requestConfirm({
      title: i18n.t('Discard your changes?'),
      message: i18n.t(
        'Reloading replaces the editor with the current version of {name} from the cluster.',
        {
          name: objectLabel,
        },
      ),
      confirmLabel: i18n.t('Reload'),
      tone: 'danger',
      onConfirm: () => void fetchYaml(),
    });
  }, [dirty, fetchYaml, objectLabel, requestConfirm]);

  const savingRef = useRef(false);
  const save = useCallback(async () => {
    const text = yamlRef.current;
    if (readOnly || text === originalRef.current || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await ipc.resourceApplyYaml(clusterId, text, 'replace', tab.namespace);
      pushToast('success', i18n.t('Saved {name}', { name: objectLabel }));
      // Pick up the new resourceVersion (and server defaults) for the next save.
      await fetchYaml();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSaveError({ message, conflict: isConflictError(message) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [clusterId, fetchYaml, objectLabel, pushToast, readOnly, tab.namespace]);

  return (
    <div className="bg-surface flex h-full w-full min-w-0 flex-col">
      <EditorBar>
        <FileCode2 className="text-accent h-3.5 w-3.5 shrink-0" />
        <span className="text-fg shrink-0 font-mono text-[12px]">{objectLabel}</span>
        {tab.namespace && (
          <span className="text-fg-dim border-border/70 shrink-0 rounded border px-1 font-mono text-[10px] leading-4">
            {tab.namespace}
          </span>
        )}
        {dirty && (
          <span className="text-tone-warning-fg shrink-0 text-[11px]">
            {i18n.t('Unsaved changes')}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<RotateCcw className="h-3 w-3" />}
            onClick={reload}
            disabled={load.state === 'loading' || saving}
          >
            {i18n.t('Reload')}
          </Button>
          {!readOnly && (
            <Button
              size="xs"
              variant="primary"
              leftIcon={
                saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />
              }
              onClick={() => void save()}
              disabled={!dirty || saving}
              title={i18n.t('Save ({shortcut})', { shortcut: modChord('S') })}
            >
              {saving ? i18n.t('Saving…') : i18n.t('Save')}
            </Button>
          )}
        </div>
      </EditorBar>
      {readOnly && <ReadOnlyNotice />}
      {saveError && (
        <EditorBanner
          tone={saveError.conflict ? 'warning' : 'error'}
          actions={
            saveError.conflict && (
              <Button size="xs" variant="secondary" onClick={reload}>
                {i18n.t('Reload')}
              </Button>
            )
          }
        >
          {saveError.conflict
            ? i18n.t(
                '{name} changed in the cluster since it was loaded. Reload to get the latest version, then re-apply your edits.',
                {
                  name: objectLabel,
                },
              )
            : saveError.message}
        </EditorBanner>
      )}
      <div className="relative min-h-0 flex-1">
        {load.state === 'loading' ? (
          <div className="text-fg-dim flex h-full items-center justify-center gap-2 text-[12px]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {i18n.t('Loading {name}…', { name: objectLabel })}
          </div>
        ) : load.state === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="text-status-error max-w-xl text-[12px] break-words">
              {load.message}
            </span>
            <Button size="xs" variant="secondary" onClick={() => void fetchYaml()}>
              {i18n.t('Retry')}
            </Button>
          </div>
        ) : (
          <YamlEditor
            value={yaml}
            onChange={setText}
            onSave={() => void save()}
            readOnly={readOnly}
            fontSize={fontSize}
          />
        )}
      </div>
    </div>
  );
});
