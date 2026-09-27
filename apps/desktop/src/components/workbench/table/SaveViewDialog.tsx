import * as i18n from '@/i18n';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox, Radio } from '@/components/ui/Choice';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Input';
import { useAppStore } from '@/store/useAppStore';
import { useSavedViewsStore } from '@/store/useSavedViewsStore';
import { currentTableState } from './savedViews';

/** Name the current table state of a kind and keep it for this cluster or every cluster. */
export function SaveViewDialog({
  clusterId,
  clusterName,
  kindKey,
  label,
  namespaced,
  onClose,
}: {
  clusterId: string;
  clusterName: string;
  kindKey: string;
  /** Plural kind label, e.g. "Pods". */
  label: string;
  namespaced: boolean;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'cluster' | 'global'>('cluster');
  const [withNamespaces, setWithNamespaces] = useState(namespaced);
  const [makeDefault, setMakeDefault] = useState(false);
  const trimmed = name.trim();

  const save = () => {
    if (!trimmed) return;
    const view = useSavedViewsStore.getState().save(
      {
        ...currentTableState(clusterId, kindKey, namespaced && withNamespaces),
        name: trimmed,
        kindKey,
        clusterId: scope === 'cluster' ? clusterId : null,
      },
      makeDefault,
    );
    useSavedViewsStore.getState().markApplied(clusterId, kindKey, view.id);
    useAppStore.getState().pushToast('success', i18n.t('Saved view “{name}”', { name: view.name }));
    onClose();
  };

  return (
    <Dialog
      title={i18n.t('Save view')}
      subtitle={`${label} · ${clusterName}`}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {i18n.t('Cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={!trimmed} onClick={save}>
            {i18n.t('Save')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label={i18n.t('Name')}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={i18n.t('e.g. Failing pods')}
          />
        </Field>
        <Field label={i18n.t('Available on')}>
          <div className="space-y-1.5">
            <label className="text-fg-muted flex cursor-pointer items-center gap-2 text-[12px]">
              <Radio
                name="view-scope"
                checked={scope === 'cluster'}
                onChange={() => setScope('cluster')}
                className="mt-0"
              />
              {i18n.t('This cluster ({cluster})', { cluster: clusterName })}
            </label>
            <label className="text-fg-muted flex cursor-pointer items-center gap-2 text-[12px]">
              <Radio
                name="view-scope"
                checked={scope === 'global'}
                onChange={() => setScope('global')}
                className="mt-0"
              />
              {i18n.t('All clusters')}
            </label>
          </div>
        </Field>
        <div className="space-y-2">
          {namespaced && (
            <label className="flex cursor-pointer items-start gap-2">
              <Checkbox
                checked={withNamespaces}
                onChange={(e) => setWithNamespaces(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="text-fg block text-[12px] font-medium">
                  {i18n.t('Include the namespace selection')}
                </span>
                <span className="text-fg-dim block text-[11px] leading-snug">
                  {i18n.t('Applying the view then switches the cluster to these namespaces.')}
                </span>
              </span>
            </label>
          )}
          <label className="flex cursor-pointer items-start gap-2">
            <Checkbox checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
            <span className="min-w-0">
              <span className="text-fg block text-[12px] font-medium">
                {i18n.t('Default view for {kind}', { kind: label })}
              </span>
              <span className="text-fg-dim block text-[11px] leading-snug">
                {i18n.t('Applied when the table first opens in a session.')}
              </span>
            </span>
          </label>
        </div>
        <p className="text-fg-dim text-[11px] leading-snug">
          {i18n.t(
            'Saves the filter text, visible columns with their order and widths, and the sort.',
          )}
        </p>
      </form>
    </Dialog>
  );
}
