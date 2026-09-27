import * as i18n from '@/i18n';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Files, FolderGit2, FolderOpen, Loader2, ScanSearch, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type {
  ClusterDef,
  ClusterId,
  ManifestRecent,
  ManifestRender,
  ManifestSource,
} from '@/types';
import { errorText } from '../../util';
import { BarLabel, EditorBanner, EditorBar } from '../editor/EditorChrome';
import { ApplyButton } from './ApplyButton';
import { FleetReviewPane, useReviewControls } from './FleetReview';
import { baseName, kindLabel } from './labels';
import { docsKey, reviewDoc, reviewTarget } from './model';
import { pickManifestFiles, pickManifestFolder } from './pickers';
import { HelmOptionsBar, SourceBar, sourceLabel } from './SourceBar';
import { TargetPicker } from './TargetPicker';
import { useFleetReview } from './useFleetReview';

type ManifestsTab = Extract<DockTab, { kind: 'manifests' }>;

type RenderState =
  | { status: 'idle' }
  | { status: 'loading'; previous: ManifestRender | null }
  | { status: 'ready'; data: ManifestRender }
  | { status: 'error'; message: string; previous: ManifestRender | null };

/** How often "Watch" checks the files for changes while the tab is visible. */
const WATCH_INTERVAL_MS = 2000;

function lastData(state: RenderState): ManifestRender | null {
  if (state.status === 'ready') return state.data;
  if (state.status === 'idle') return null;
  return state.previous;
}

/**
 * "Manifests" dock tab: open a local folder (plain YAML, Kustomize, Helm)
 * or files, diff every object against one or more clusters like
 * `kubectl diff` (server-side dry run), then apply the selected changes.
 * Rendering is local; nothing reaches a cluster before the diff, and
 * nothing is written before the explicit apply.
 */
