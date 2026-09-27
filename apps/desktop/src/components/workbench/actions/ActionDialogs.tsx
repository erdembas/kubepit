import * as i18n from '@/i18n';
import { useState } from 'react';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { FileContextMenu } from '@/components/ui/FileContextMenu';
import { Field, Input } from '@/components/ui/Input';
import { Radio } from '@/components/ui/Choice';
import { ipc } from '@/lib/ipc';
import { replicaCounts } from '@/lib/kube/workloads';
import { useAppStore } from '@/store/useAppStore';
import type { PortForward } from '@/types';
import { copyText, errorText } from '../util';
import { ArgoSyncDialog, FluxReconcileDialog } from '../gitops/GitOpsDialogs';
import { GitOpsNotice } from '../gitops/ManagedNotice';
import { DebugDialog } from './DebugDialog';
import { useActionDialogs, type ActionDialog } from './dialogStore';
import { runMutation } from './guard';
import { openExternal } from './openExternal';
import { SetImageDialog } from './SetImageDialog';

/** Renders the open action dialog for this cluster (scale, port-forward, pickers). */
export function ActionDialogs({ clusterId }: { clusterId: string }) {
  i18n.useLocale();
  const dialog = useActionDialogs((s) => s.dialog);
  const close = useActionDialogs((s) => s.close);
  if (!dialog || dialog.clusterId !== clusterId) return null;
  if (dialog.kind === 'menu')
    return <FileContextMenu x={dialog.x} y={dialog.y} items={dialog.items} onClose={close} />;
  if (dialog.kind === 'scale') return <ScaleDialog dialog={dialog} onClose={close} />;
  if (dialog.kind === 'set-image') return <SetImageDialog dialog={dialog} onClose={close} />;
  if (dialog.kind === 'debug') return <DebugDialog dialog={dialog} onClose={close} />;
  if (dialog.kind === 'argo-sync') return <ArgoSyncDialog dialog={dialog} onClose={close} />;
  if (dialog.kind === 'flux-reconcile')
    return <FluxReconcileDialog dialog={dialog} onClose={close} />;
  return <PortForwardDialog dialog={dialog} onClose={close} />;
}

function ScaleDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<ActionDialog, { kind: 'scale' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const { obj, gvk, clusterId } = dialog;
  const current = replicaCounts(obj).desired;
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const max = Math.max(10, current * 2, value);
  const name = obj.metadata.name;

  const apply = async () => {
    setBusy(true);
    const ok = await runMutation(
      () => ipc.resourceScale(clusterId, gvk, obj.metadata.namespace ?? 'default', name, value),
      i18n.t('Scaled {name} to {count}', { name, count: value }),
    );
    setBusy(false);
    if (ok) onClose();
  };
  const submit = () => {
    if (value === current) return onClose();
    if (cluster?.environment === 'production') {
      useAppStore.getState().requestConfirm({
        title: i18n.t('Scale {kind}', { kind: obj.kind }),
        message: i18n.t('Scale {name} from {from} to {to} replicas on a production cluster?', {
          name,
          from: current,
          to: value,
        }),
        confirmLabel: i18n.t('Scale'),
        tone: 'danger',
        typeToConfirm: name,
        onConfirm: apply,
      });
    } else void apply();
  };

  return (
    <Dialog
      title={i18n.t('Scale {kind}', { kind: obj.kind })}
      subtitle={`${obj.metadata.namespace}/${name}`}
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
            disabled={busy}
            onClick={submit}
            leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {i18n.t('Scale')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <GitOpsNotice clusterId={clusterId} obj={obj} />
        <p className="text-fg-muted text-[12px]">
          {i18n.t('Currently {current} desired, {ready} ready.', {
            current,
            ready: replicaCounts(obj).ready,
          })}
        </p>
        <Field label={i18n.t('Replicas')}>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={max}
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
              aria-label={i18n.t('Replicas')}
              className="accent-accent min-w-0 flex-1"
            />
            <Input
              type="number"
              min={0}
              value={value}
              autoFocus
              onChange={(e) => setValue(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              className="w-20 [appearance:textfield] text-right tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        </Field>
        {value === 0 && (
          <p className="text-status-starting text-[11.5px]">
            {i18n.t('Scaling to zero stops every pod of this workload.')}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function PortForwardDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<ActionDialog, { kind: 'port-forward' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [port, setPort] = useState(dialog.port ?? dialog.ports[0]?.port ?? 0);
  const [local, setLocal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PortForward | null>(null);
  const url = result ? `http://localhost:${result.local_port}` : '';

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const pf = await ipc.portForwardStart({
        cluster_id: dialog.clusterId,
        namespace: dialog.namespace,
        kind: dialog.target,
        name: dialog.name,
        remote_port: port,
        local_port: Number(local) || null,
      });
      const store = useAppStore.getState();
      if (!store.portForwards.some((f) => f.id === pf.id))
        store.setPortForwards([...store.portForwards, pf]);
      setResult(pf);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={i18n.t('Port forward')}
      subtitle={`${dialog.target}/${dialog.namespace}/${dialog.name}`}
      size="sm"
      onClose={onClose}
      footer={
        result ? (
          <Button variant="primary" size="sm" onClick={onClose}>
            {i18n.t('Done')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {i18n.t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !port}
              onClick={() => void start()}
              leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
            >
              {i18n.t('Start forwarding')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <p className="text-fg-muted text-[12px]">
            {i18n.t('Forwarding localhost:{local} → {name}:{remote}', {
              local: result.local_port,
              name: dialog.name,
              remote: result.remote_port,
            })}
          </p>
          <div className="border-border bg-surface-raised flex items-center gap-2 rounded-lg border px-3 py-2">
            <span className="text-fg min-w-0 flex-1 truncate font-mono text-[12px]">{url}</span>
            <Button
              size="xs"
              variant="secondary"
              leftIcon={<Copy className="h-3 w-3" />}
              onClick={() => void copyText(url, url)}
            >
              {i18n.t('Copy')}
            </Button>
            <Button
              size="xs"
              variant="primary"
              leftIcon={<ExternalLink className="h-3 w-3" />}
              onClick={() => void openExternal(url)}
            >
              {i18n.t('Open')}
            </Button>
          </div>
          <p className="text-fg-dim text-[11px]">
            {i18n.t('Manage active forwards under Network → Port Forwarding.')}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label={i18n.t('Remote port')}>
            <div className="space-y-1" role="radiogroup">
              {dialog.ports.map((p) => (
                <label
                  key={`${p.port}-${p.name}`}
                  className="hover:bg-fg/4 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px]"
                >
                  <Radio
                    name="remote-port"
                    checked={port === p.port}
                    onChange={() => setPort(p.port)}
                    className="mt-0"
                  />
                  <span className="text-fg font-mono tabular-nums">{p.port}</span>
                  <span className="text-fg-dim truncate">{p.name}</span>
                  <span className="text-fg-dim ml-auto text-[10.5px]">{p.protocol}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label={i18n.t('Local port')} hint={i18n.t('Leave empty to pick a free port.')}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={local}
              placeholder={i18n.t('auto')}
              onChange={(e) => setLocal(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void start()}
              className="tabular-nums"
              mono
            />
          </Field>
          {error && <p className="text-status-error text-[11.5px] break-words">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
