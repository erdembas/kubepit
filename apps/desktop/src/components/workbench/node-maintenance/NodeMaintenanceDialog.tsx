import * as i18n from '@/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, RefreshCw } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { isTauri } from '@/lib/ipc/invoke';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import { useCan } from '@/store/useAccessStore';
import type { AccessCheck } from '@/types';
import type {
  NodeMaintenancePlan,
  NodeMaintenanceProgress,
  NodeMaintenanceReceipt,
  NodeMaintenanceVolume,
} from '@/types/nodeMaintenance';
import { confirmDestructive } from '../actions/guard';
import {
  drainReviewBlock,
  evictionLabel,
  maintenanceMessage,
  maintenanceObservedReady,
  MONITOR_WINDOW_MS,
  sourceLabel,
} from './model';

export function NodeMaintenanceDialog({
  clusterId,
  name,
  onClose,
}: {
  clusterId: string;
  name: string;
  onClose: () => void;
}) {
  i18n.useLocale();
  const cluster = useAppStore((state) => state.clusters.find((item) => item.id === clusterId));
  const [plan, setPlan] = useState<NodeMaintenancePlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<NodeMaintenanceReceipt | null>(null);
  const [progress, setProgress] = useState<NodeMaintenanceProgress | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [monitorStarted, setMonitorStarted] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const generation = useRef(0);
  const latestProgress = useRef<NodeMaintenanceProgress | null>(null);
  const close = () => {
    if (useAppStore.getState().confirm) return;
    generation.current++;
    onClose();
  };
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    setReviewed(false);
    setPlan(null);
    setReceipt(null);
    setProgress(null);
    setProgressError(null);
    setMonitorStarted(null);
    setExpired(false);
    latestProgress.current = null;
    try {
      const value = await ipc.nodeMaintenancePreflight(clusterId, name);
      if (generation.current === current) setPlan(value);
    } catch (error) {
      if (generation.current === current) setError(maintenanceMessage(error));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [clusterId, name]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const checks = useMemo<AccessCheck[]>(
    () =>
      !plan
        ? []
        : [
            {
              verb: 'patch',
              group: '',
              resource: 'nodes',
              name,
              namespace: null,
              subresource: null,
            },
            ...plan.pods
              .filter((pod) => pod.action === 'evict')
              .map((pod) => ({
                verb: 'create',
                group: '',
                resource: 'pods',
                subresource: 'eviction',
                namespace: pod.namespace,
                name: pod.name,
              })),
          ],
    [plan, name],
  );
  const canDrain = useCan(clusterId, checks, { enabled: !!plan && !cluster?.read_only });
  const observedReady = !!plan && maintenanceObservedReady(plan, progress, receipt);
  useEffect(() => {
    if (!plan || monitorStarted === null || observedReady || expired) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() - monitorStarted >= MONITOR_WINDOW_MS) {
        setExpired(true);
        return;
      }
      try {
        const value = await ipc.nodeMaintenanceProgress(clusterId, plan.plan_id);
        if (!cancelled) {
          latestProgress.current = value;
          setProgress(value);
          setProgressError(null);
        }
      } catch (error) {
        if (!cancelled && !String(error).includes('not-started'))
          setProgressError(maintenanceMessage(error));
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [clusterId, plan, monitorStarted, observedReady, expired]);
  const drain = () => {
    if (
      !plan ||
      !reviewed ||
      busy ||
      cluster?.read_only ||
      canDrain === 'denied' ||
      drainReviewBlock(plan)
    )
      return;
    const current = generation.current;
    confirmDestructive({
      cluster,
      title: i18n.t('Drain node'),
      typeName: name,
      confirmLabel: i18n.t('Cordon and request evictions'),
      message: i18n.t(
        'Apply the reviewed plan for {name}? PDBs are enforced, but local data can be lost and replacement scheduling is not guaranteed.',
        { name },
      ),
      run: async () => {
        if (generation.current !== current) return;
        const latest = useAppStore.getState();
        const currentCluster = latest.clusters.find((item) => item.id === clusterId);
        if (currentCluster?.read_only) {
          setError(maintenanceMessage('read-only'));
          return;
        }
        if (latest.statuses[clusterId]?.state !== 'connected') {
          setError(maintenanceMessage('disconnected'));
          return;
        }
        if (!currentCluster || currentCluster.environment !== cluster?.environment) {
          setError(maintenanceMessage('stale-plan'));
          return;
        }
        setBusy(true);
        setError(null);
        setMonitorStarted(Date.now());
        try {
          const value = await ipc.nodeMaintenanceDrain(clusterId, {
            plan_id: plan.plan_id,
            name: plan.node_name,
            node_uid: plan.node_uid,
            fingerprint: plan.fingerprint,
          });
          if (generation.current === current) setReceipt(value);
        } catch (error) {
          if (generation.current !== current) return;
          setError(maintenanceMessage(error));
          try {
            const value = await ipc.nodeMaintenanceProgress(clusterId, plan.plan_id);
            if (generation.current !== current) return;
            latestProgress.current = value;
            setProgress(value);
            if (value.node_cordoned === false) setMonitorStarted(null);
          } catch {
            if (generation.current === current && latestProgress.current?.node_cordoned !== true)
              setMonitorStarted(null);
          }
        } finally {
          if (generation.current === current) setBusy(false);
        }
      },
    });
  };
  const block = plan
    ? drainReviewBlock({ ...plan, read_only: !!cluster?.read_only || plan.read_only })
    : null;
  const affected = plan?.pods.filter((pod) => pod.action === 'evict') ?? [];
  return (
    <Dialog
      title={i18n.t('Node maintenance')}
      subtitle={name}
      size="xl"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {i18n.t('Close')}
          </Button>
          <Button
            disabled={loading || busy}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => void load()}
          >
            {receipt ? i18n.t('Review remaining Pods') : i18n.t('Refresh preflight')}
          </Button>
          {!receipt && (
            <Button
              variant="danger"
              disabled={!plan || !!block || !reviewed || busy || loading || canDrain === 'denied'}
              onClick={drain}
              leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
            >
              {busy
                ? i18n.t('Submitting reviewed evictions…')
                : i18n.t('Cordon and request evictions')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-[12px]">
        <p className="text-fg-muted">
          {i18n.t(
            'Review affected Pods, disruption budgets and local data before cordoning. This is not a scheduler simulation or an availability guarantee.',
          )}
        </p>
        {!isTauri && (
          <Notice>
            {i18n.t(
              'Demo maintenance uses fixture data and simulated Pod replacements. No real cluster is changed.',
            )}
          </Notice>
        )}
        {loading && (
          <p role="status" className="text-fg-dim flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Reading the node maintenance plan…')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-status-error whitespace-pre-wrap">
            {error}
          </p>
        )}
        {plan && (
          <>
            <div className="text-fg-dim flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
              <span>
                {i18n.t('Checked {time}', { time: new Date(plan.checked_at).toLocaleTimeString() })}
              </span>
              <span>
                {i18n.plural('{count} Pod to evict', '{count} Pods to evict', affected.length)}
              </span>
              <span>
                {i18n.t('Node cordoned: {value}', {
                  value: plan.unschedulable ? i18n.t('Yes') : i18n.t('No'),
                })}
              </span>
            </div>
            {block && <Notice>{maintenanceMessage(block)}</Notice>}
            {canDrain === 'denied' && (
              <Notice>
                {i18n.t(
                  'RBAC denies a required mutation. The preflight remains available for inspection.',
                )}
              </Notice>
            )}
            {plan.warnings.map((warning) => (
              <Notice key={warning}>{maintenanceMessage(warning)}</Notice>
            ))}
            <section>
              <Heading>{i18n.t('Affected and skipped Pods')}</Heading>
              <div className="border-border/60 mt-2 overflow-x-auto rounded-md border">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-fg/3 text-fg-dim">
                    <tr>
                      <th className="p-2">{i18n.t('Pod')}</th>
                      <th className="p-2">{i18n.t('Plan')}</th>
                      <th className="p-2">{i18n.t('Controller')}</th>
                      <th className="p-2">{i18n.t('Local data risks')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.pods.map((pod) => (
                      <tr
                        key={pod.uid || `${pod.namespace}/${pod.name}`}
                        className="border-border/40 border-t"
                      >
                        <td className="p-2 font-mono">
                          {pod.namespace}/{pod.name}
                          <p className="text-fg-dim mt-1">
                            {pod.phase}
                            {pod.terminating ? ` · ${i18n.t('Terminating')}` : ''}
                          </p>
                        </td>
                        <td className="p-2">
                          {pod.action === 'evict'
                            ? i18n.t('Evict')
                            : pod.action === 'unmanaged'
                              ? i18n.t('Unmanaged — blocked')
                              : pod.action === 'daemonset'
                                ? i18n.t('Skip DaemonSet Pod')
                                : i18n.t('Skip mirror Pod')}
                        </td>
                        <td className="p-2 font-mono">
                          {pod.owner ? `${pod.owner.kind}/${pod.owner.name}` : '—'}
                        </td>
                        <td className="p-2">
                          {pod.volumes.length ? (
                            pod.volumes.map((volume, index) => (
                              <p key={index} className="text-status-starting">
                                {volumeLabel(volume)}
                              </p>
                            ))
                          ) : (
                            <span className="text-fg-dim">
                              {i18n.t('No listed local volume risk')}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!plan.pods.length && (
                <p className="text-fg-dim mt-2">{i18n.t('No Pods were returned for this node.')}</p>
              )}
            </section>
            <section>
              <Heading>{i18n.t('PodDisruptionBudget impact')}</Heading>
              <p className="text-fg-dim mt-1 text-[11px]">
                {i18n.t(
                  'The same PDB budget is shared by all matching Pods. A shortfall can require several reviewed drain attempts as replacements become ready; the API server decides each eviction.',
                )}
              </p>
              {plan.pdbs.map((pdb) => (
                <div
                  key={pdb.uid || `${pdb.namespace}/${pdb.name}`}
                  className="border-border/60 mt-2 rounded-md border p-3"
                >
                  <p className="font-mono">
                    {pdb.namespace}/{pdb.name}
                  </p>
                  <p
                    className={
                      pdb.disruptions_allowed === null ||
                      pdb.required_disruptions > pdb.disruptions_allowed
                        ? 'text-status-starting mt-1 text-[11px]'
                        : 'text-fg-muted mt-1 text-[11px]'
                    }
                  >
                    {i18n.t(
                      '{matched} matching Pods · {required} estimated disruptions · {allowed} currently allowed',
                      {
                        matched: pdb.matched_pods.length,
                        required: pdb.required_disruptions,
                        allowed: pdb.disruptions_allowed ?? i18n.t('Unknown'),
                      },
                    )}
                  </p>
                  <p className="text-fg-dim mt-1 font-mono text-[10px] break-all">{pdb.selector}</p>
                  <p className="text-fg-dim mt-1 font-mono text-[10px]">{pdb.unhealthy_policy}</p>
                </div>
              ))}
              {!plan.pdbs.length && (
                <p className="text-fg-dim mt-2 text-[11px]">
                  {plan.pdbs_complete
                    ? i18n.t('No matching PDB was found in the inspected inventory.')
                    : i18n.t('Matching PDB coverage is unknown.')}
                </p>
              )}
            </section>
            {!receipt && (
              <label className="text-fg-muted border-border/60 flex items-start gap-2 border-t pt-3">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(event) => setReviewed(event.target.checked)}
                  className="accent-accent mt-0.5"
                />
                <span>
                  {i18n.t(
                    'I reviewed the affected Pods, shared disruption budgets and possible local data loss.',
                  )}
                </span>
              </label>
            )}
            {(busy || receipt || progress) && (
              <section className="border-border/60 space-y-3 border-t pt-4">
                <Heading>{i18n.t('Drain observations')}</Heading>
                <p className="text-fg-dim text-[11px]">
                  {i18n.t(
                    'Eviction accepted does not mean a Pod has exited or a replacement is ready. New Pods are matched by controller UID and must be Ready on another node. Scaling or controller changes can affect these observations.',
                  )}
                </p>
                {observedReady ? (
                  <p className="text-status-running flex items-center gap-2">
                    <Check className="h-4 w-4" />
                    {i18n.t(
                      'Sources are gone and enough new workload Pods are observed Ready elsewhere.',
                    )}
                  </p>
                ) : expired ? (
                  <Notice>
                    {i18n.t(
                      'Five-minute monitoring window ended. Inspect the current node and workload states before continuing maintenance.',
                    )}
                  </Notice>
                ) : monitorStarted !== null ? (
                  <p role="status" className="text-fg-dim flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {i18n.t('Watching source Pods and new workload Pods…')}
                  </p>
                ) : null}
                {expired && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setExpired(false);
                      setMonitorStarted(Date.now());
                    }}
                  >
                    {i18n.t('Monitor for another five minutes')}
                  </Button>
                )}
                {progressError && <Notice>{progressError}</Notice>}
                {progress?.warnings.map((warning) => (
                  <Notice key={warning}>{maintenanceMessage(warning)}</Notice>
                ))}
                {progress && (
                  <p className="text-fg-dim text-[11px]">
                    {i18n.t('Node cordoned: {value}', {
                      value:
                        progress.node_cordoned === null
                          ? i18n.t('Unknown')
                          : progress.node_cordoned
                            ? i18n.t('Yes')
                            : i18n.t('No'),
                    })}
                  </p>
                )}
                {affected.map((pod) => {
                  const result = receipt?.evictions.find((item) => item.uid === pod.uid);
                  const source = progress?.sources.find((item) => item.uid === pod.uid);
                  return (
                    <div
                      key={pod.uid}
                      className="border-border/60 rounded-md border p-2 text-[11px]"
                    >
                      <p className="font-mono">
                        {pod.namespace}/{pod.name}
                      </p>
                      <p className="text-fg-muted mt-1">
                        {result ? evictionLabel(result.status) : i18n.t('Eviction request pending')}{' '}
                        · {sourceLabel(source?.state ?? 'unknown')}
                      </p>
                      {result?.error && (
                        <pre className="text-status-starting mt-1 whitespace-pre-wrap">
                          {maintenanceMessage(result.error)}
                        </pre>
                      )}
                    </div>
                  );
                })}
                {progress?.workloads.map((workload) => (
                  <div
                    key={`${workload.namespace}/${workload.owner.uid}`}
                    className="border-border/60 rounded-md border p-3 text-[11px]"
                  >
                    <p className="font-mono">
                      {workload.namespace}/{workload.owner.kind}/{workload.owner.name}
                    </p>
                    <p className="text-fg-muted mt-1">
                      {i18n.t('{ready} new Pods Ready elsewhere; {expected} source Pods reviewed', {
                        ready: workload.replacements.filter(
                          (pod) => pod.ready && pod.node && pod.node !== name,
                        ).length,
                        expected: workload.expected_replacements,
                      })}
                    </p>
                    {!workload.complete && (
                      <p className="text-status-starting mt-1">
                        {maintenanceMessage('workloads-partial')}
                      </p>
                    )}
                    {workload.replacements.map((pod) => (
                      <p key={pod.uid} className="text-fg-dim mt-1 font-mono">
                        {pod.name} · {pod.node || '—'} · {pod.phase} ·{' '}
                        {pod.ready ? i18n.t('Ready') : i18n.t('Not ready')}
                      </p>
                    ))}
                  </div>
                ))}
                <p className="text-fg-dim text-[11px]">
                  {i18n.t(
                    'Closing stops this monitor. Accepted evictions continue and the node is not automatically uncordoned.',
                  )}
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
function volumeLabel(volume: NodeMaintenanceVolume) {
  switch (volume.kind) {
    case 'empty-dir':
      return i18n.t('emptyDir {name}: contents are lost on eviction', { name: volume.name });
    case 'host-path':
      return i18n.t('hostPath {name}: data stays on this node', { name: volume.name });
    case 'local-pv':
      return i18n.t('Local PV claim {name}: replacement placement may be constrained', {
        name: volume.name,
      });
    default:
      return i18n.t('PVC {name}: backing storage could not be verified', { name: volume.name });
  }
}
function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-fg-muted text-[11px] font-semibold tracking-wider uppercase">{children}</h3>
  );
}
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-status-starting/20 bg-status-starting/5 text-status-starting flex items-start gap-2 rounded-md border px-3 py-2 text-[11px]">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
