import * as i18n from '@/i18n';
import { useMemo, useState } from 'react';
import { Lock, Play } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Input';
import { accessCheck } from '@/lib/kube/access';
import { asString, spec } from '@/lib/kube/accessors';
import { describeCron } from '@/lib/kube/wizards/cron';
import { useCan } from '@/store/useAccessStore';
import type { KubeObject } from '@/types';
import { deniedMessage } from '../access/gates';
import { resourceActions } from '../actions/resourceActions';
import { useCluster } from '../data/hooks';
import { GVK, useLiveList } from './data';
import { NamespaceSelect } from './fields';
import type { WizardRequest } from './wizardStore';

/**
 * "Job from a CronJob" (`kubectl create job --from=cronjob/…`): a picker
 * over the namespace's CronJobs that runs their existing "Trigger now"
 * action.
 */
export function JobFromCronJobDialog({
  request,
  onClose,
}: {
  request: Extract<WizardRequest, { kind: 'job-from-cronjob' }>;
  onClose: () => void;
}) {
  i18n.useLocale();
  const { cluster, readOnly } = useCluster(request.clusterId);
  const [namespace, setNamespace] = useState(request.namespace);
  const cronJobs = useLiveList(request.clusterId, GVK.cronJob, namespace);
  const check = useMemo(
    () => (readOnly ? null : accessCheck('create', GVK.job, { namespace })),
    [readOnly, namespace],
  );
  const can = useCan(request.clusterId, check);
  const blocked = readOnly
    ? i18n.t('Read-only cluster: changes are blocked')
    : can === 'denied' && check
      ? deniedMessage(check)
      : null;

  const trigger = (obj: KubeObject, e: React.MouseEvent) => {
    const action = resourceActions({
      clusterId: request.clusterId,
      cluster,
      gvk: GVK.cronJob,
      obj,
    }).find((a) => a.id === 'trigger');
    action?.run({ x: e.clientX, y: e.clientY });
    onClose();
  };

  return (
    <Dialog
      title={i18n.t('Create Job from CronJob')}
      subtitle="kubectl create job --from=cronjob/…"
      size="md"
      onClose={onClose}
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          {i18n.t('Close')}
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label={i18n.t('Namespace')}>
          <NamespaceSelect
            clusterId={request.clusterId}
            value={namespace}
            onChange={setNamespace}
          />
        </Field>
        {blocked && (
          <p className="text-fg-dim flex items-center gap-1.5 text-[11.5px]">
            <Lock className="h-3 w-3 shrink-0" />
            {blocked}
          </p>
        )}
        <div className="space-y-1">
          {cronJobs.synced && cronJobs.items.length === 0 && (
            <p className="text-fg-dim text-[12px]">
              {i18n.t('No CronJobs in {namespace}.', { namespace })}
            </p>
          )}
          {cronJobs.items.map((cj) => {
            const schedule = asString(spec(cj).schedule);
            return (
              <div
                key={cj.metadata.uid}
                className="hover:bg-fg/4 flex items-center gap-3 rounded-md px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-fg truncate font-mono text-[12px]">{cj.metadata.name}</p>
                  <p className="text-fg-dim truncate text-[11px]">
                    <span className="font-mono">{schedule}</span>
                    {describeCron(schedule) && (
                      <span className="ml-2">{describeCron(schedule)}</span>
                    )}
                  </p>
                </div>
                {spec(cj).suspend === true && (
                  <span className="bg-fg/6 text-fg-muted shrink-0 rounded px-1.5 py-px text-[10.5px]">
                    {i18n.t('suspended')}
                  </span>
                )}
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={!!blocked}
                  title={blocked ?? undefined}
                  leftIcon={<Play className="h-3 w-3" />}
                  onClick={(e) => trigger(cj, e)}
                >
                  {i18n.t('Create Job')}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
