import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRightLeft, Loader2, ScanSearch } from 'lucide-react';
import { stringify } from 'yaml';
import { Button } from '@/components/ui/Button';
import { ClusterAvatar } from '@/components/workbench/ClusterAvatar';
import { ipc } from '@/lib/ipc';
import { syncBlocker, toSyncManifest } from '@/lib/kube/syncable';
import { useAppStore } from '@/store/useAppStore';
import type { CompareSide } from '@/store/useDockStore';
import type { ClusterDef, ClusterId, Gvk } from '@/types';
import { errorText } from '../../util';
import { BarLabel, EditorBanner, EditorBar } from '../editor/EditorChrome';
import { ApplyButton } from '../manifests/ApplyButton';
import { FleetReviewPane, useReviewControls } from '../manifests/FleetReview';
import { reviewTarget, type ReviewDoc } from '../manifests/model';
import { TargetPicker } from '../manifests/TargetPicker';
import { useFleetReview } from '../manifests/useFleetReview';
import { servedGvk } from './compareData';

/** What "Sync to…" was opened with. */
export interface SyncRequest {
  source: CompareSide;
  /** Preselected targets (clusters that differ or miss the object). */
  targets: ClusterId[];
  /** Preselected target namespace; defaults to the source's. */
  namespace: string | null;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; doc: ReviewDoc; namespaced: boolean }
  | { status: 'blocked'; message: string }
  | { status: 'error'; message: string };

/**
 * "Sync to…" from compare / drift: the source cluster's object, stripped
 * of everything that cluster assigned (`lib/kube/syncable.ts`), dry-run on
 * the chosen target clusters and namespace, then applied where selected —
 * the same review → apply flow as local manifests, with a per-target result.
 */
