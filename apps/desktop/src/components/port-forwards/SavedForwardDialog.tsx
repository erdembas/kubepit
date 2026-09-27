import * as i18n from '@/i18n';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { parsePort } from '@/lib/portForwards';
import { useAppStore } from '@/store/useAppStore';
import { useConnectivityStore } from '@/store/useConnectivityStore';
import type { SavedPortForward } from '@/types';
import { updateSaved } from './forwardActions';
import { LocalPortHint, useLocalPortCheck } from './LocalPortHint';

/** Edit the label, local port and start-on-connect of a saved forward. */
export function SavedForwardDialog({ saved }: { saved: SavedPortForward }) {
  i18n.useLocale();
  const close = () => useConnectivityStore.getState().editSaved(null);
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === saved.cluster_id));
  const running = useAppStore((s) => s.portForwards.find((f) => f.saved_id === saved.id));
  const [label, setLabel] = useState(saved.label ?? '');
  const [local, setLocal] = useState(saved.local_port ? String(saved.local_port) : '');
  const [auto, setAuto] = useState(saved.start_on_connect);
  const [busy, setBusy] = useState(false);
  const port = parsePort(local);
  const invalid = local.trim() !== '' && port == null;
  const status = useLocalPortCheck(port, running?.local_port);

  const submit = async () => {
    if (invalid) return;
    setBusy(true);
    const ok = await updateSaved({
      ...saved,
      label: label.trim() || null,
      local_port: port,
      start_on_connect: auto,
    });
    setBusy(false);
    if (ok) close();
  };

  return (
    <Dialog
      title={i18n.t('Saved port forward')}
      subtitle={`${cluster?.name ?? saved.cluster_id} · ${saved.kind}/${saved.namespace}/${saved.name}:${saved.remote_port}`}
      size="sm"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || invalid}
            onClick={() => void submit()}
            leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {i18n.t('Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={i18n.t('Label')} hint={i18n.t('Optional. Shown instead of the target.')}>
          <Input
            value={label}
            autoFocus
            placeholder={`${saved.kind}/${saved.name}`}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </Field>
        <Field
          label={i18n.t('Local port')}
          hint={i18n.t('Leave empty to pick a free port on every start.')}
          error={invalid ? i18n.t('Enter a port between 1 and 65535.') : null}
        >
          <Input
            type="number"
            min={1}
            max={65535}
            mono
            value={local}
            placeholder={i18n.t('auto')}
            onChange={(e) => setLocal(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            className="tabular-nums"
          />
          <LocalPortHint status={status} onUse={(p) => setLocal(String(p))} />
        </Field>
        <Switch
          checked={auto}
          onChange={setAuto}
          label={i18n.t('Start when the cluster connects')}
          description={i18n.t(
            'Kubepit starts this forward every time you connect to the cluster. If it cannot start, it is listed as failed with the reason.',
          )}
        />
        {running && (
          <p className="text-fg-dim text-[11px]">
            {i18n.t('Changes to the local port apply the next time the forward starts.')}
          </p>
        )}
      </div>
    </Dialog>
  );
}
