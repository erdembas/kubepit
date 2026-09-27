import * as i18n from '@/i18n';
import { Loader2, Lock, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ipc } from '@/lib/ipc';
import { dock } from '@/store/useDockStore';
import type { Gvk, KubeObject } from '@/types';
import { MonacoView } from '../common/MonacoView';
import { usePolled } from '../data/polled';
import { CopyButton } from './primitives';

export function YamlTab({
  clusterId,
  gvk,
  obj,
  readOnly,
  isActive,
}: {
  clusterId: string;
  gvk: Gvk;
  obj: KubeObject;
  readOnly: boolean;
  isActive: boolean;
}) {
  i18n.useLocale();
  const ns = obj.metadata.namespace ?? null;
  const yaml = usePolled(
    `${clusterId}|yaml|${obj.metadata.uid}|${obj.metadata.resourceVersion ?? ''}`,
    () => ipc.resourceGetYaml(clusterId, gvk, ns, obj.metadata.name),
    null,
    isActive,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/60 text-fg-dim flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[11px]">
        <Lock className="h-3 w-3" />
        <span>{i18n.t('Read-only view')}</span>
        {yaml.loading && <Loader2 className="h-3 w-3 animate-spin" />}
        <div className="ml-auto flex items-center gap-1">
          {yaml.data && <CopyButton text={yaml.data} label={i18n.t('Copy YAML')} />}
          <Button
            size="xs"
            variant="secondary"
            leftIcon={<Pencil className="h-3 w-3" />}
            disabled={readOnly}
            title={readOnly ? i18n.t('Read-only cluster: changes are blocked') : undefined}
            onClick={() => dock.edit(clusterId, gvk, ns, obj.metadata.name)}
          >
            {i18n.t('Edit')}
          </Button>
        </div>
      </div>
      {yaml.error && !yaml.data ? (
        <p className="text-status-error p-4 text-[12px] break-words">{yaml.error}</p>
      ) : yaml.data === undefined ? (
        <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {i18n.t('Loading…')}
        </div>
      ) : (
        <MonacoView value={yaml.data} />
      )}
    </div>
  );
}
