import * as i18n from '@/i18n';
import { useMemo, useState, type ClipboardEvent } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { ipc } from '@/lib/ipc';
import {
  containerKey,
  imageVersion,
  joinImage,
  objectImages,
  setImageChangeCause,
  splitImage,
  validateImage,
} from '@/lib/kube/images';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import type { ContainerImage } from '@/types';
import type { ActionDialog } from './dialogStore';
import { runMutation } from './guard';

interface Draft {
  repository: string;
  version: string;
}

function hint(kind: string): string {
  if (kind === 'Pod') return i18n.t('The kubelet restarts the changed containers in place.');
  if (kind === 'CronJob') return i18n.t('Jobs created from now on use the new images.');
  if (kind === 'ReplicaSet' || kind === 'ReplicationController')
    return i18n.t('Only pods created from now on use the new images; existing pods keep theirs.');
  return i18n.t('A new rollout replaces the pods according to the update strategy.');
}

/** "Set image…": edit every container image of a pod or workload in one go. */
export function SetImageDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<ActionDialog, { kind: 'set-image' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const { obj, gvk, clusterId } = dialog;
  const name = obj.metadata.name;
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const images = useMemo(() => objectImages(obj), [obj]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      images.map((i) => [
        containerKey(i),
        { repository: splitImage(i.image).repository, version: imageVersion(i.image) },
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);

  const rows = images.map((original) => {
    const key = containerKey(original);
    const draft = drafts[key]!;
    const image = joinImage(draft.repository, draft.version);
    return {
      key,
      original,
      draft,
      image,
      changed: image !== original.image,
      error: validateImage(image),
    };
  });
  const changes: ContainerImage[] = rows
    .filter((r) => r.changed)
    .map((r) => ({ container: r.original.container, image: r.image, init: r.original.init }));
  const invalid = rows.some((r) => r.changed && r.error);
  const canSubmit = changes.length > 0 && !invalid && !busy;

  const update = (key: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [key]: { ...d[key]!, ...patch } }));
  const reset = (key: string, image: string) =>
    update(key, { repository: splitImage(image).repository, version: imageVersion(image) });
  // Pasting a full reference into the repository field splits it.
  const onPasteRepository = (key: string) => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').trim();
    const parts = splitImage(text);
    if (!parts.tag && !parts.digest) return;
    e.preventDefault();
    update(key, { repository: parts.repository, version: imageVersion(text) });
  };

  const apply = async () => {
    setBusy(true);
    const ok = await runMutation(
      () => ipc.resourceSetImage(clusterId, gvk, obj.metadata.namespace ?? null, name, changes),
      i18n.plural(
        'Updated {count} image of {name}',
        'Updated {count} images of {name}',
        changes.length,
        {
          name,
        },
      ),
    );
    setBusy(false);
    if (ok) onClose();
  };
  const submit = () => {
    if (!canSubmit) return;
    if (cluster?.environment === 'production') {
      useAppStore.getState().requestConfirm({
        title: i18n.t('Set image'),
        message: i18n.plural(
          'Change {count} image of {name} on a production cluster?',
          'Change {count} images of {name} on a production cluster?',
          changes.length,
          { name },
        ),
        confirmLabel: i18n.t('Set image'),
        tone: 'danger',
        typeToConfirm: name,
        onConfirm: apply,
      });
    } else void apply();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog
      title={i18n.t('Set image')}
      subtitle={`${obj.kind} · ${obj.metadata.namespace ? `${obj.metadata.namespace}/` : ''}${name}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="text-fg-dim mr-auto text-[11px]">
            {changes.length > 0
              ? i18n.plural('{count} image changed', '{count} images changed', changes.length)
              : i18n.t('No changes yet')}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            onClick={submit}
            leftIcon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {changes.length > 1
              ? i18n.t('Update {count} images', { count: changes.length })
              : i18n.t('Update image')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-fg-muted text-[12px]">{hint(obj.kind)}</p>
        <div className="border-border/60 divide-border/50 divide-y overflow-hidden rounded-lg border">
          <div className="text-fg-dim bg-fg/[0.02] grid grid-cols-[minmax(110px,160px)_minmax(0,1fr)_10px_minmax(96px,170px)_24px] items-center gap-2 px-3 py-1.5 text-[10px] font-semibold tracking-[0.08em] uppercase">
            <span>{i18n.t('Container')}</span>
            <span>{i18n.t('Repository')}</span>
            <span />
            <span>{i18n.t('Tag or digest')}</span>
            <span />
          </div>
          {rows.map((r, index) => (
            <div
              key={r.key}
              className={cn(
                'px-3 py-2 transition-colors',
                r.changed && 'bg-accent/5 shadow-[inset_2px_0_0_rgb(var(--accent))]',
              )}
            >
              <div className="grid grid-cols-[minmax(110px,160px)_minmax(0,1fr)_10px_minmax(96px,170px)_24px] items-center gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="text-fg truncate text-[12px] font-medium"
                    title={r.original.container}
                  >
                    {r.original.container}
                  </span>
                  {r.original.init && (
                    <span className="bg-fg/6 text-fg-muted shrink-0 rounded px-1.5 py-px text-[10px] font-medium">
                      {i18n.t('init')}
                    </span>
                  )}
                </span>
                <Input
                  mono
                  value={r.draft.repository}
                  onChange={(e) => update(r.key, { repository: e.target.value })}
                  onPaste={onPasteRepository(r.key)}
                  onKeyDown={onKeyDown}
                  aria-label={i18n.t('Repository of {container}', {
                    container: r.original.container,
                  })}
                  spellCheck={false}
                  className="text-fg-muted h-7 py-1 text-[11.5px]"
                />
                <span className="text-fg-dim text-center font-mono text-[12px]" aria-hidden>
                  {r.draft.version.startsWith('@') ? '' : ':'}
                </span>
                <Input
                  mono
                  value={r.draft.version}
                  autoFocus={index === 0}
                  onChange={(e) => update(r.key, { version: e.target.value })}
                  onKeyDown={onKeyDown}
                  placeholder="latest"
                  aria-label={i18n.t('Tag of {container}', { container: r.original.container })}
                  spellCheck={false}
                  className={cn(
                    'h-7 py-1 text-[11.5px]',
                    r.changed && 'border-accent/50',
                    r.changed && r.error && 'border-status-error/60 focus:border-status-error',
                  )}
                />
                {r.changed ? (
                  <IconButton
                    size="xs"
                    label={i18n.t('Reset to {image}', { image: r.original.image })}
                    icon={<RotateCcw />}
                    onClick={() => reset(r.key, r.original.image)}
                  />
                ) : (
                  <span />
                )}
                {r.changed && (
                  <>
                    <span />
                    <p className="col-span-4 -mt-1 text-[11px]">
                      {r.error ? (
                        <span className="text-status-error">{r.error}</span>
                      ) : (
                        <span className="text-fg-dim">
                          {i18n.rich('was {image}', {
                            image: (
                              <span className="text-fg-muted decoration-fg-dim/60 font-mono line-through">
                                {r.draft.repository.trim() ===
                                  splitImage(r.original.image).repository &&
                                imageVersion(r.original.image)
                                  ? imageVersion(r.original.image)
                                  : r.original.image}
                              </span>
                            ),
                          })}
                        </span>
                      )}
                    </p>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        {changes.length > 0 && !invalid && (
          <div>
            <p className="text-fg-dim mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase">
              {i18n.t('Preview')}
            </p>
            <div className="border-border/60 bg-fg/[0.025] overflow-x-auto rounded-md border py-1.5 font-mono text-[11px] leading-[1.6]">
              {changes.map((c) => {
                const before = images.find(
                  (i) => i.container === c.container && i.init === c.init,
                )!.image;
                const field = `${c.init ? 'initContainers' : 'containers'}[${c.container}].image`;
                return (
                  <div key={containerKey(c)}>
                    <div className="text-fg-dim px-3 whitespace-pre">{`  ${field}`}</div>
                    <div className="bg-status-error/10 text-status-error px-3 whitespace-pre">{`- ${before}`}</div>
                    <div className="bg-status-running/10 text-status-running px-3 whitespace-pre">{`+ ${c.image}`}</div>
                  </div>
                );
              })}
            </div>
            {obj.kind !== 'Pod' && (
              <p className="text-fg-dim mt-1.5 truncate text-[11px]">
                {i18n.rich('Recorded as change cause: {cause}', {
                  cause: (
                    <span className="text-fg-muted font-mono">
                      {setImageChangeCause(obj.kind, name, changes)}
                    </span>
                  ),
                })}
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
