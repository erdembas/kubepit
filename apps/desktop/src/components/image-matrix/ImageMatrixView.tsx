import * as i18n from '@/i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, ChevronRight, Layers, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { openObject } from '@/lib/navigation';
import { useAppStore } from '@/store/useAppStore';
import { useVisibleStore } from '@/lib/useVisibleStore';
import { useWatch } from '@/components/workbench/data/watchCache';
import { isListComplete } from '@/components/workbench/data/listState';
import {
  buildMatrixCluster,
  imageRows,
  matrixClusterSelection,
  MATRIX_ROW_LIMIT,
  type ImageCell,
  type MatrixCluster,
} from './model';

const GVKS = [
  BUILTIN.Deployment,
  BUILTIN.StatefulSet,
  BUILTIN.DaemonSet,
  BUILTIN.ReplicaSet,
  BUILTIN.Pod,
  BUILTIN.Node,
].map(toGvk);
const MAX_CLUSTERS = 8;
interface Collected {
  scope: string;
  data: MatrixCluster;
  errors: string[];
  loading: boolean;
}

function ClusterImages({
  clusterId,
  namespace,
  visible,
  onData,
}: {
  clusterId: string;
  namespace: string;
  visible: boolean;
  onData: (id: string, data: Collected) => void;
}) {
  const namespaces = useMemo(() => (namespace ? [namespace] : []), [namespace]);
  const deployments = useWatch(clusterId, GVKS[0]!, namespaces, visible);
  const statefulSets = useWatch(clusterId, GVKS[1]!, namespaces, visible);
  const daemonSets = useWatch(clusterId, GVKS[2]!, namespaces, visible);
  const replicaSets = useWatch(clusterId, GVKS[3]!, namespaces, visible);
  const pods = useWatch(clusterId, GVKS[4]!, namespaces, visible);
  const nodes = useWatch(clusterId, GVKS[5]!, [], visible);
  const snapshot = useMemo(() => {
    const sources = [deployments, statefulSets, daemonSets, replicaSets, pods, nodes];
    const source = (s: typeof pods) => ({ items: s.items, complete: isListComplete(s) });
    return {
      scope: namespace,
      data: buildMatrixCluster({
        workloads: {
          Deployment: source(deployments),
          StatefulSet: source(statefulSets),
          DaemonSet: source(daemonSets),
        },
        replicaSets: source(replicaSets),
        pods: source(pods),
        nodes: source(nodes),
      }),
      errors: sources.flatMap((s, index) => (s.error ? [`${GVKS[index]!.kind}: ${s.error}`] : [])),
      loading: sources.some((s) => !s.synced && s.status !== 'error' && !s.error),
    };
  }, [namespace, deployments, statefulSets, daemonSets, replicaSets, pods, nodes]);
  useEffect(() => {
    if (visible) onData(clusterId, snapshot);
  }, [clusterId, snapshot, onData, visible]);
  return null;
}

