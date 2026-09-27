import * as i18n from '@/i18n';
import { useMemo, useState, type ReactNode } from 'react';
import { Loader2, OctagonX, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Choice';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Input';
import { ipc } from '@/lib/ipc';
import { resolveRef } from '@/lib/kube/catalog';
import { isFluxHelmRelease } from '@/lib/kube/gitops/kinds';
import {
  argoAppStatus,
  argoHealthTone,
  argoResources,
  argoSources,
  argoSyncTone,
  fluxSourceRef,
  fluxStatus,
  shortRevision,
} from '@/lib/kube/gitops/model';
import {
  argoSyncPatch,
  argoTerminatePatch,
  DEFAULT_SYNC_OPTIONS,
  fluxReconcilePatch,
  fluxRequestToken,
  type ArgoSyncOptions,
} from '@/lib/kube/gitops/patches';
import { toneText } from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { KubeObject } from '@/types';
import type { ActionDialog } from '../actions/dialogStore';
import { runMutation } from '../actions/guard';
import { usePolled } from '../data/polled';

function OptionRow({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 rounded-md px-2 py-1.5',
        disabled ? 'opacity-50' : 'hover:bg-fg/4 cursor-pointer',
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="text-fg block text-[12px]">{label}</span>
        <span className="text-fg-dim block text-[11px]">{description}</span>
      </span>
    </label>
  );
}

/** Live copy of the dialog's object (operation state changes while the dialog is open). */
function useLiveObject(
  dialog: Extract<ActionDialog, { kind: 'argo-sync' | 'flux-reconcile' }>,
): KubeObject {
  const { clusterId, gvk, obj } = dialog;
  const live = usePolled<KubeObject>(
    `${clusterId}|gitops-dialog|${obj.metadata.uid}`,
    () => ipc.resourceGet(clusterId, gvk, obj.metadata.namespace ?? null, obj.metadata.name),
    3_000,
    true,
  );
  return live.data ?? obj;
}

/** Argo CD sync: revision, prune, dry run, force, apply out-of-sync only, server-side apply. */
export function ArgoSyncDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<ActionDialog, { kind: 'argo-sync' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const { clusterId, gvk } = dialog;
  const obj = useLiveObject(dialog);
  const name = obj.metadata.name;
  const ns = obj.metadata.namespace ?? null;
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const [opts, setOpts] = useState<ArgoSyncOptions>({
    ...DEFAULT_SYNC_OPTIONS,
    revision: dialog.revision ?? '',
  });
  const [busy, setBusy] = useState(false);
  const status = argoAppStatus(obj);
  const sources = argoSources(obj);
  const multiSource = sources.length > 1;
  const outOfSync = useMemo(
    () => argoResources(obj).filter((r) => r.status === 'OutOfSync' || r.requiresPruning),
    [obj],
  );
  const pruning = outOfSync.filter((r) => r.requiresPruning).length;
  const set = <K extends keyof ArgoSyncOptions>(key: K, value: ArgoSyncOptions[K]) =>
    setOpts((o) => ({ ...o, [key]: value }));

  const sync = async () => {
    setBusy(true);
    const ok = await runMutation(
      () =>
        ipc.resourcePatch(
          clusterId,
          gvk,
          ns,
          name,
          argoSyncPatch(obj, { ...opts, revision: multiSource ? '' : opts.revision }),
          'merge',
        ),
      opts.dryRun
        ? i18n.t('Dry-run sync started for {name}', { name })
        : i18n.t('Sync started for {name}', { name }),
    );
    setBusy(false);
    if (ok) onClose();
  };
  const submit = () => {
    if (status.operationRunning || busy) return;
    if (cluster?.environment === 'production' && !opts.dryRun) {
      useAppStore.getState().requestConfirm({
        title: i18n.t('Sync {name}', { name }),
        message: i18n.t('Sync {name} on a production cluster?', { name }),
        confirmLabel: i18n.t('Sync'),
        tone: 'danger',
        typeToConfirm: name,
        onConfirm: sync,
      });
    } else void sync();
  };
  const terminate = () =>
    void runMutation(
      () => ipc.resourcePatch(clusterId, gvk, ns, name, argoTerminatePatch(), 'merge'),
      i18n.t('Terminating the operation of {name}', { name }),
    );

  return (
    <Dialog
      title={i18n.t('Sync {name}', { name })}
      subtitle={`Application · ${ns ? `${ns}/` : ''}${name}`}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || status.operationRunning}
            onClick={submit}
            leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {opts.dryRun ? i18n.t('Dry run') : i18n.t('Sync')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
          <span className="text-fg-dim">
            {i18n.rich('Sync: {value}', {
              value: (
                <span className={cn('font-medium', toneText(argoSyncTone(status.sync)))}>
                  {status.sync || 'Unknown'}
                </span>
              ),
            })}
          </span>
          <span className="text-fg-dim">
            {i18n.rich('Health: {value}', {
              value: (
                <span className={cn('font-medium', toneText(argoHealthTone(status.health)))}>
                  {status.health || 'Unknown'}
                </span>
              ),
            })}
          </span>
          {status.revision && (
            <span className="text-fg-dim">
              {i18n.rich('Revision: {value}', {
                value: (
                  <span className="text-fg-muted font-mono" title={status.revision}>
                    {shortRevision(status.revision)}
                  </span>
                ),
              })}
            </span>
          )}
        </div>
        {status.operationRunning && (
          <div className="border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {i18n.t(
                'Another operation is in progress ({phase}). Terminate it before starting a new sync.',
                { phase: status.operationPhase || 'Running' },
              )}
              {status.operationMessage && (
                <span className="text-fg-dim mt-0.5 block">{status.operationMessage}</span>
              )}
            </span>
            {status.operationPhase !== 'Terminating' && (
              <Button
                size="xs"
                variant="danger"
                leftIcon={<OctagonX className="h-3 w-3" />}
                onClick={terminate}
              >
                {i18n.t('Terminate')}
              </Button>
            )}
          </div>
        )}
        <Field
          label={i18n.t('Revision')}
          hint={
            multiSource
              ? i18n.t("Multi-source applications sync each source's target revision.")
              : i18n.t("Leave empty to sync the source's target revision ({revision}).", {
                  revision: sources[0]?.targetRevision || 'HEAD',
                })
          }
        >
          <Input
            mono
            value={opts.revision}
            disabled={multiSource}
            placeholder={sources[0]?.targetRevision || 'HEAD'}
            onChange={(e) => set('revision', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </Field>
        <div className="-mx-2 space-y-0.5">
          <OptionRow
            checked={opts.prune}
            onChange={(v) => set('prune', v)}
            label={i18n.t('Prune')}
            description={i18n.t('Delete resources that are no longer defined in Git.')}
          />
          <OptionRow
            checked={opts.dryRun}
            onChange={(v) => set('dryRun', v)}
            label={i18n.t('Dry run')}
            description={i18n.t('Preview the sync without changing the cluster.')}
          />
          <OptionRow
            checked={opts.applyOutOfSyncOnly}
            onChange={(v) => set('applyOutOfSyncOnly', v)}
            label={i18n.t('Apply out-of-sync only')}
            description={i18n.t('Skip resources that are already in sync.')}
          />
          <OptionRow
            checked={opts.serverSideApply}
            onChange={(v) => set('serverSideApply', v)}
            label={i18n.t('Server-side apply')}
            description={i18n.t('Apply with server-side apply instead of kubectl apply.')}
          />
          <OptionRow
            checked={opts.force}
            onChange={(v) => set('force', v)}
            label={i18n.t('Force')}
            description={i18n.t('Delete and re-create resources that cannot be patched.')}
          />
        </div>
        <div>
          <p className="text-fg-dim mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
            {i18n.t('Out of sync')}
          </p>
          {outOfSync.length ? (
            <>
              <ul className="border-border/60 divide-border/40 max-h-40 divide-y overflow-auto rounded-md border text-[11.5px]">
                {outOfSync.map((r) => (
                  <li
                    key={`${r.group}/${r.kind}/${r.namespace}/${r.name}`}
                    className="flex items-center gap-2 px-2.5 py-1"
                  >
                    <span className="text-fg-dim w-28 shrink-0 truncate">{r.kind}</span>
                    <span className="text-fg min-w-0 flex-1 truncate font-mono text-[11px]">
                      {r.namespace ? `${r.namespace}/` : ''}
                      {r.name}
                    </span>
                    {r.requiresPruning && (
                      <span className="text-status-error shrink-0 text-[10.5px]">
                        {i18n.t('prune')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {pruning > 0 && !opts.prune && (
                <p className="text-fg-dim mt-1.5 text-[11px]">
                  {i18n.plural(
                    '{count} resource needs pruning; enable Prune to delete it.',
                    '{count} resources need pruning; enable Prune to delete them.',
                    pruning,
                  )}
                </p>
              )}
            </>
          ) : (
            <p className="text-fg-dim text-[11.5px]">{i18n.t('Every resource is in sync.')}</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Flux reconcile: with source, and for HelmReleases force / reset (recent Flux). */
export function FluxReconcileDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<ActionDialog, { kind: 'flux-reconcile' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const { clusterId, gvk } = dialog;
  const obj = useLiveObject(dialog);
  const name = obj.metadata.name;
  const ns = obj.metadata.namespace ?? null;
  const helm = isFluxHelmRelease(obj);
  const source = fluxSourceRef(obj);
  const suspended = fluxStatus(obj).suspended;
  const [withSource, setWithSource] = useState(false);
  const [force, setForce] = useState(false);
  const [reset, setReset] = useState(false);
  const [resume, setResume] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const token = fluxRequestToken();
    const ok = await runMutation(
      async () => {
        if (withSource && source) {
          const apiResources = useWorkbenchStore.getState().apiResources[clusterId];
          const sourceGvk = resolveRef(source.apiVersion, source.kind, apiResources);
          if (sourceGvk)
            await ipc.resourcePatch(
              clusterId,
              sourceGvk,
              source.namespace ?? ns,
              source.name,
              fluxReconcilePatch(token),
              'merge',
            );
        }
        const body = fluxReconcilePatch(token, { force: helm && force, reset: helm && reset });
        await ipc.resourcePatch(
          clusterId,
          gvk,
          ns,
          name,
          resume && suspended ? { ...body, spec: { suspend: false } } : body,
          'merge',
        );
      },
      i18n.t('Reconciliation requested for {name}', { name }),
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      title={i18n.t('Reconcile {name}', { name })}
      subtitle={`${obj.kind} · ${ns ? `${ns}/` : ''}${name}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || (suspended && !resume)}
            onClick={() => void submit()}
            leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {i18n.t('Reconcile')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {suspended && (
          <div className="border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{i18n.t('Suspended objects are not reconciled until they are resumed.')}</span>
          </div>
        )}
        <div className="-mx-2 space-y-0.5">
          {suspended && (
            <OptionRow
              checked={resume}
              onChange={setResume}
              label={i18n.t('Resume')}
              description={i18n.t('Clear spec.suspend so the controller reconciles again.')}
            />
          )}
          <OptionRow
            checked={withSource}
            onChange={setWithSource}
            disabled={!source}
            label={i18n.t('Reconcile the source first')}
            description={
              source
                ? i18n.t('Fetch {source} before reconciling.', {
                    source: `${source.kind}/${source.name}`,
                  })
                : i18n.t('No source reference.')
            }
          />
          {helm && (
            <>
              <OptionRow
                checked={force}
                onChange={setForce}
                label={i18n.t('Force')}
                description={i18n.t('Run a Helm install or upgrade even when nothing changed.')}
              />
              <OptionRow
                checked={reset}
                onChange={setReset}
                label={i18n.t('Reset failure counters')}
                description={i18n.t(
                  'Let install and upgrade remediation retry after exhausting its attempts.',
                )}
              />
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
