import { ConfigMapWizard } from './ConfigMapWizard';
import { CronJobWizard } from './CronJobWizard';
import { ExposeWizard } from './ExposeWizard';
import { IngressWizard } from './IngressWizard';
import { JobFromCronJobDialog } from './JobFromCronJobDialog';
import { NamespaceWizard } from './NamespaceWizard';
import { SecretWizard } from './SecretWizard';
import { ServiceAccountWizard } from './ServiceAccountWizard';
import { useWizardStore } from './wizardStore';

/** Renders the open resource wizard of this cluster (mounted by the cluster workbench). */
export function WizardHost({ clusterId }: { clusterId: string }) {
  const request = useWizardStore((s) => s.request);
  const close = useWizardStore((s) => s.close);
  if (!request || request.clusterId !== clusterId) return null;
  return renderWizard(request, close);
}

function renderWizard(
  request: NonNullable<ReturnType<typeof useWizardStore.getState>['request']>,
  close: () => void,
) {
  switch (request.kind) {
    case 'expose':
      return <ExposeWizard request={request} onClose={close} />;
    case 'ingress':
      return <IngressWizard request={request} onClose={close} />;
    case 'secret':
      return <SecretWizard request={request} onClose={close} />;
    case 'configmap':
      return <ConfigMapWizard request={request} onClose={close} />;
    case 'namespace':
      return <NamespaceWizard request={request} onClose={close} />;
    case 'serviceaccount':
      return <ServiceAccountWizard request={request} onClose={close} />;
    case 'cronjob':
      return <CronJobWizard request={request} onClose={close} />;
    case 'job-from-cronjob':
      return <JobFromCronJobDialog request={request} onClose={close} />;
  }
}
