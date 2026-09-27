import * as i18n from '@/i18n';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpenText,
  FileCode2,
  GitCompareArrows,
  Loader2,
  RotateCcw,
  Save,
  ScanSearch,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { EXPLAIN_SHORTCUT } from '@/lib/kube/schema/monaco';
import { modChord } from '@/lib/platform';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ClusterId } from '@/types';
import { DiffView } from '../../common/DiffView';
import { GitOpsYamlNotice } from '../../gitops/ManagedNotice';
import { isConflictError } from './documents';
import { EditorBanner, EditorBar, ReadOnlyNotice } from './EditorChrome';
import { REVIEW_SHORTCUT, useDryRunReview } from './review';
import { ReviewPanel } from './ReviewPanel';
import { YamlEditor } from './YamlEditor';

type EditTab = Extract<DockTab, { kind: 'editor'; mode: 'edit' }>;

type LoadState = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/**
 * Edit an existing object's YAML; Save replaces it (optimistic concurrency
 * via resourceVersion). "Review" dry-runs the replace on the server first
 * (always, on production clusters); "Diff with live" shows the edits against
 * the loaded object while typing, without a server call.
 */
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
  // Production clusters review every change first (read-only ones cannot apply anyway).
  const reviewFirst = cluster?.environment === 'production' && !readOnly;
  const objectLabel = `${tab.gvk.kind}/${tab.name}`;

  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [yaml, setYaml] = useState('');
  const [original, setOriginal] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffText, setDiffText] = useState('');
  const { review, start: startDryRun, rerun, close: closeReview } = useDryRunReview(clusterId);
  const explainRef = useRef<(() => void) | null>(null);
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

  // The live diff follows typing, debounced so large manifests stay smooth.
  useEffect(() => {
    if (!showDiff) return;
    const timer = setTimeout(() => setDiffText(yaml), 180);
    return () => clearTimeout(timer);
  }, [yaml, showDiff]);

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
      setDiffText(text);
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

  const ready = load.state === 'ready';
  const startReview = useCallback(() => {
    if (!ready || yamlRef.current === originalRef.current) return;
    startDryRun(yamlRef.current, 'replace', tab.namespace);
  }, [ready, startDryRun, tab.namespace]);
  // Production clusters always review before saving (Cmd+S included).
  const commit = useCallback(
    () => (reviewFirst ? startReview() : void save()),
    [reviewFirst, save, startReview],
  );
  const applyReviewed = async () => {
    await save();
    // On failure the editor shows the error banner (conflicts offer Reload).
    closeReview();
  };

  return (
    <div className="bg-surface flex h-full w-full min-w-0 flex-col">
      {review && (
        <ReviewPanel
          review={review}
          readOnly={readOnly}
          applying={saving}
          onBack={closeReview}
          onRerun={rerun}
          onApply={() => void applyReviewed()}
        />
      )}
      <div className={cn('flex min-h-0 flex-1 flex-col', review && 'hidden')}>
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
              leftIcon={<BookOpenText className="h-3 w-3" />}
              onClick={() => explainRef.current?.()}
              disabled={!ready}
              title={i18n.t('Explain the field at the cursor in the API explorer ({shortcut})', {
                shortcut: EXPLAIN_SHORTCUT,
              })}
            >
              {i18n.t('Explain')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              leftIcon={<GitCompareArrows className="h-3 w-3" />}
              onClick={() => setShowDiff((v) => !v)}
              disabled={!ready}
              aria-pressed={showDiff}
              title={i18n.t('Compare your edits with the object as loaded')}
              className={cn(showDiff && 'bg-fg/7 text-fg')}
            >
              {i18n.t('Diff with live')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              leftIcon={<RotateCcw className="h-3 w-3" />}
              onClick={reload}
              disabled={load.state === 'loading' || saving}
            >
              {i18n.t('Reload')}
            </Button>
            {!reviewFirst && (
              <Button
                size="xs"
                variant="secondary"
                leftIcon={<ScanSearch className="h-3 w-3" />}
                onClick={startReview}
                disabled={!dirty || saving}
                title={i18n.t('Server-side dry run before saving ({shortcut})', {
                  shortcut: REVIEW_SHORTCUT,
                })}
              >
                {i18n.t('Review')}
              </Button>
            )}
            {!readOnly && (
              <Button
                size="xs"
                variant="primary"
                leftIcon={
                  saving ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : reviewFirst ? (
                    <ScanSearch className="h-3 w-3" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )
                }
                onClick={commit}
                disabled={!dirty || saving}
                title={
                  reviewFirst
                    ? i18n.t(
                        'Production cluster: changes are reviewed before saving ({shortcut})',
                        { shortcut: modChord('S') },
                      )
                    : i18n.t('Save ({shortcut})', { shortcut: modChord('S') })
                }
              >
                {saving
                  ? i18n.t('Saving…')
                  : reviewFirst
                    ? i18n.t('Review & save')
                    : i18n.t('Save')}
              </Button>
            )}
          </div>
        </EditorBar>
        {readOnly && <ReadOnlyNotice />}
        {!readOnly && <GitOpsYamlNotice clusterId={clusterId} yaml={original} />}
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
            <div className="flex h-full min-w-0">
              <div className="relative h-full min-w-0 flex-1">
                <YamlEditor
                  value={yaml}
                  onChange={setText}
                  onSave={commit}
                  onReview={startReview}
                  readOnly={readOnly}
                  fontSize={fontSize}
                  clusterId={clusterId}
                  explainRef={explainRef}
                />
              </div>
              {showDiff && (
                <div className="border-border/60 flex h-full min-w-0 flex-1 flex-col border-l">
                  <DiffView
                    original={original}
                    modified={diffText}
                    originalLabel={i18n.t('Live')}
                    modifiedLabel={i18n.t('Edited')}
                    identicalHint={i18n.t('No edits yet: the editor matches the loaded object.')}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
