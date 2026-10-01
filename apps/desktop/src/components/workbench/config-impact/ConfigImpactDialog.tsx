import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ipc } from '@/lib/ipc';
import { accessCheck } from '@/lib/kube/access';
import { gitopsOwnerRefs } from '@/lib/kube/gitops/managed';
import { useAccess } from '@/store/useAccessStore';
import { useAppStore } from '@/store/useAppStore';
import type { Gvk, KubeObject } from '@/types';
import { confirmDestructive } from '../actions/guard';
import { ownerWarning, resolveGitOpsOwner } from '../gitops/owner';
import { errorText } from '../util';
import { requireWritableConnection, restartReviewedConsumer } from './actions';
import {
  configUses,
  type ConfigConsumer,
  type ConfigKeyChange,
  type ConfigReference,
  type ConfigUse,
} from './model';
import { scanConfigImpact, type ImpactScan } from './scan';

const MAX_RESTARTS = 20;

export interface ConfigImpactRequest {
  obj: KubeObject;
  changes: ConfigKeyChange[];
  /** Omitted for the read-only consumer browser. */
  apply?: () => Promise<KubeObject>;
}

function usageLabel(use: ConfigUse) {
  switch (use.mode) {
    case 'env':
      return i18n.t('Environment variable');
    case 'envFrom':
      return i18n.t('Environment from all keys');
    case 'volume':
      return i18n.t('Mounted file');
    case 'projected':
      return i18n.t('Projected file');
    case 'subPath':
      return i18n.t('Subpath mount');
    case 'imagePullSecret':
      return i18n.t('Image pull credentials');
  }
}

function refreshLabel(use: ConfigUse) {
  switch (use.refresh) {
    case 'replace':
      return i18n.t('Pod replacement needed');
    case 'application':
      return i18n.t('File refresh is eventual; application reload is unknown');
    case 'pull':
      return i18n.t('Used for future image pulls; running containers are unchanged');
  }
}