export function SyncPanel({
  gvk,
  request,
  onClose,
}: {
  gvk: Gvk;
  request: SyncRequest;
  onClose: () => void;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const sourceCluster = clusters.find((c) => c.id === request.source.clusterId) ?? null;
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [targets, setTargets] = useState<ClusterId[]>(request.targets);
  const [namespace, setNamespace] = useState(request.namespace ?? request.source.namespace ?? '');
  const { review, run, apply, denied } = useFleetReview();
  const controls = useReviewControls(review, denied);
  const source = request.source;
  const objectLabel = `${source.namespace ? `${source.namespace}/` : ''}${source.name}`;

  useEffect(() => {
    let alive = true;
    setLoaded({ status: 'loading' });
    (async () => {
      const served = await servedGvk(source.clusterId, gvk);
      if (!served) throw new Error(i18n.t('The source cluster does not serve this kind.'));
      const obj = await ipc.resourceGet(
        source.clusterId,
        served,
        served.namespaced ? source.namespace : null,
        source.name,
      );
      const blocker = syncBlocker(obj);
      if (blocker) {
        return {
          status: 'blocked',
          message:
            blocker === 'controlled'
              ? i18n.t(
                  '{kind} {name} is managed by a controller that would revert a copy. Sync its owner instead.',
                  { kind: obj.kind, name: obj.metadata.name },
                )
              : i18n.t('{kind} objects describe one cluster and are never synced.', {
                  kind: obj.kind,
                }),
        } as Loaded;
      }
      const manifest = toSyncManifest(obj);
      const doc: ReviewDoc = {
        id: `${served.group}/${obj.kind}/${obj.metadata.name}`,
        source: `${sourceCluster?.name ?? source.clusterId} · ${objectLabel}`,
        line: 0,
        apiVersion: obj.apiVersion,
        kind: obj.kind,
        name: obj.metadata.name,
        namespace: null,
        yaml: stringify(manifest, { lineWidth: 0, aliasDuplicateObjects: false }),
      };
      return { status: 'ready', doc, namespaced: served.namespaced } as Loaded;
    })()
      .then((next) => alive && setLoaded(next))
      .catch((e: unknown) => alive && setLoaded({ status: 'error', message: errorText(e) }));
    return () => {
      alive = false;
    };
    // The source object is fixed for the panel's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.clusterId, source.namespace, source.name, gvk.group, gvk.plural]);

  const ready = loaded.status === 'ready' ? loaded : null;
  const pickedTargets = useMemo(
    () =>
      targets
        .map((id) => clusters.find((c) => c.id === id))
        .filter((c): c is ClusterDef => !!c)
        .map((c) => reviewTarget(c, ready?.namespaced ? namespace.trim() || null : null)),
    [targets, clusters, namespace, ready?.namespaced],
  );
  const docs = useMemo(() => (ready ? [ready.doc] : []), [ready]);
  const sameAsSource = pickedTargets.some(
    (t) => t.clusterId === source.clusterId && (t.namespace ?? null) === (source.namespace ?? null),
  );

  const diff = () => {
    if (!docs.length || !pickedTargets.length || sameAsSource) return;
    run(docs, pickedTargets);
  };
  // Review right away: a dry run only reads.
  const autoRun = useRef(false);
  useEffect(() => {
    if (ready && !autoRun.current && pickedTargets.length && !sameAsSource) {
      autoRun.current = true;
      run(docs, pickedTargets);
    }
  }, [ready, docs, pickedTargets, sameAsSource, run]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorBar>
        <ArrowRightLeft className="text-accent h-3.5 w-3.5 shrink-0" />
        <span className="text-fg-muted flex min-w-0 items-center gap-1.5 text-[12px] whitespace-nowrap">
          {i18n.rich('Sync {kind} {object} from {cluster}', {
            kind: <span className="text-fg font-medium">{gvk.kind}</span>,
            object: (
              <span className="text-fg min-w-0 truncate font-mono text-[11.5px]">
                {objectLabel}
              </span>
            ),
            cluster: (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {sourceCluster && <ClusterAvatar cluster={sourceCluster} />}
                <span className="text-fg max-w-40 truncate">
                  {sourceCluster?.name ?? source.clusterId}
                </span>
              </span>
            ),
          })}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<ArrowLeft className="h-3 w-3" />}
            onClick={onClose}
            disabled={controls.applying}
          >
            {i18n.t('Back')}
          </Button>
        </div>
      </EditorBar>
      <EditorBar>
        <BarLabel>{i18n.t('To')}</BarLabel>
        <TargetPicker value={targets} onChange={setTargets} disabled={controls.applying} />
        {ready?.namespaced && (
          <>
            <span aria-hidden className="bg-border/70 mx-1 h-4 w-px shrink-0" />
            <BarLabel>{i18n.t('Namespace')}</BarLabel>
            <input
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              aria-label={i18n.t('Target namespace')}
              spellCheck={false}
              className="border-border bg-surface-raised text-fg placeholder:text-fg-dim focus:border-accent rounded-app-sm h-6 w-36 shrink-0 border px-2 font-mono text-[11.5px] outline-none"
            />
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          <Button
            size="xs"
            variant="secondary"
            leftIcon={
              controls.running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ScanSearch className="h-3 w-3" />
              )
            }
            disabled={!ready || !pickedTargets.length || sameAsSource || controls.applying}
            title={
              sameAsSource
                ? i18n.t('A target is the source itself; pick another cluster or namespace.')
                : undefined
            }
            onClick={diff}
          >
            {review ? i18n.t('Diff again') : i18n.t('Diff')}
          </Button>
          <ApplyButton review={review} controls={controls} stale={false} onApply={apply} />
        </div>
      </EditorBar>
      {loaded.status === 'loading' ? (
        <div className="text-fg-dim flex flex-1 items-center justify-center gap-2 text-[12px]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {i18n.t('Reading the source object…')}
        </div>
      ) : loaded.status === 'blocked' || loaded.status === 'error' ? (
        <EditorBanner tone={loaded.status === 'blocked' ? 'warning' : 'error'}>
          {loaded.message}
        </EditorBanner>
      ) : (
        <>
          {sameAsSource && (
            <EditorBanner tone="warning">
              {i18n.t('A target is the source itself; pick another cluster or namespace.')}
            </EditorBanner>
          )}
          <FleetReviewPane
            docs={review ? review.docs : docs}
            targets={review ? review.targets : pickedTargets}
            review={review}
            controls={controls}
            groupSources={false}
            stale={false}
          />
        </>
      )}
    </div>
  );
}
