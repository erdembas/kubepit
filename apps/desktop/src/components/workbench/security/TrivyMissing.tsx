import * as i18n from '@/i18n';
import { TRIVY_CHART, TRIVY_HELM_INSTALL, TRIVY_INSTALL_ACCESS, TRIVY_INSTALL_URL, TRIVY_NAMESPACE } from '@/lib/kube/trivy';
import type { GateableAction } from '../access/gates';
import { OperatorInstallCard, type OperatorInstallTexts } from './OperatorInstallCard';
import { TRIVY_OPERATOR } from './operatorInstall';

const INSTALL_ACTION: GateableAction = {
  id: 'trivy-install',
  mutating: true,
  access: TRIVY_INSTALL_ACCESS,
};

/**
 * Shown instead of the Trivy dashboard when the cluster serves no Trivy
 * Operator CRDs, or (`crdsServed`) serves them without a running operator.
 */
export function TrivyMissing({
  clusterId,
  crdsServed = false,
}: {
  clusterId: string;
  crdsServed?: boolean;
}) {
  i18n.useLocale();
  const texts: OperatorInstallTexts = {
    displayName: i18n.t('Trivy Operator'),
    title: i18n.t('Trivy Operator is not installed on this cluster'),
    titleNotRunning: i18n.t('Trivy Operator is not running on this cluster'),
    body: i18n.t(
      'Trivy Operator is an open-source Kubernetes operator from Aqua Security. It scans the images of running workloads for known vulnerabilities, audits workload, RBAC and infrastructure configuration, finds secrets baked into images and produces compliance reports. The results are stored as custom resources (aquasecurity.github.io), which Kubepit reads here.',
    ),
    bodyNotRunning: i18n.t(
      'Its report resources (aquasecurity.github.io) are installed, but no Trivy Operator deployment was found, so no reports are written. Helm keeps these resources after a failed install or an uninstall; install the operator again to get reports.',
    ),
    installLabel: i18n.t('Install Trivy Operator'),
    installingLabel: i18n.t('Installing Trivy Operator…'),
    confirmImpact: i18n.t(
      'It adds its CRDs, cluster-wide RBAC and an operator that scans every workload.',
    ),
    footnote: i18n.t(
      'Adds the aqua Helm repository and installs {chart} into {namespace} with helm, then waits for the operator to start.',
      { chart: TRIVY_CHART, namespace: TRIVY_NAMESPACE },
    ),
    helmCommand: TRIVY_HELM_INSTALL,
    guideUrl: TRIVY_INSTALL_URL,
  };
  return (
    <OperatorInstallCard
      clusterId={clusterId}
      spec={TRIVY_OPERATOR}
      texts={texts}
      action={INSTALL_ACTION}
      crdsServed={crdsServed}
    />
  );
}
