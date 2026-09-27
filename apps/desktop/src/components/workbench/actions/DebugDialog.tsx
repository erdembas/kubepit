import * as i18n from '@/i18n';
import { useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Radio } from '@/components/ui/Choice';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ipc } from '@/lib/ipc';
import { containerNames } from '@/lib/kube/pods';
import { useAppStore } from '@/store/useAppStore';
import { dock } from '@/store/useDockStore';
import type { DebugProfile } from '@/types';
import { useCluster } from '../data/hooks';
import { errorText } from '../util';
import type { ActionDialog } from './dialogStore';

const BUSYBOX = 'docker.io/library/busybox:1.36';

interface Preset {
  id: string;
  image: string;
  label: string;
  hint: string;
}

function presets(): Preset[] {
  return [
    {
      id: 'busybox',
      image: BUSYBOX,
      label: 'BusyBox',
      hint: i18n.t('Tiny shell with the classic Unix tools'),
    },
    {
      id: 'alpine',
      image: 'docker.io/library/alpine:3.20',
      label: 'Alpine',
      hint: i18n.t('Shell plus apk to install what you need'),
    },
    {
      id: 'netshoot',
      image: 'docker.io/nicolaka/netshoot',
      label: 'netshoot',
      hint: i18n.t('Network debugging: tcpdump, dig, curl, ss, iperf…'),
    },
  ];
}

const NO_TARGET = '\u0000none';

/**
 * `kubectl debug -it`: adds an ephemeral container to the pod, waits until
 * it runs and attaches a terminal to it. Targeting a container shares its
 * process namespace, so its processes (and `/proc/<pid>/root`) are visible.
 */
export function DebugDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<ActionDialog, { kind: 'debug' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const { clusterId, pod } = dialog;
  const { readOnly } = useCluster(clusterId);
  const settingsImage = useAppStore((s) => s.settings?.debug_image) || BUSYBOX;
  const list = presets();
  const initialPreset = list.find((p) => p.image === settingsImage)?.id ?? 'custom';
  const [preset, setPreset] = useState(initialPreset);
  const [custom, setCustom] = useState(initialPreset === 'custom' ? settingsImage : '');
  const containers = containerNames(pod, false);
  const [target, setTarget] = useState<string>(dialog.target ?? containers[0] ?? NO_TARGET);
  const [profile, setProfile] = useState<DebugProfile>('general');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namespace = pod.metadata.namespace ?? 'default';
  const image =
    preset === 'custom' ? custom.trim() : (list.find((p) => p.id === preset)?.image ?? '');

  const start = async () => {
    if (!image || busy || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const name = await ipc.podDebug(clusterId, namespace, pod.metadata.name, {
        image,
        target_container: target === NO_TARGET ? null : target,
        name: null,
        command: command.trim() ? command.trim().split(/\s+/) : null,
        profile,
      });
      onClose();
      dock.podAttach(clusterId, namespace, pod.metadata.name, name);
      useAppStore
        .getState()
        .pushToast('success', i18n.t('Debug container {name} is running', { name }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={i18n.t('Debug container')}
      subtitle={`${namespace}/${pod.metadata.name}`}
      size="md"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          {busy && (
            <span className="text-fg-dim mr-auto flex items-center gap-1.5 text-[11.5px]">
              <Loader2 className="h-3 w-3 animate-spin" />
              {i18n.t('Waiting for the container to start…')}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !image || readOnly}
            title={readOnly ? i18n.t('Read-only cluster: changes are blocked') : undefined}
            onClick={() => void start()}
            leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {i18n.t('Start and attach')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={i18n.t('Image')}>
          <div className="space-y-0.5" role="radiogroup">
            {list.map((p) => (
              <label
                key={p.id}
                className="hover:bg-fg/4 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px]"
              >
                <Radio
                  name="debug-image"
                  checked={preset === p.id}
                  onChange={() => setPreset(p.id)}
                  className="mt-0"
                />
                <span className="text-fg w-16 shrink-0 font-medium">{p.label}</span>
                <span className="text-fg-dim min-w-0 flex-1 truncate">{p.hint}</span>
                <span className="text-fg-dim hidden shrink-0 font-mono text-[10.5px] sm:inline">
                  {p.image.replace('docker.io/', '')}
                </span>
              </label>
            ))}
            <label className="hover:bg-fg/4 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px]">
              <Radio
                name="debug-image"
                checked={preset === 'custom'}
                onChange={() => setPreset('custom')}
                className="mt-0"
              />
              <span className="text-fg w-16 shrink-0 font-medium">{i18n.t('Custom')}</span>
              <Input
                mono
                value={custom}
                placeholder="registry.example.com/tools:1.0"
                onFocus={() => setPreset('custom')}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void start()}
                className="h-7 py-1"
              />
            </label>
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={i18n.t('Target container')} hint={i18n.t('Shares its process namespace.')}>
            <Select
              value={target}
              onChange={setTarget}
              size="md"
              className="w-full"
              ariaLabel={i18n.t('Target container')}
              options={[
                ...containers.map((c) => ({ value: c, label: c })),
                { value: NO_TARGET, label: i18n.t('None (separate processes)') },
              ]}
            />
          </Field>
          <Field
            label={i18n.t('Profile')}
            hint={i18n.t('Extra privileges, like kubectl debug --profile.')}
          >
            <Select<DebugProfile>
              value={profile}
              onChange={setProfile}
              size="md"
              className="w-full"
              ariaLabel={i18n.t('Profile')}
              options={[
                { value: 'general', label: i18n.t('General (no extra privileges)') },
                { value: 'netadmin', label: i18n.t('Network admin (NET_ADMIN, NET_RAW)') },
                { value: 'sysadmin', label: i18n.t('System admin (privileged)') },
              ]}
            />
          </Field>
        </div>
        <Field
          label={i18n.t('Command')}
          hint={i18n.t('Optional. Leave empty to run the image default (usually a shell).')}
        >
          <Input
            mono
            value={command}
            placeholder="sh"
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void start()}
          />
        </Field>
        <p className="border-border bg-surface-raised/60 text-fg-muted flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px]">
          <Info className="text-fg-dim mt-0.5 h-3.5 w-3.5 shrink-0" />
          {i18n.t(
            'Ephemeral containers cannot be removed: this one stays in the pod until the pod is recreated. Exiting the shell stops it.',
          )}
        </p>
        {error && <p className="text-status-error text-[11.5px] break-words">{error}</p>}
      </div>
    </Dialog>
  );
}
