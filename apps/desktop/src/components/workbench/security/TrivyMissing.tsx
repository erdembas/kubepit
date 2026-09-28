import * as i18n from '@/i18n';
import { ExternalLink, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { TRIVY_HELM_INSTALL, TRIVY_INSTALL_URL } from '@/lib/kube/trivy';
import { openExternal } from '../actions/openExternal';
import { CodeBlock } from '../details/primitives';

/** Shown instead of the Trivy dashboard when the cluster serves no Trivy Operator CRDs. */
export function TrivyMissing() {
  i18n.useLocale();
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-lg">
        <div className="bg-fg/5 text-fg-dim mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
          <ShieldQuestion className="h-5 w-5" />
        </div>
        <h3 className="text-fg text-[13.5px] font-semibold">
          {i18n.t('Trivy Operator is not installed on this cluster')}
        </h3>
        <p className="text-fg-muted mt-2 text-[12px] leading-relaxed">
          {i18n.t(
            'Trivy Operator is an open-source Kubernetes operator from Aqua Security. It scans the images of running workloads for known vulnerabilities, audits workload, RBAC and infrastructure configuration, finds secrets baked into images and produces compliance reports. The results are stored as custom resources (aquasecurity.github.io), which Kubepit reads here.',
          )}
        </p>
        <p className="text-fg-muted mt-2 text-[12px] leading-relaxed">
          {i18n.t('Install it with Helm, then come back once the first reports are written:')}
        </p>
        <div className="mt-3">
          <CodeBlock text={TRIVY_HELM_INSTALL} />
        </div>
        <Button
          className="mt-4"
          size="sm"
          variant="secondary"
          onClick={() => void openExternal(TRIVY_INSTALL_URL)}
          rightIcon={<ExternalLink className="h-3 w-3" />}
        >
          {i18n.t('Installation guide')}
        </Button>
      </div>
    </div>
  );
}
