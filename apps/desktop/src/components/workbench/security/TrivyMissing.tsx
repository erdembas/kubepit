import * as i18n from '@/i18n';
import { useState } from 'react';
import {
  Check,
  Circle,
  Download,
  ExternalLink,
  Loader2,
  RotateCcw,
  ShieldQuestion,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import {
  TRIVY_CHART,
  TRIVY_HELM_INSTALL,
  TRIVY_INSTALL_ACCESS,
  TRIVY_INSTALL_URL,
  TRIVY_NAMESPACE,
  TRIVY_RELEASE,
} from '@/lib/kube/trivy';
import { useAppStore } from '@/store/useAppStore';
import { useActionGate, type GateableAction } from '../access/gates';
import { openExternal } from '../actions/openExternal';
import { useCluster } from '../data/hooks';
import { CodeBlock } from '../details/primitives';
import { refreshAppInfo, useHelmMissing } from '../helm/ChartBits';
import { formatElapsed, isHelmMissingError } from '../helm/charts';
import { useNow } from '../util';
import {
  installTrivy,
  useTrivyInstallStore,
  type TrivyInstallState,
  type TrivyInstallStep,
} from './trivyInstall';

const INSTALL_ACTION: GateableAction = {
  id: 'trivy-install',
  mutating: true,
  access: TRIVY_INSTALL_ACCESS,
};

const STEPS: readonly TrivyInstallStep[] = ['repo', 'install', 'discover'];

function stepLabel(step: TrivyInstallStep) {
  switch (step) {
    case 'repo':
      return i18n.t('Prepare the aqua Helm repository');
    case 'install':
      return i18n.t('Install the {chart} chart into {namespace}', {
        chart: TRIVY_CHART,
        namespace: TRIVY_NAMESPACE,
      });
    case 'discover':
      return i18n.t('Load the report resources');
  }
}

function Steps({ state, now }: { state: TrivyInstallState; now: number }) {
  const at = STEPS.indexOf(state.step);
  return (
    <ol className="mt-4 flex flex-col gap-1.5" aria-label={i18n.t('Installation progress')}>
      {STEPS.map((step, i) => {
        const current = i === at;
        const failed = current && state.status === 'failed';
        const running = current && state.status === 'running';
        return (
          <li
            key={step}
            className={cn(
              'flex items-center gap-2 text-[12px]',
              i > at ? 'text-fg-dim' : failed ? 'text-status-error' : 'text-fg-muted',
              running && 'text-fg',
            )}
          >
            {i < at ? (
              <Check className="text-status-running h-3.5 w-3.5 shrink-0" />
            ) : failed ? (
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            ) : running ? (
              <Loader2 className="text-accent h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Circle className="h-3.5 w-3.5 shrink-0 opacity-50" />
            )}
            <span className="min-w-0">{stepLabel(step)}</span>
            {running && step === 'install' && (
              <span className="text-fg-dim ml-auto shrink-0 text-[11px] tabular-nums">
                {formatElapsed(now - state.startedAt)}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

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
  const { cluster, readOnly } = useCluster(clusterId);
  const helmMissing = useHelmMissing();
  const [checking, setChecking] = useState(false);
  const install = useTrivyInstallStore((s) => s.byCluster[clusterId]);
  const running = install?.status === 'running';
  const now = useNow(1000, running && install.step === 'install');
  const gate = useActionGate(clusterId, INSTALL_ACTION, readOnly);
  const blocked = gate.blocked
    ? gate.message
    : helmMissing
      ? i18n.t(
          'Kubepit installs it with the helm CLI, which was not found. Install helm, or tell Kubepit where it is.',
        )
      : null;
  const helmError = install?.status === 'failed' && isHelmMissingError(install.error);

  const start = () => {
    if (running || blocked) return;
    // A failed discovery only rediscovers; everything else changes the cluster.
    const changes = install?.step !== 'discover';
    if (changes && cluster?.environment === 'production') {
      useAppStore.getState().requestConfirm({
        title: i18n.t('Install Trivy Operator'),
        message: `${i18n.t(
          'Install the {chart} chart as "{name}" into {namespace} on {cluster}? It adds its CRDs, cluster-wide RBAC and an operator that scans every workload.',
          {
            chart: TRIVY_CHART,
            name: TRIVY_RELEASE,
            namespace: TRIVY_NAMESPACE,
            cluster: cluster.name,
          },
        )}\n\n${i18n.t('This is a production cluster.')}`,
        confirmLabel: i18n.t('Install'),
        typeToConfirm: TRIVY_RELEASE,
        onConfirm: () => void installTrivy(clusterId),
      });
      return;
    }
    void installTrivy(clusterId);
  };

  return (
    <div className="overlay-scroll flex min-h-0 flex-1 overflow-auto p-6">
      <div className="m-auto w-full max-w-lg">
        <div className="bg-fg/5 text-fg-dim mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
          <ShieldQuestion className="h-5 w-5" />
        </div>
        <h3 className="text-fg text-[13.5px] font-semibold">
          {crdsServed
            ? i18n.t('Trivy Operator is not running on this cluster')
            : i18n.t('Trivy Operator is not installed on this cluster')}
        </h3>
        <p className="text-fg-muted mt-2 text-[12px] leading-relaxed">
          {crdsServed
            ? i18n.t(
                'Its report resources (aquasecurity.github.io) are installed, but no Trivy Operator deployment was found, so no reports are written. Helm keeps these resources after a failed install or an uninstall; install the operator again to get reports.',
              )
            : i18n.t(
                'Trivy Operator is an open-source Kubernetes operator from Aqua Security. It scans the images of running workloads for known vulnerabilities, audits workload, RBAC and infrastructure configuration, finds secrets baked into images and produces compliance reports. The results are stored as custom resources (aquasecurity.github.io), which Kubepit reads here.',
              )}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={running || !!blocked}
            title={blocked ?? undefined}
            onClick={start}
            leftIcon={
              running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : install?.status === 'failed' ? (
                <RotateCcw className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )
            }
          >
            {running
              ? i18n.t('Installing Trivy Operator…')
              : install?.status === 'failed'
                ? i18n.t('Try again')
                : i18n.t('Install Trivy Operator')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void openExternal(TRIVY_INSTALL_URL)}
            rightIcon={<ExternalLink className="h-3 w-3" />}
          >
            {i18n.t('Installation guide')}
          </Button>
          {(helmMissing || helmError) && (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Wrench className="h-3.5 w-3.5" />}
              onClick={() => useAppStore.getState().openSettings('tools')}
            >
              {i18n.t('Open Settings → Tools')}
            </Button>
          )}
          {(helmMissing || helmError) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={checking}
              leftIcon={<RotateCcw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />}
              onClick={() => {
                setChecking(true);
                void refreshAppInfo().finally(() => setChecking(false));
              }}
            >
              {i18n.t('Check again')}
            </Button>
          )}
        </div>
        <p className="text-fg-dim mt-2 text-[11px] leading-relaxed">
          {blocked ??
            i18n.t(
              'Adds the aqua Helm repository and installs {chart} into {namespace} with helm, then waits for the operator to start.',
              { chart: TRIVY_CHART, namespace: TRIVY_NAMESPACE },
            )}
        </p>

        {install && <Steps state={install} now={now} />}
        {running && install.step === 'install' && (
          <p className="text-fg-dim mt-2 text-[11px]">
            {i18n.t('This usually takes a minute or two. You can leave this view meanwhile.')}
          </p>
        )}
        {install?.status === 'failed' && (
          <div className="border-status-error/30 bg-status-error/[0.06] mt-3 rounded-lg border px-3 py-2">
            <p className="text-status-error flex items-center gap-1.5 text-[12px] font-semibold">
              <TriangleAlert className="h-3.5 w-3.5" />
              {install.step === 'discover'
                ? i18n.t('Could not load the report resources')
                : i18n.t('Install failed')}
            </p>
            <pre className="text-status-error/90 mt-1 max-h-40 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap">
              {install.error}
            </pre>
          </div>
        )}

        <p className="text-fg-muted mt-6 text-[12px] leading-relaxed">
          {i18n.t(
            'Or run the same commands yourself, then come back once the first reports are written:',
          )}
        </p>
        <div className="mt-3">
          <CodeBlock text={TRIVY_HELM_INSTALL} />
        </div>
      </div>
    </div>
  );
}