export const ManifestsView = memo(function ManifestsView({
  clusterId,
  tab,
  active,
}: {
  clusterId: ClusterId;
  tab: ManifestsTab;
  active: boolean;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const [source, setSource] = useState<ManifestSource | null>(tab.source);
  const [render, setRender] = useState<RenderState>({ status: 'idle' });
  const [recent, setRecent] = useState<ManifestRecent[]>([]);
  const [targets, setTargets] = useState<ClusterId[]>([clusterId]);
  const [namespace, setNamespace] = useState('');
  const [watch, setWatch] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const { review, run, apply, clear } = useFleetReview();
  const controls = useReviewControls(review);
  const seq = useRef(0);
  const renderRef = useRef(render);
  renderRef.current = render;

  const data = lastData(render);
  const docs = useMemo(() => data?.documents.map(reviewDoc) ?? [], [data]);
  const loading = render.status === 'loading';

  const refreshRecent = useCallback(() => {
    ipc
      .manifestsRecentList()
      .then(setRecent)
      .catch(() => undefined);
  }, []);

  const load = useCallback(
    async (next: ManifestSource) => {
      const id = ++seq.current;
      const previous = lastData(renderRef.current);
      setSource(next);
      setRender({ status: 'loading', previous });
      try {
        const out = await ipc.manifestsRender(next);
        if (id !== seq.current) return;
        setRender({ status: 'ready', data: out });
        useDockStore.getState().updateTab(clusterId, tab.id, { source: next });
        refreshRecent();
      } catch (e) {
        if (id !== seq.current) return;
        setRender({ status: 'error', message: errorText(e), previous });
      }
    },
    [clusterId, refreshRecent, tab.id],
  );

  const open = useCallback(
    (next: ManifestSource) => {
      // A different source starts over; re-rendering the same one keeps the review.
      const samePaths = source && next.paths.join('\0') === source.paths.join('\0');
      if (!samePaths) {
        clear();
        setProblemsOpen(false);
      }
      void load(next);
    },
    [clear, load, source],
  );

  useEffect(() => {
    refreshRecent();
    if (tab.source) void load(tab.source);
    // Mount only: later changes of `tab.source` come from this view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Watch": re-render when a file the source depends on changes.
  const fingerprint = render.status === 'ready' ? render.data.fingerprint : null;
  useEffect(() => {
    if (!watch || !active || !source || !fingerprint) return;
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy) return;
      busy = true;
      ipc
        .manifestsFingerprint(source)
        .then((now) => {
          if (now !== fingerprint) void load(source);
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, WATCH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [watch, active, source, fingerprint, load]);

  const pickedTargets = useMemo(
    () =>
      targets
        .map((id) => clusters.find((c) => c.id === id))
        .filter((c): c is ClusterDef => !!c)
        .map((c) => reviewTarget(c, namespace.trim() || c.default_namespace || null)),
    [targets, clusters, namespace],
  );
  const stale = !!review && docsKey(review.docs) !== docsKey(docs);
  const targetsChanged =
    !!review &&
    review.targets.map((t) => t.key).join(',') !== pickedTargets.map((t) => t.key).join(',');

  const diff = () => {
    if (!docs.length || !pickedTargets.length) return;
    run(docs, pickedTargets);
  };

  const helm = data?.kind === 'helm' && source && source.paths.length === 1;
  const kindText = data ? kindLabel(data.kind) : null;

  return (
    <div className="bg-surface flex h-full w-full min-w-0 flex-col">
      <SourceBar
        source={source}
        render={data}
        loading={loading}
        recent={recent}
        watch={watch}
        problemsOpen={problemsOpen}
        onOpen={open}
        onReload={() => source && void load(source)}
        onWatch={setWatch}
        onToggleProblems={() => setProblemsOpen((v) => !v)}
      />
      {helm && (
        <HelmOptionsBar
          chartDir={data.root}
          options={source.helm}
          onChange={(options) => open({ ...source, helm: options })}
        />
      )}
      {render.status === 'error' && (
        <EditorBanner
          tone="error"
          actions={
            source ? (
              <Button size="xs" variant="ghost" onClick={() => void load(source)}>
                {i18n.t('Retry')}
              </Button>
            ) : undefined
          }
        >
          {render.message}
        </EditorBanner>
      )}
      {!source ? (
        <EmptyState recent={recent} onOpen={open} onForget={setRecent} />
      ) : !data ? (
        <div className="text-fg-dim flex flex-1 items-center justify-center gap-2 text-[12px]">
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {loading
            ? i18n.t('Rendering {name}…', { name: sourceLabel(source) })
            : i18n.t('Nothing rendered yet.')}
        </div>
      ) : (
        <>
          <EditorBar>
            <BarLabel>{i18n.t('Diff against')}</BarLabel>
            <TargetPicker value={targets} onChange={setTargets} disabled={controls.applying} />
            <span aria-hidden className="bg-border/70 mx-1 h-4 w-px shrink-0" />
            <BarLabel>{i18n.t('Default namespace')}</BarLabel>
            <input
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder={i18n.t('cluster default')}
              aria-label={i18n.t('Default namespace')}
              title={i18n.t('Used for objects that do not set metadata.namespace')}
              spellCheck={false}
              className="border-border bg-surface-raised text-fg placeholder:text-fg-dim focus:border-accent rounded-app-sm h-6 w-36 shrink-0 border px-2 font-mono text-[11.5px] outline-none"
            />
            <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
              {kindText && (
                <span className="text-fg-dim text-[11px]" title={data.command ?? undefined}>
                  {kindText}
                </span>
              )}
              <Button
                size="xs"
                variant={review && !stale && !targetsChanged ? 'ghost' : 'secondary'}
                leftIcon={
                  controls.running ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ScanSearch className="h-3 w-3" />
                  )
                }
                disabled={!docs.length || loading || controls.applying}
                onClick={diff}
                title={i18n.t(
                  'Server-side dry run of every object on the selected clusters, like kubectl diff',
                )}
              >
                {review ? i18n.t('Diff again') : i18n.t('Diff')}
              </Button>
              <ApplyButton review={review} controls={controls} stale={stale} onApply={apply} />
            </div>
          </EditorBar>
          {problemsOpen && (
            <ProblemsPanel render={data} onOpen={open} onClose={() => setProblemsOpen(false)} />
          )}
          {stale && (
            <EditorBanner
              tone="warning"
              actions={
                <Button size="xs" variant="ghost" onClick={diff}>
                  {i18n.t('Diff again')}
                </Button>
              }
            >
              {i18n.t('The manifests changed after the last diff. Run it again before applying.')}
            </EditorBanner>
          )}
          {docs.length === 0 ? (
            <NoDocuments render={data} onOpen={open} />
          ) : (
            <FleetReviewPane
              docs={review && !stale ? review.docs : docs}
              targets={review ? review.targets : pickedTargets}
              review={stale ? null : review}
              controls={controls}
              groupSources={data.kind !== 'kustomize'}
              stale={stale}
            />
          )}
        </>
      )}
    </div>
  );
});

function EmptyState({
  recent,
  onOpen,
  onForget,
}: {
  recent: ManifestRecent[];
  onOpen: (source: ManifestSource) => void;
  onForget: (recent: ManifestRecent[]) => void;
}) {
  i18n.useLocale();
  const openFolder = async () => {
    const path = await pickManifestFolder();
    if (path) onOpen({ paths: [path], kind: 'auto', helm: null });
  };
  const openFiles = async () => {
    const paths = await pickManifestFiles();
    if (paths) onOpen({ paths, kind: 'plain', helm: null });
  };
  return (
    <div className="overlay-scroll flex min-h-0 flex-1 flex-col items-center overflow-auto px-6 py-8">
      <FolderGit2 className="text-fg-dim mb-2 h-6 w-6" />
      <p className="text-fg text-[13px] font-medium">{i18n.t('Local manifests')}</p>
      <p className="text-fg-dim mt-1 max-w-md text-center text-[12px]">
        {i18n.t(
          'Open a folder of YAML, a Kustomize directory or a Helm chart, diff it against one or more clusters and apply the changes you pick.',
        )}
      </p>
      <div className="mt-4 flex gap-2">
        <Button
          size="sm"
          variant="primary"
          leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
          onClick={() => void openFolder()}
        >
          {i18n.t('Open folder')}
        </Button>
        <Button
          size="sm"
          leftIcon={<Files className="h-3.5 w-3.5" />}
          onClick={() => void openFiles()}
        >
          {i18n.t('Open files')}
        </Button>
      </div>
      {recent.length > 0 && (
        <div className="mt-6 w-full max-w-lg">
          <p className="text-fg-dim mb-1 px-2 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
            {i18n.t('Recent')}
          </p>
          <ul className="space-y-px">
            {recent.map((r) => (
              <li key={r.source.paths.join('|')} className="group flex items-center">
                <button
                  type="button"
                  onClick={() => onOpen(r.source)}
                  title={r.source.paths.join('\n')}
                  className="hover:bg-fg/4 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
                >
                  <FolderGit2 className="text-fg-dim h-3.5 w-3.5 shrink-0" />
                  <span className="text-fg shrink-0 text-[12px]">{sourceLabel(r.source)}</span>
                  <span className="text-fg-dim min-w-0 truncate font-mono text-[10.5px]">
                    {r.source.paths[0]}
                  </span>
                  {r.source.kind !== 'auto' && (
                    <span className="text-fg-dim ml-auto shrink-0 text-[10.5px]">
                      {kindLabel(r.source.kind)}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={i18n.t('Forget {name}', { name: sourceLabel(r.source) })}
                  title={i18n.t('Remove from recent')}
                  onClick={() =>
                    void ipc
                      .manifestsRecentRemove(r.source.paths)
                      .then(onForget)
                      .catch(() => undefined)
                  }
                  className="text-fg-dim hover:text-fg hover:bg-fg/8 ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function NestedList({
  render,
  onOpen,
}: {
  render: ManifestRender;
  onOpen: (source: ManifestSource) => void;
}) {
  i18n.useLocale();
  return (
    <ul className="space-y-px">
      {render.nested.map((n) => (
        <li key={n.path}>
          <button
            type="button"
            onClick={() => onOpen({ paths: [n.path], kind: n.kind, helm: null })}
            className="hover:bg-fg/4 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[12px]"
            title={n.path}
          >
            <FolderGit2 className="text-accent h-3.5 w-3.5 shrink-0" />
            <span className="text-fg min-w-0 truncate font-mono text-[11.5px]">{n.relative}</span>
            <span className="text-fg-dim shrink-0 text-[10.5px]">{kindLabel(n.kind)}</span>
            <span className="text-accent ml-auto shrink-0 text-[11px]">{i18n.t('Open')}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ProblemsPanel({
  render,
  onOpen,
  onClose,
}: {
  render: ManifestRender;
  onOpen: (source: ManifestSource) => void;
  onClose: () => void;
}) {
  i18n.useLocale();
  return (
    <div className="border-border/60 bg-surface flex max-h-[40%] min-h-0 shrink-0 flex-col border-b">
      <div className="text-fg-dim flex h-7 shrink-0 items-center gap-2 px-3 text-[11px]">
        <span className="text-fg-muted font-semibold tracking-[0.06em] uppercase">
          {i18n.t('Not loaded')}
        </span>
        <button
          type="button"
          onClick={onClose}
          title={i18n.t('Dismiss')}
          aria-label={i18n.t('Dismiss')}
          className="text-fg-dim hover:text-fg hover:bg-surface-overlay rounded-app-sm ml-auto flex h-5 w-5 items-center justify-center transition"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="overlay-scroll min-h-0 overflow-y-auto px-2 pb-2">
        {render.nested.length > 0 && (
          <>
            <p className="text-fg-dim px-1.5 pb-1 text-[11px]">
              {i18n.t('Kustomize directories and charts render on their own:')}
            </p>
            <NestedList render={render} onOpen={onOpen} />
          </>
        )}
        {render.problems.length > 0 && (
          <ul className={cn(render.nested.length > 0 && 'mt-2')}>
            {render.problems.map((p, i) => (
              <li
                key={`${p.source}:${p.line}:${i}`}
                className="rounded-app-sm hover:bg-fg/5 flex items-start gap-2 px-1.5 py-1 text-[12px]"
              >
                <AlertTriangle className="text-status-starting mt-0.5 h-3 w-3 shrink-0" />
                <span className="text-fg shrink-0 font-mono text-[11.5px]">
                  {p.source}
                  {p.line ? `:${p.line}` : ''}
                </span>
                <span className="text-fg-dim min-w-0 flex-1 text-[11.5px] break-words">
                  {p.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NoDocuments({
  render,
  onOpen,
}: {
  render: ManifestRender;
  onOpen: (source: ManifestSource) => void;
}) {
  i18n.useLocale();
  return (
    <div className="overlay-scroll flex min-h-0 flex-1 flex-col items-center overflow-auto px-6 py-8">
      <p className="text-fg text-[12.5px] font-medium">
        {i18n.t('No Kubernetes objects in {name}', { name: baseName(render.root) })}
      </p>
      {render.nested.length > 0 ? (
        <div className="mt-3 w-full max-w-lg">
          <p className="text-fg-dim mb-1 px-2 text-[11.5px]">
            {i18n.t('It contains Kustomize directories or charts that render on their own:')}
          </p>
          <NestedList render={render} onOpen={onOpen} />
        </div>
      ) : (
        <p className="text-fg-dim mt-1 text-[12px]">
          {render.problems.length > 0
            ? i18n.plural(
                '{count} file or document was skipped (see the warnings).',
                '{count} files or documents were skipped (see the warnings).',
                render.problems.length,
              )
            : i18n.t('Only .yaml, .yml and .json files are read.')}
        </p>
      )}
    </div>
  );
}