export function ImageMatrixView({ visible }: { visible: boolean }) {
  i18n.useLocale();
  const clusters = useVisibleStore(useAppStore, (s) => s.clusters, visible);
  const statuses = useVisibleStore(useAppStore, (s) => s.statuses, visible);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [namespace, setNamespace] = useState('');
  const [namespaceDraft, setNamespaceDraft] = useState('');
  const [query, setQuery] = useState('');
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [collected, setCollected] = useState<Record<string, Collected>>({});
  const [detail, setDetail] = useState<{ clusterId: string; key: string } | null>(null);
  const ids = useMemo(
    () =>
      matrixClusterSelection(
        clusters.map((c) => c.id),
        selection,
        MAX_CLUSTERS,
      ),
    [selection, clusters],
  );
  const targets = useMemo(() => clusters.filter((c) => ids.includes(c.id)), [clusters, ids]);
  const accept = useCallback(
    (id: string, data: Collected) => setCollected((old) => ({ ...old, [id]: data })),
    [],
  );
  const connected = targets.filter((c) => statuses[c.id]?.state === 'connected');
  const activeData = useMemo(
    () =>
      Object.fromEntries(
        targets.flatMap((c) => {
          const entry = collected[c.id];
          return statuses[c.id]?.state === 'connected' && entry?.scope === namespace
            ? [[c.id, entry.data]]
            : [];
        }),
      ),
    [targets, collected, namespace, statuses],
  );
  const rows = useMemo(() => imageRows(activeData), [activeData]);
  const filtered = rows.filter((row) => {
    if (
      differencesOnly &&
      !row.differentDesired &&
      !Object.values(row.cells).some((c) => c.templateDiffers || c.runtimeReferenceDiffers)
    )
      return false;
    const e = row.example;
    const haystack = [
      e.kind,
      e.namespace,
      e.name,
      e.container,
      ...Object.values(row.cells).flatMap((c) => [
        c.desired ?? '',
        ...c.observed,
        ...c.runtime.flatMap((runtime) => [runtime.image ?? '', runtime.imageId ?? '']),
      ]),
    ]
      .join(' ')
      .toLocaleLowerCase();
    return haystack.includes(query.trim().toLocaleLowerCase());
  });
  const selectedCluster = clusters.find((c) => c.id === detail?.clusterId);
  const selectedCell = detail
    ? activeData[detail.clusterId]?.cells.find((c) => c.key === detail.key)
    : undefined;
  const validNamespace =
    !namespaceDraft.trim() || /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(namespaceDraft.trim());
  const choose = (id: string, checked: boolean) =>
    setSelection(
      checked ? [...ids, id].slice(0, MAX_CLUSTERS) : ids.filter((value) => value !== id),
    );
  return (
    <div className="bg-surface flex min-h-0 min-w-0 flex-1 flex-col">
      {connected.map((cluster) => (
        <ClusterImages
          key={`${cluster.id}:${namespace}`}
          clusterId={cluster.id}
          namespace={namespace}
          visible={visible}
          onData={accept}
        />
      ))}
      <header className="border-border/60 shrink-0 space-y-3 border-b p-4">
        <div className="flex items-center gap-2">
          <Layers className="text-accent h-4 w-4" />
          <h2 className="text-fg text-[13px] font-semibold">{i18n.t('Image version matrix')}</h2>
          <span className="text-fg-dim ml-auto text-[11px]">
            {i18n.t('{connected}/{total} selected clusters connected', {
              connected: connected.length,
              total: targets.length,
            })}
          </span>
        </div>
        <p className="text-fg-muted text-[12px]">
          {i18n.t(
            'Compare Deployment, StatefulSet and DaemonSet images across clusters. Rows match by kind, namespace, workload and container name.',
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-64"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={i18n.t('Filter workloads or images…')}
            aria-label={i18n.t('Filter workloads or images')}
          />
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (validNamespace) {
                setNamespace(namespaceDraft.trim());
                setDetail(null);
              }
            }}
          >
            <Input
              className="w-44"
              value={namespaceDraft}
              onChange={(e) => setNamespaceDraft(e.target.value)}
              placeholder={i18n.t('All namespaces')}
              aria-label={i18n.t('Matrix namespace')}
              aria-invalid={!validNamespace}
            />
            <Button size="sm" type="submit" disabled={!validNamespace}>
              {i18n.t('Apply scope')}
            </Button>
          </form>
          <label className="text-fg-muted flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              className="accent-accent"
              checked={differencesOnly}
              onChange={(e) => setDifferencesOnly(e.target.checked)}
            />
            {i18n.t('Image differences only')}
          </label>
        </div>
        <details className="text-fg-muted text-[12px]">
          <summary className="hover:text-fg cursor-pointer">
            {i18n.t('Choose clusters (up to {count})', { count: MAX_CLUSTERS })}
          </summary>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {clusters.map((cluster) => (
              <label key={cluster.id} className="flex items-center gap-2">
                <input
                  className="accent-accent"
                  type="checkbox"
                  checked={ids.includes(cluster.id)}
                  disabled={!ids.includes(cluster.id) && targets.length >= MAX_CLUSTERS}
                  onChange={(e) => choose(cluster.id, e.target.checked)}
                />
                {cluster.name}
              </label>
            ))}
          </div>
        </details>
        <p className="text-fg-dim text-[11px]">
          {i18n.t(
            'Live observations from connected clusters only. Runtime IDs are grouped by reported platform; different IDs alone do not prove a bad rollout.',
          )}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {!targets.length ? (
          <p className="text-fg-dim p-8 text-center text-[12px]">
            {i18n.t('Select a cluster to compare images.')}
          </p>
        ) : (
          <table className="w-full border-collapse text-left text-[12px]">
            <caption className="sr-only">{i18n.t('Image version matrix')}</caption>
            <thead className="bg-surface-raised sticky top-0 z-10">
              <tr>
                <th
                  scope="col"
                  className="border-border/60 bg-surface-raised sticky left-0 z-20 min-w-56 border-b px-4 py-3 text-[10px] font-semibold tracking-wide uppercase"
                >
                  {i18n.t('Workload / container')}
                </th>
                {targets.map((cluster) => {
                  const entry =
                    collected[cluster.id]?.scope === namespace ? collected[cluster.id] : undefined;
                  const online = statuses[cluster.id]?.state === 'connected';
                  return (
                    <th
                      scope="col"
                      key={cluster.id}
                      className="border-border/60 max-w-80 min-w-60 border-b px-4 py-3 align-top font-medium"
                    >
                      <div className="text-fg">{cluster.name}</div>
                      <div className="text-fg-dim mt-1 text-[11px]">
                        {cluster.environment ?? '—'}
                      </div>
                      <div className="text-fg-muted mt-1 flex items-center gap-1 text-[11px]">
                        {!online ? (
                          i18n.t('Not connected')
                        ) : !entry || entry.loading ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {i18n.t('Loading…')}
                          </>
                        ) : entry.errors.length || entry.data.truncated ? (
                          i18n.t('Partial evidence')
                        ) : (
                          i18n.t('Live')
                        )}
                      </div>
                      {online && !!entry?.errors.length && (
                        <details className="text-status-starting mt-1 text-[11px] font-normal">
                          <summary className="cursor-pointer">
                            {i18n.t('Unavailable sources')}
                          </summary>
                          {entry.errors.map((error) => (
                            <p className="mt-1 max-w-72 break-words" key={error}>
                              {error}
                            </p>
                          ))}
                        </details>
                      )}
                      {online && !!entry?.data.unattachedPods && (
                        <p className="text-fg-dim mt-1 text-[10px] font-normal">
                          {i18n.t('{count} active Pods outside the resolved workload rows', {
                            count: entry.data.unattachedPods,
                          })}
                        </p>
                      )}
                      {online && entry?.data.truncated && (
                        <p className="text-status-starting mt-1 text-[11px] font-normal">
                          {i18n.t('Source limit reached; this column is a sample.')}
                        </p>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, MATRIX_ROW_LIMIT).map((row) => (
                <tr key={row.key} className="hover:bg-fg/3">
                  <th
                    scope="row"
                    className="border-border/50 bg-surface sticky left-0 z-[1] border-b px-4 py-3 align-top font-normal"
                  >
                    <div className="text-fg font-medium">{row.example.name}</div>
                    <div className="text-fg-dim mt-1 text-[11px]">
                      {row.example.kind} · {row.example.namespace}
                    </div>
                    <div className="text-fg-muted mt-1 font-mono text-[11px]">
                      {row.example.container}
                      {row.example.init && (
                        <span className="ml-1 font-sans">({i18n.t('Init container')})</span>
                      )}
                    </div>
                    {row.differentDesired && (
                      <span className="text-accent mt-2 block text-[10px]">
                        {i18n.t('Different desired images')}
                      </span>
                    )}
                  </th>
                  {targets.map((cluster) => {
                    const cell = row.cells[cluster.id];
                    const data = activeData[cluster.id];
                    return (
                      <td key={cluster.id} className="border-border/50 border-b align-top">
                        {cell ? (
                          <button
                            type="button"
                            onClick={() => setDetail({ clusterId: cluster.id, key: cell.key })}
                            className="hover:bg-fg/5 focus-visible:outline-accent h-full w-full space-y-1.5 px-4 py-3 text-left"
                            aria-label={i18n.t('Inspect {workload} image in {cluster}', {
                              workload: `${cell.name}/${cell.container}`,
                              cluster: cluster.name,
                            })}
                          >
                            <div className="text-fg max-w-72 font-mono text-[11px] break-all">
                              {cell.desired ?? i18n.t('Not in current template')}
                            </div>
                            <div className="text-fg-muted text-[11px]">
                              {cell.complete
                                ? i18n.t('{ready}/{total} observed containers ready', {
                                    ready: cell.ready,
                                    total: cell.total,
                                  })
                                : i18n.t('Incomplete Pod evidence')}
                            </div>
                            {!!cell.observed.length && (
                              <div className="text-fg-dim text-[11px]">
                                {i18n.plural(
                                  '{count} Pod spec image reference',
                                  '{count} Pod spec image references',
                                  cell.observed.length,
                                )}
                              </div>
                            )}
                            {cell.templateDiffers && (
                              <div className="text-status-starting text-[11px]">
                                {i18n.t('Pod spec image differs from workload template')}
                              </div>
                            )}
                            {cell.runtimeReferenceDiffers && (
                              <div className="text-accent text-[11px]">
                                {i18n.t('Runtime reports a different image reference')}
                              </div>
                            )}
                            <span className="text-fg-dim flex items-center gap-1 text-[10px]">
                              {i18n.t('Inspect evidence')}
                              <ChevronRight className="h-3 w-3" />
                            </span>
                          </button>
                        ) : (
                          <p className="text-fg-dim px-4 py-3 text-[11px]">
                            {!data || !data.completeKinds.has(row.example.kind)
                              ? i18n.t('Unknown')
                              : data.workloadKeys.has(row.example.workloadKey)
                                ? i18n.t('Container not observed')
                                : i18n.t('Workload not found in scope')}
                          </p>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!!targets.length && !filtered.length && (
          <div className="text-fg-dim flex flex-col items-center gap-3 p-8 text-center text-[12px]">
            <Boxes className="h-6 w-6" />
            <p>
              {!connected.length
                ? i18n.t('Connect a cluster from its workspace to see its image versions.')
                : i18n.t('No matching workload images in the available evidence.')}
            </p>
          </div>
        )}
        {filtered.length > MATRIX_ROW_LIMIT && (
          <p className="text-status-starting p-4 text-[11px]">
            {i18n.t('Showing the first {count} rows. Narrow the namespace or text filter.', {
              count: MATRIX_ROW_LIMIT,
            })}
          </p>
        )}
      </div>
      {detail && (
        <Dialog
          title={i18n.t('Image evidence')}
          subtitle={selectedCluster?.name}
          onClose={() => setDetail(null)}
          size="lg"
          footer={
            <Button
              size="sm"
              disabled={!selectedCell || statuses[detail.clusterId]?.state !== 'connected'}
              onClick={() => {
                if (
                  selectedCell &&
                  useAppStore.getState().statuses[detail.clusterId]?.state === 'connected'
                ) {
                  openObject(
                    detail.clusterId,
                    selectedCell.kind,
                    selectedCell.namespace,
                    selectedCell.name,
                  );
                  setDetail(null);
                }
              }}
            >
              {i18n.t('Open workload')}
            </Button>
          }
        >
          {selectedCell ? (
            <ImageEvidence cell={selectedCell} />
          ) : (
            <p className="text-fg-muted text-[12px]">
              {i18n.t(
                'This observation is no longer available. Reconnect or choose a current row.',
              )}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}

function ImageEvidence({ cell }: { cell: ImageCell }) {
  i18n.useLocale();
  return (
    <div className="space-y-4 text-[12px]">
      <p className="text-fg font-medium">
        {cell.kind} · {cell.namespace}/{cell.name} · {cell.container}
      </p>
      <div>
        <h3 className="text-fg-dim text-[10px] tracking-wide uppercase">
          {i18n.t('Desired image')}
        </h3>
        <p className="text-fg mt-1 font-mono break-all">
          {cell.desired ?? i18n.t('Not in current template')}
        </p>
      </div>
      {!cell.complete && (
        <p className="text-status-starting">
          {i18n.t(
            'Pod or ownership evidence is incomplete. Counts describe only the observed sample.',
          )}
        </p>
      )}
      <div>
        <h3 className="text-fg-dim text-[10px] tracking-wide uppercase">
          {i18n.t('Pod spec image references')}
        </h3>
        {cell.observed.map((image) => (
          <p className="text-fg mt-1 font-mono text-[11px] break-all" key={image}>
            {image}
          </p>
        ))}
        {!cell.observed.length && (
          <p className="text-fg-muted mt-1">
            {i18n.t(
              'No active Pod containers observed. This can include workloads scaled to zero.',
            )}
          </p>
        )}
      </div>
      <p className="text-fg-muted">
        {i18n.t(
          'Runtime image IDs are reported by the container runtime. An OCI index and its platform image may have different digests; this view does not query a registry or infer which version is newest.',
        )}
      </p>
      {cell.runtimeReferenceDiffers && (
        <p className="text-fg-muted">
          {i18n.t(
            'A runtime-reported image reference differs from its Pod spec. Different tag or digest forms alone do not prove a bad rollout; inspect the reported fields together.',
          )}
        </p>
      )}
      {cell.runtime.map((runtime) => (
        <div
          className="border-border/60 rounded-md border p-3"
          key={JSON.stringify([
            runtime.podSpecImage,
            runtime.image,
            runtime.imageId,
            runtime.platform,
          ])}
        >
          <div className="text-fg-muted flex justify-between text-[11px]">
            <span>{runtime.platform ?? i18n.t('Unknown platform')}</span>
            <span>{i18n.plural('{count} container', '{count} containers', runtime.count)}</span>
          </div>
          <dl className="mt-2 space-y-2 text-[11px]">
            <div>
              <dt className="text-fg-dim">{i18n.t('Pod spec image reference')}</dt>
              <dd className="text-fg mt-0.5 font-mono break-all">{runtime.podSpecImage}</dd>
            </div>
            <div>
              <dt className="text-fg-dim">{i18n.t('Runtime-reported image reference')}</dt>
              <dd className="text-fg mt-0.5 font-mono break-all">
                {runtime.image ?? i18n.t('Not reported')}
              </dd>
            </div>
            <div>
              <dt className="text-fg-dim">{i18n.t('Runtime image ID')}</dt>
              <dd className="text-fg mt-0.5 font-mono break-all">
                {runtime.imageId ?? i18n.t('Not reported')}
              </dd>
            </div>
          </dl>
        </div>
      ))}
      {!!cell.unknownRuntime && (
        <p className="text-fg-dim">
          {i18n.t('{count} containers have no reported runtime image ID.', {
            count: cell.unknownRuntime,
          })}
        </p>
      )}
    </div>
  );
}
