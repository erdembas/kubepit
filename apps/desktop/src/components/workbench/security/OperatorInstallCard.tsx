import * as i18n from '@/i18n';
import { useState } from 'react';
import {
  Check,
  Circle,
  Download,
  ExternalLink,
  Loader2,
  RotateCcw,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import { useActionGate, type GateableAction } from '../access/gates';
import { openExternal } from '../actions/openExternal';
import { useCluster } from '../data/hooks';
import { CodeBlock } from '../details/primitives';
import { refreshAppInfo, useHelmMissing } from '../helm/ChartBits';
import { formatElapsed, isHelmMissingError } from '../helm/charts';
import { useNow } from '../util';
import {
  installOperator,
  useOperatorInstall,
  type OperatorInstallState,
  type OperatorInstallStep,
  type OperatorSpec,
} from './operatorInstall';

/**
 * The one-click operator install card, shared by the Security view's
 * missing states (Trivy Operator, Kyverno): gates (RBAC, read-only,
 * missing helm), the production typed confirmation, the step list, the
 * failure panel and the equivalent helm commands. Every sentence is a
 * prop, so each operator keeps its own wording.
 */

export interface OperatorInstallTexts {
  /** Operator name for dialogs ("Trivy Operator", "Kyverno"). */
  displayName: string;
  /** Headline when the CRDs are not served at all. */
  title: string;
  /** Headline when the CRDs are served but no operator writes reports. */
  titleNotRunning?: string;
  /** What the operator is and does. */
  body: string;
  /** Same for the "not running" case. */
  bodyNotRunning?: string;
  installLabel: string;
  installingLabel: string;
  /** Sentence after the chart and cluster facts of the production confirmation. */
  confirmImpact: string;
  /** Footer under the button: what the install does. */
  footnote: string;
  /** The same commands, to run yourself. */
  helmCommand: string;
  guideUrl: string;
}

const STEPS: readonly OperatorInstallStep[] = ['repo', 'install', 'discover'];

function stepLabels(spec: OperatorSpec): string[] {
  return [
    i18n.t('Prepare the {repo} Helm repository', { repo: spec.repoLabel }),
    i18n.t('Install the {chart} chart into {namespace}', {
      chart: spec.chartName,
      namespace: spec.namespace,
    }),
    i18n.t('Load the report resources'),
  ];
}

function Steps({
  state,
  now,
  labels,
}: {
  state: OperatorInstallState;
  now: number;
  labels: string[];
}) {
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
            <span className="min-w-0">{labels[i]}</span>
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

export function OperatorInstallCard({
  clusterId,
  spec,
  texts,
  action,
  crdsServed = false,
}: {
  clusterId: string;
  spec: OperatorSpec;
  texts: OperatorInstallTexts;
  /** RBAC/read-only gate of this operator's install. */
  action: GateableAction;
  crdsServed?: boolean;
}) {
  i18n.useLocale();
  const { cluster, readOnly } = useCluster(clusterId);
  const helmMissing = useHelmMissing();
  const [checking, setChecking] = useState(false);
  const install = useOperatorInstall(clusterId, spec);
  const running = install?.status === 'running';
  const now = useNow(1000, running && install.step === 'install');
  const gate = useActionGate(clusterId, action, readOnly);
  const blocked = gate.blocked
    ? gate.message
    : helmMissing
      ? i18n.t(
          'Kubepit installs it with the helm CLI, which was not found. Install helm, or tell Kubepit where it is.',
        )
      : null;
  const helmError = install?.status === 'failed' && isHelmMissingError(install.error);
  const labels = stepLabels(spec);

  const start = () => {
    if (running || blocked) return;
    // A failed discovery only rediscovers; everything else changes the cluster.
    const changes = install?.step !== 'discover';
    if (changes && cluster?.environment === 'production') {
      useAppStore.getState().requestConfirm({
        title: i18n.t('Install {operator}', { operator: texts.displayName }),
        message: `${i18n.t(
          'Install the {chart} chart as "{name}" into {namespace} on {cluster}?',
          {
            chart: spec.chartName,
            name: spec.releaseName,
            namespace: spec.namespace,
            cluster: cluster.name,
          },
        )}\n${texts.confirmImpact}\n\n${i18n.t('This is a production cluster.')}`,
        confirmLabel: i18n.t('Install'),
        typeToConfirm: spec.releaseName,
        onConfirm: () => void installOperator(clusterId, spec),
      });
      return;
    }
    void installOperator(clusterId, spec);
  };

  return (
    <div className="overlay-scroll flex min-h-0 flex-1 overflow-auto p-6">
      <div className="m-auto w-full max-w-lg">
        <h3 className="text-fg text-[13.5px] font-semibold">
          {crdsServed && texts.titleNotRunning ? texts.titleNotRunning : texts.title}
        </h3>
        <p className="text-fg-muted mt-2 text-[12px] leading-relaxed">
          {crdsServed && texts.bodyNotRunning ? texts.bodyNotRunning : texts.body}
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
              ? texts.installingLabel
              : install?.status === 'failed'
                ? i18n.t('Try again')
                : texts.installLabel}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void openExternal(texts.guideUrl)}
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
        <p className="text-fg-dim mt-2 text-[11px] leading-relaxed">{blocked ?? texts.footnote}</p>

        {install && <Steps state={install} now={now} labels={labels} />}
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
          <CodeBlock text={texts.helmCommand} />
        </div>
      </div>
    </div>
  );
}