export function ConfigImpactDialog({
  clusterId,
  request,
  onClose,
}: {
  clusterId: string;
  request: ConfigImpactRequest;
  onClose: () => void;
}) {
  i18n.useLocale();
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const connected = useAppStore((s) => s.statuses[clusterId]?.state === 'connected');
  const [scan, setScan] = useState<ImpactScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<KubeObject | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarts, setRestarts] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const target = useMemo<ConfigReference>(
    () => ({
      kind: request.obj.kind === 'Secret' ? 'Secret' : 'ConfigMap',
      name: request.obj.metadata.name,
      namespace: request.obj.metadata.namespace ?? 'default',
    }),
    [request.obj],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void scanConfigImpact(
      clusterId,
      target,
      request.changes,
      request.apply ? 'changed-keys' : 'all-references',
    )
      .then((result) => {
        if (cancelled) return;
        setScan(result);
        setSelected(
          (current) =>
            new Set([...current].filter((id) => result.consumers.some((c) => c.id === id))),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId, target, request.changes, request.apply, revision]);

  const restartable = useMemo(() => scan?.consumers.filter((c) => c.restartable) ?? [], [scan]);
  const checks = useMemo(
    () =>
      restartable.map((c) => accessCheck('patch', c.gvk, { namespace: c.namespace, name: c.name })),
    [restartable],
  );
  const answers = useAccess(clusterId, checks, { enabled: connected });
  const denied = new Set(
    restartable.filter((_, index) => answers[index]?.state === 'denied').map((c) => c.id),
  );
  const canMutate = !!cluster && !cluster.read_only && connected;
  const selectedConsumers = restartable.filter(
    (c) => selected.has(c.id) && !denied.has(c.id) && !restarts[c.id]?.ok,
  );
  const incomplete = scan?.truncated || scan?.sources.some((source) => source.state !== 'complete');
  const close = () => {
    if (!busy && !lock.current && !document.querySelector('[role="alertdialog"]')) onClose();
  };

  const apply = async () => {
    if (!request.apply || lock.current || applied || !canMutate) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await request.apply();
      if (mounted.current) setApplied(result);
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const restart = async () => {
    if (!applied || !selectedConsumers.length || lock.current || !canMutate) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    let confirmation: Parameters<typeof confirmDestructive>[0] | null = null;
    try {
      requireWritableConnection(clusterId);
      const config = await ipc.resourceGet(
        clusterId,
        {
          group: '',
          version: 'v1',
          kind: target.kind,
          plural: target.kind === 'Secret' ? 'secrets' : 'configmaps',
          namespaced: true,
        },
        target.namespace,
        target.name,
      );
      if (
        config.metadata.uid !== applied.metadata.uid ||
        config.metadata.resourceVersion !== applied.metadata.resourceVersion
      )
        throw new Error(
          i18n.t(
            'The configuration changed after it was saved. Inspect its current consumers before restarting workloads.',
          ),
        );
      const prepared: { consumer: ConfigConsumer; obj: KubeObject; gvk: Gvk }[] = [];
      const warnings = new Set<string>();
      for (const consumer of selectedConsumers.slice(0, MAX_RESTARTS)) {
        requireWritableConnection(clusterId);
        const obj = await ipc.resourceGet(
          clusterId,
          consumer.gvk,
          consumer.namespace,
          consumer.name,
        );
        if (
          !consumer.uid ||
          obj.metadata.uid !== consumer.uid ||
          !configUses(
            obj,
            target,
            request.changes.map((c) => c.key),
          ).uses.length
        )
          throw new Error(
            i18n.t(
              'A selected workload was replaced or no longer uses these keys. Refresh the impact review.',
            ),
          );
        const owner = await resolveGitOpsOwner(clusterId, obj);
        if (owner) warnings.add(ownerWarning(owner).text);
        else if (gitopsOwnerRefs(obj).length)
          warnings.add(
            i18n.t('GitOps ownership could not be verified. Manual changes may be reverted.'),
          );
        prepared.push({ consumer, obj, gvk: consumer.gvk });
      }
      if (!mounted.current) return;
      confirmation = {
        cluster: useAppStore.getState().clusters.find((c) => c.id === clusterId),
        title: i18n.t('Restart selected consumers'),
        message:
          i18n.t(
            'Request a rolling restart of these workloads? Their update strategies still apply. Application reload and rollout completion are not guaranteed.',
          ) +
          `\n\n${prepared.map(({ consumer }) => `${consumer.kind} ${consumer.namespace}/${consumer.name}`).join('\n')}`,
        confirmLabel: i18n.t('Restart'),
        typeName: cluster?.name ?? target.name,
        warning: [...warnings].join('\n\n') || null,
        run: async () => {
          if (!mounted.current || lock.current) return;
          lock.current = true;
          setBusy(true);
          try {
            for (const { consumer, obj, gvk } of prepared) {
              setRunningId(consumer.id);
              try {
                // Verify the saved config before every restart, including after a long confirmation.
                requireWritableConnection(clusterId);
                const current = await ipc.resourceGet(
                  clusterId,
                  {
                    group: '',
                    version: 'v1',
                    kind: target.kind,
                    plural: target.kind === 'Secret' ? 'secrets' : 'configmaps',
                    namespaced: true,
                  },
                  target.namespace,
                  target.name,
                );
                if (
                  current.metadata.uid !== applied.metadata.uid ||
                  current.metadata.resourceVersion !== applied.metadata.resourceVersion
                )
                  throw new Error(
                    i18n.t(
                      'The configuration changed after it was saved. Inspect its current consumers before restarting workloads.',
                    ),
                  );
                await restartReviewedConsumer(clusterId, gvk, obj);
                setRestarts((state) => ({ ...state, [consumer.id]: { ok: true } }));
                setSelected((state) => {
                  const next = new Set(state);
                  next.delete(consumer.id);
                  return next;
                });
              } catch (e) {
                setRestarts((state) => ({
                  ...state,
                  [consumer.id]: { ok: false, error: errorText(e) },
                }));
              }
            }
          } finally {
            lock.current = false;
            setBusy(false);
            setRunningId(null);
          }
        },
      };
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
    if (confirmation && mounted.current) confirmDestructive(confirmation);
  };

  return createPortal(
    <Dialog
      title={
        request.apply ? i18n.t('Review configuration impact') : i18n.t('Configuration consumers')
      }
      subtitle={`${target.kind} · ${target.namespace}/${target.name}`}
      size="lg"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {applied ? i18n.t('Done') : i18n.t('Close')}
          </Button>
          {request.apply && !applied && (
            <Button
              variant="primary"
              onClick={() => void apply()}
              disabled={busy || loading || !canMutate}
            >
              {busy ? i18n.t('Saving…') : i18n.t('Apply configuration changes')}
            </Button>
          )}
          {applied && (
            <Button
              variant="primary"
              leftIcon={<RotateCcw className="h-3 w-3" />}
              onClick={() => void restart()}
              disabled={busy || loading || !canMutate || !selectedConsumers.length}
            >
              {i18n.t('Review {count} restarts', { count: selectedConsumers.length })}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-[11.5px]">
        {applied && (
          <p className="text-status-running bg-status-running/8 rounded-md px-3 py-2">
            {i18n.t(
              'Configuration saved. Workloads have not been restarted automatically. Select consumers and review their restarts below.',
            )}
          </p>
        )}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-fg-dim mb-1 text-[10px] tracking-wider uppercase">
              {request.apply ? i18n.t('Changed keys') : i18n.t('Inspected keys')}
            </p>
            <div className="flex max-h-24 flex-wrap gap-1 overflow-auto">
              {request.changes.map((change) => (
                <span
                  key={change.key}
                  className="bg-fg/5 rounded px-1.5 py-0.5 font-mono"
                  title={
                    change.operation === 'removed'
                      ? i18n.t('Removed')
                      : change.operation === 'added'
                        ? i18n.t('Added')
                        : i18n.t('Changed')
                  }
                >
                  {change.key}
                </span>
              ))}
            </div>
          </div>
          <Button
            size="xs"
            variant="ghost"
            leftIcon={
              loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )
            }
            onClick={() => setRevision((value) => value + 1)}
            disabled={loading || busy || !connected}
          >
            {i18n.t('Refresh impact')}
          </Button>
        </div>
        <p className="text-fg-dim">
          {i18n.t(
            'References are inspected in namespace {namespace}; configuration values are not included in this review.',
            { namespace: target.namespace },
          )}
        </p>
        <p className="text-fg-dim">
          {i18n.t(
            'Environment values and subpath mounts need replacement Pods. Other mounted files may refresh eventually; only the application can determine whether it reloads them.',
          )}
        </p>
        {request.changes.some((change) => change.operation === 'removed') && (
          <p className="text-status-starting flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            {i18n.t(
              'Removing a required key can prevent new Pods from starting. Check optional references before restarting.',
            )}
          </p>
        )}
        {incomplete && (
          <p className="text-status-starting bg-status-starting/8 rounded-md px-3 py-2">
            {i18n.t(
              'This impact review is incomplete. Unreadable or limited sources may hide additional consumers.',
            )}
          </p>
        )}
        {error && (
          <p role="alert" className="text-status-error whitespace-pre-wrap">
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-fg-dim flex items-center gap-2 py-6">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {i18n.t('Inspecting configuration references…')}
          </p>
        ) : (
          <>
            <div className="text-fg-dim flex flex-wrap justify-between gap-2 text-[10.5px]">
              <span>
                {i18n.plural(
                  '{count} consumer found',
                  '{count} consumers found',
                  scan?.consumers.length ?? 0,
                )}
              </span>
              {scan && (
                <span>
                  {i18n.t('Snapshot at {time}; {count} objects inspected', {
                    time: new Date(scan.scannedAt).toLocaleTimeString(),
                    count: scan.inspected,
                  })}
                </span>
              )}
            </div>
            {!scan?.consumers.length && (
              <p className="border-border/60 text-fg-dim rounded-md border p-4 text-center">
                {i18n.t(
                  'No matching references were found in the inspected workload specifications.',
                )}
              </p>
            )}
            <div className="space-y-2">
              {scan?.consumers.map((consumer) => (
                <ConsumerRow
                  key={consumer.id}
                  consumer={consumer}
                  selectable={
                    !!request.apply &&
                    consumer.restartable &&
                    !!consumer.uid &&
                    !denied.has(consumer.id) &&
                    canMutate &&
                    !restarts[consumer.id]?.ok
                  }
                  checked={selected.has(consumer.id)}
                  disabled={
                    busy || (!selected.has(consumer.id) && selectedConsumers.length >= MAX_RESTARTS)
                  }
                  denied={denied.has(consumer.id)}
                  running={runningId === consumer.id}
                  result={restarts[consumer.id]}
                  onToggle={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(consumer.id)) next.delete(consumer.id);
                      else if (selectedConsumers.length < MAX_RESTARTS) next.add(consumer.id);
                      return next;
                    })
                  }
                />
              ))}
            </div>
            {!!request.apply && !!restartable.length && (
              <p className="text-fg-dim">
                {i18n.t(
                  'Select up to {count} Deployments, StatefulSets, or DaemonSets. Restart requests are reviewed after the configuration is saved.',
                  { count: MAX_RESTARTS },
                )}
              </p>
            )}
            <details className="border-border/60 rounded-md border px-3 py-2">
              <summary className="text-fg-muted cursor-pointer">
                {i18n.t('Scan coverage and limitations')}
              </summary>
              <p className="text-fg-dim mt-2">
                {i18n.t(
                  'Custom controllers, API-based consumers, CSI drivers, ServiceAccount defaults, and external systems are not resolved. Owner references are shown for context; unsupported controllers must be handled separately.',
                )}
              </p>
              <p className="text-fg-dim mt-2">
                {i18n.t(
                  'The scan inspects at most 500 objects per kind, 2,000 objects in total, and 200 matching consumers. Environment prefixes and dynamic subpaths may require application-specific checks.',
                )}
              </p>
              <div className="mt-2 space-y-1">
                {scan?.sources.map((source) => (
                  <div key={source.kind} className="flex flex-wrap gap-x-2">
                    <span className="font-mono">{source.kind}</span>
                    <span
                      className={
                        source.state === 'complete' ? 'text-fg-dim' : 'text-status-starting'
                      }
                    >
                      {source.state === 'complete'
                        ? i18n.t('{count} inspected', { count: source.inspected })
                        : source.state === 'limited'
                          ? i18n.t('Limited to {count}', { count: source.inspected })
                          : i18n.t('Unavailable')}
                    </span>
                    {source.error && (
                      <span className="text-fg-dim w-full break-words">{source.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}

function ConsumerRow({
  consumer,
  selectable,
  checked,
  disabled,
  denied,
  running,
  result,
  onToggle,
}: {
  consumer: ConfigConsumer;
  selectable: boolean;
  checked: boolean;
  disabled: boolean;
  denied: boolean;
  running: boolean;
  result?: { ok: boolean; error?: string };
  onToggle: () => void;
}) {
  i18n.useLocale();
  return (
    <details className="border-border/60 rounded-md border" open={consumer.restartable}>
      <summary className="hover:bg-fg/5 flex cursor-pointer items-center gap-2 px-3 py-2">
        {selectable && (
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-label={i18n.t('Select {kind} {name} for restart', {
              kind: consumer.kind,
              name: consumer.name,
            })}
            onClick={(event) => event.stopPropagation()}
            onChange={onToggle}
            className="accent-accent h-3.5 w-3.5"
          />
        )}
        <span className="min-w-0 flex-1 font-mono text-[11px] break-all">
          <span className="text-fg-dim">{consumer.kind}</span> {consumer.name}
        </span>
        {running ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : result?.ok ? (
          <span className="text-status-running">{i18n.t('Restart requested')}</span>
        ) : denied ? (
          <span className="text-status-error">{i18n.t('Permission denied')}</span>
        ) : (
          consumer.restartRequired && (
            <span className="text-status-starting shrink-0 text-[10.5px]">
              {i18n.t('Replacement needed')}
            </span>
          )
        )}
      </summary>
      <div className="border-border/40 space-y-2 border-t px-3 py-2">
        {consumer.owner && (
          <p className="text-fg-dim">
            {i18n.t('Controller: {kind} {name}', {
              kind: consumer.owner.kind,
              name: consumer.owner.name,
            })}
          </p>
        )}
        {!consumer.restartable && (
          <p className="text-fg-dim">
            {i18n.t('This object is shown as evidence; it is not restarted by this review.')}
          </p>
        )}
        {consumer.uses.map((use, index) => (
          <div key={index} className="bg-fg/[0.025] rounded px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>{usageLabel(use)}</span>
              {!!use.container && <code className="text-fg-muted">{use.container}</code>}
              {use.containerType === 'initContainers' && (
                <span className="text-fg-dim">{i18n.t('Init container')}</span>
              )}
              {use.containerType === 'ephemeralContainers' && (
                <span className="text-fg-dim">{i18n.t('Ephemeral container')}</span>
              )}
              {use.optional && <span className="text-fg-dim">{i18n.t('Optional reference')}</span>}
            </div>
            {!!use.binding && (
              <p className="text-fg-dim mt-0.5 font-mono text-[10.5px] break-all">{use.binding}</p>
            )}
            {use.allKeys && (
              <p className="text-fg-muted mt-1 text-[10.5px]">
                {i18n.t('All current and future keys')}
              </p>
            )}
            {!!use.keys.length && (
              <p className="mt-1 font-mono text-[10.5px] break-all">{use.keys.join(', ')}</p>
            )}
            {!!use.missingKeys?.length && (
              <p className="text-status-starting mt-1 text-[10.5px]">
                {i18n.t('Referenced keys missing from this configuration: {keys}', {
                  keys: use.missingKeys.join(', '),
                })}
              </p>
            )}
            <p
              className={
                use.refresh === 'replace'
                  ? 'text-status-starting mt-1 text-[10.5px]'
                  : 'text-fg-dim mt-1 text-[10.5px]'
              }
            >
              {refreshLabel(use)}
            </p>
            {use.uncertain && (
              <p className="text-status-starting mt-1">
                {i18n.t('The dynamic subpath could not be resolved; these keys may be affected.')}
              </p>
            )}
          </div>
        ))}
        {consumer.truncated && (
          <p className="text-status-starting">
            {i18n.t(
              'Additional references were omitted because this object exceeded the scan limits.',
            )}
          </p>
        )}
        {result?.error && (
          <p role="alert" className="text-status-error break-words">
            {result.error}
          </p>
        )}
      </div>
    </details>
  );
}
