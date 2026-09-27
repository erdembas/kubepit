import * as i18n from '@/i18n';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, Layers, ScanSearch, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { modChord } from '@/lib/platform';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ApplyMode, ClusterId } from '@/types';
import { RESOURCE_TEMPLATES } from '../templates';
import { ApplyResults } from './ApplyResults';
import { applyManifest, type DocResult } from './applyManifest';
import { BarLabel, EditorBar, ReadOnlyNotice } from './EditorChrome';
import { REVIEW_SHORTCUT, useDryRunReview } from './review';
import { ReviewPanel } from './ReviewPanel';
import { YamlEditor } from './YamlEditor';

type CreateTab = Extract<DockTab, { kind: 'editor'; mode: 'create' }>;

/**
 * "Create resource" tab: template picker, target namespace, Create / server-side
 * Apply, and "Review" (a server-side dry run of either). On production
 * clusters Create and Apply always go through the review first.
 */
export const CreateEditor = memo(function CreateEditor({
  clusterId,
  tab,
}: {
  clusterId: ClusterId;
  tab: CreateTab;
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

  const [yaml, setYaml] = useState(tab.yaml);
  const [baseline, setBaseline] = useState(tab.yaml);
  const [templateId, setTemplateId] = useState('');
  const [namespace, setNamespace] = useState(
    () => tab.namespace ?? cluster?.default_namespace ?? 'default',
  );
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [busy, setBusy] = useState<ApplyMode | null>(null);
  const [results, setResults] = useState<DocResult[] | null>(null);
  const { review, start: startDryRun, rerun, close: closeReview } = useDryRunReview(clusterId);
  const dirty = yaml.trim() !== '' && yaml !== baseline;
  // Read by Cmd+S, which can fire before the re-render after a keystroke.
  const yamlRef = useRef(yaml);
  const setText = useCallback((text: string) => {
    yamlRef.current = text;
    setYaml(text);
  }, []);

  useEffect(() => {
    setDirty(tab.id, dirty);
  }, [dirty, setDirty, tab.id]);

  useEffect(() => {
    let alive = true;
    ipc
      .namespaceNames(clusterId)
      .then((names) => alive && setNamespaces(names))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [clusterId]);

  const namespaceOptions = useMemo(() => {
    const names = new Set([namespace, ...(cluster?.accessible_namespaces ?? []), ...namespaces]);
    return [...names].sort().map((n) => ({ value: n, label: n }));
  }, [namespace, namespaces, cluster?.accessible_namespaces]);

  const pickTemplate = (id: string) => {
    const template = RESOURCE_TEMPLATES.find((t) => t.id === id);
    if (!template) return;
    const apply = () => {
      setTemplateId(id);
      setText(template.yaml);
      setBaseline(template.yaml);
      setResults(null);
    };
    if (!dirty) return apply();
    requestConfirm({
      title: i18n.t('Replace editor content?'),
      message: i18n.t('Loading the {template} template discards what you typed.', {
        template: template.label,
      }),
      confirmLabel: i18n.t('Replace'),
      tone: 'danger',
      onConfirm: apply,
    });
  };

  const busyRef = useRef(false);
  const run = useCallback(
    async (mode: ApplyMode) => {
      const snapshot = yamlRef.current;
      if (readOnly || busyRef.current || !snapshot.trim()) return;
      busyRef.current = true;
      setBusy(mode);
      try {
        const summary = await applyManifest(clusterId, snapshot, mode, namespace, setResults);
        if (summary.results.length === 0) {
          setResults(null);
          pushToast('info', i18n.t('Nothing to apply: the manifest is empty.'));
        } else if (summary.failed === 0) {
          setBaseline(snapshot);
          pushToast(
            'success',
            mode === 'create'
              ? i18n.plural('Created {count} resource', 'Created {count} resources', summary.ok)
              : i18n.plural('Applied {count} resource', 'Applied {count} resources', summary.ok),
          );
        } else {
          pushToast(
            'error',
            i18n.plural('{count} document failed', '{count} documents failed', summary.failed),
          );
        }
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [clusterId, namespace, pushToast, readOnly],
  );

  const startReview = useCallback(
    (mode: ApplyMode = 'apply') => startDryRun(yamlRef.current, mode, namespace),
    [namespace, startDryRun],
  );
  // Production clusters always review before creating or applying (Cmd+S included).
  const commit = useCallback(
    (mode: ApplyMode) => (reviewFirst ? startReview(mode) : void run(mode)),
    [reviewFirst, run, startReview],
  );
  const applyReviewed = async () => {
    if (!review) return;
    await run(review.mode);
    closeReview();
  };

  return (
    <div className="bg-surface flex h-full w-full min-w-0 flex-col">
      {review && (
        <ReviewPanel
          review={review}
          readOnly={readOnly}
          applying={busy !== null}
          onBack={closeReview}
          onRerun={rerun}
          onApply={() => void applyReviewed()}
        />
      )}
      <div className={cn('flex min-h-0 flex-1 flex-col', review && 'hidden')}>
        <EditorBar>
          <FilePlus2 className="text-accent h-3.5 w-3.5 shrink-0" />
          <Select
            value={templateId}
            onChange={pickTemplate}
            options={RESOURCE_TEMPLATES.map((t) => ({ value: t.id, label: t.label }))}
            placeholder={i18n.t('Template…')}
            ariaLabel={i18n.t('Template')}
            leading={<Layers size={12} />}
            className="h-6.5 min-w-40 shrink-0"
          />
          <span aria-hidden className="bg-border/70 mx-1 h-4 w-px shrink-0" />
          <BarLabel>{i18n.t('Target namespace')}</BarLabel>
          <Select
            value={namespace}
            onChange={setNamespace}
            options={namespaceOptions}
            ariaLabel={i18n.t('Target namespace')}
            className="h-6.5 max-w-52 shrink-0 font-mono"
          />
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
            {!reviewFirst && (
              <Button
                size="xs"
                variant="ghost"
                leftIcon={<ScanSearch className="h-3 w-3" />}
                disabled={busy !== null || !yaml.trim()}
                onClick={() => startReview('apply')}
                title={i18n.t('Server-side dry run before applying ({shortcut})', {
                  shortcut: REVIEW_SHORTCUT,
                })}
              >
                {i18n.t('Review')}
              </Button>
            )}
            <Button
              size="xs"
              variant="secondary"
              disabled={readOnly || busy !== null || !yaml.trim()}
              onClick={() => commit('create')}
              title={i18n.t('Create the objects; fails if any already exists')}
            >
              {busy === 'create'
                ? i18n.t('Creating…')
                : reviewFirst
                  ? i18n.t('Review & create')
                  : i18n.t('Create')}
            </Button>
            <Button
              size="xs"
              variant="primary"
              leftIcon={
                reviewFirst ? <ScanSearch className="h-3 w-3" /> : <Send className="h-3 w-3" />
              }
              disabled={readOnly || busy !== null || !yaml.trim()}
              onClick={() => commit('apply')}
              title={
                reviewFirst
                  ? i18n.t(
                      'Production cluster: changes are reviewed before applying ({shortcut})',
                      {
                        shortcut: modChord('S'),
                      },
                    )
                  : i18n.t('Server-side apply ({shortcut})', { shortcut: modChord('S') })
              }
            >
              {busy === 'apply'
                ? i18n.t('Applying…')
                : reviewFirst
                  ? i18n.t('Review & apply')
                  : i18n.t('Apply')}
            </Button>
          </div>
        </EditorBar>
        {readOnly && <ReadOnlyNotice />}
        <div className="relative min-h-0 flex-1">
          <YamlEditor
            value={yaml}
            onChange={setText}
            onSave={() => commit('apply')}
            onReview={() => startReview('apply')}
            readOnly={readOnly}
            fontSize={fontSize}
          />
          {!yaml.trim() && (
            <div className="text-fg-dim pointer-events-none absolute inset-x-0 top-1/3 text-center text-[12px]">
              {i18n.t(
                'Pick a template or paste a manifest. Multiple documents separated by --- are applied in order.',
              )}
            </div>
          )}
        </div>
        {results && <ApplyResults results={results} onDismiss={() => setResults(null)} />}
      </div>
    </div>
  );
});
