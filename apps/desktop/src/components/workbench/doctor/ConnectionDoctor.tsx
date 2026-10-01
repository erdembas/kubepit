import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Loader2,
  Pencil,
  Play,
  Stethoscope,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { ipc, isTauri } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { ConnectionDoctorReport, ConnectionDoctorStatus } from '@/types/connectionDoctor';
import { capabilityLabel, codeLabel, stageLabel, statusLabel } from './labels';

const TONE: Record<ConnectionDoctorStatus, BadgeTone> = {
  passed: 'success',
  warning: 'warning',
  failed: 'critical',
  skipped: 'neutral',
};
const ICON = {
  passed: CircleCheck,
  warning: TriangleAlert,
  failed: CircleX,
  skipped: CircleDashed,
};

export function ConnectionDoctorDialog({
  clusterId,
  onClose,
}: {
  clusterId: string;
  onClose: () => void;
}) {
  i18n.useLocale();
  const name = useAppStore((s) => s.clusters.find((c) => c.id === clusterId)?.name);
  return (
    <Dialog
      title={i18n.t('Connection doctor')}
      subtitle={name}
      onClose={onClose}
      size="lg"
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
    >
      <ConnectionDoctorPage clusterId={clusterId} onNavigate={onClose} />
    </Dialog>
  );
}

/** On-demand only. The same page works on disconnected and connected clusters. */
export function ConnectionDoctorPage({
  clusterId,
  onNavigate,
}: {
  clusterId: string;
  isActive?: boolean;
  onNavigate?: () => void;
}) {
  i18n.useLocale();
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const [namespace, setNamespace] = useState(
    cluster?.default_namespace || cluster?.accessible_namespaces[0] || 'default',
  );
  const [report, setReport] = useState<ConnectionDoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    setReport(null);
    setBusy(false);
    setError(false);
    setNamespace(cluster?.default_namespace || cluster?.accessible_namespaces[0] || 'default');
    return () => {
      request.current++;
    };
    // Namespace is a user-editable input; cluster metadata updates must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  const run = async () => {
    if (busy) return;
    const generation = ++request.current;
    setBusy(true);
    setError(false);
    setReport(null);
    try {
      const result = await ipc.connectionDoctorRun(clusterId, namespace.trim());
      if (generation === request.current) setReport(result);
    } catch {
      if (generation === request.current) setError(true);
    } finally {
      if (generation === request.current) setBusy(false);
    }
  };
  if (!cluster) return null;
  const failures = report?.steps.filter((s) => s.status === 'failed').length ?? 0;
  const warnings = report?.steps.filter((s) => s.status === 'warning').length ?? 0;
  return (
    <section className="bg-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="border-border/60 flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
        <Stethoscope className="text-accent h-4 w-4" />
        <h2 className="text-fg text-[13px] font-semibold">{i18n.t('Connection doctor')}</h2>
        {!isTauri && <Badge tone="info">{i18n.t('Demo')}</Badge>}
        <div className="ml-auto flex gap-1.5">
          <Button
            variant="ghost"
            leftIcon={<Wrench className="h-3.5 w-3.5" />}
            onClick={() => {
              onNavigate?.();
              useAppStore.getState().openSettings('tools');
            }}
          >
            {i18n.t('Tools')}
          </Button>
          <Button
            variant="secondary"
            leftIcon={<Pencil className="h-3.5 w-3.5" />}
            onClick={() => {
              onNavigate?.();
              useAppStore.getState().openClusterEditor({ mode: 'edit', cluster });
            }}
          >
            {i18n.t('Edit cluster')}
          </Button>
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4">
        <p className="text-fg-muted text-[12px] leading-relaxed">
          {i18n.t(
            'Check credentials, the network route and permissions without changing resources or starting a cluster session. Your configured authentication helper may run. Checks finish within one minute.',
          )}
        </p>
        {!isTauri && (
          <p className="text-fg-dim text-[11px]">
            {i18n.t('Demo results are synthetic. No programs run and no cluster is contacted.')}
          </p>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <label className="min-w-48 flex-1 space-y-1">
            <span className="text-fg-dim text-[11px] font-semibold tracking-wider uppercase">
              {i18n.t('Namespace to check')}
            </span>
            <Input
              mono
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              disabled={busy}
              maxLength={63}
              aria-label={i18n.t('Namespace to check')}
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !namespace.trim()}
            leftIcon={
              busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )
            }
          >
            {busy ? i18n.t('Running checks…') : i18n.t('Run connection checks')}
          </Button>
        </form>
        {busy && (
          <p role="status" className="text-fg-dim text-[12px]">
            {i18n.t('Checking the connection and namespace capabilities…')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-status-error text-[12px]">
            {i18n.t(
              'Connection checks could not finish. Check that the cluster still exists and try again.',
            )}
          </p>
        )}
        {report && (
          <>
            <div className="flex flex-wrap items-center gap-2" role="status">
              <Badge tone={failures ? 'critical' : warnings ? 'warning' : 'success'}>
                {failures
                  ? i18n.t('Connection needs repair')
                  : warnings
                    ? i18n.t('Review the findings')
                    : i18n.t('Connection checks passed')}
              </Badge>
              <span className="text-fg-dim text-[11px]">
                {i18n.t('Checked namespace {namespace}', { namespace: report.namespace })}
              </span>
            </div>
            <ol className="border-border/60 divide-border/60 divide-y overflow-hidden rounded-lg border">
              {report.steps.map((step) => {
                const Icon = ICON[step.status];
                return (
                  <li key={step.stage} className="hover:bg-fg/[0.02] flex gap-3 p-3">
                    <Icon
                      className={`mt-0.5 h-4 w-4 shrink-0 ${step.status === 'failed' ? 'text-status-error' : step.status === 'warning' ? 'text-status-starting' : step.status === 'passed' ? 'text-status-running' : 'text-fg-dim'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-fg text-[12px] font-semibold">
                          {stageLabel(step.stage)}
                        </h3>
                        <Badge tone={TONE[step.status]}>{statusLabel(step.status)}</Badge>
                      </div>
                      <p className="text-fg-muted mt-1 text-[12px] leading-relaxed">
                        {codeLabel(step.code)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
            {report.capabilities.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-fg-dim text-[11px] font-semibold tracking-wider uppercase">
                  {i18n.t('Capability checks')}
                </h3>
                <div className="border-border/60 divide-border/60 divide-y rounded-lg border">
                  {report.capabilities.map((capability) => (
                    <div
                      key={capability.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]"
                    >
                      <span className="text-fg-muted">{capabilityLabel(capability.id)}</span>
                      <Badge
                        tone={
                          capability.blocked_by_read_only
                            ? 'neutral'
                            : capability.allowed === true
                              ? 'success'
                              : capability.allowed === false
                                ? 'warning'
                                : 'neutral'
                        }
                      >
                        {capability.blocked_by_read_only
                          ? i18n.t('Read-only cluster')
                          : capability.allowed === true
                            ? i18n.t('Allowed')
                            : capability.allowed === false
                              ? i18n.t('Denied by RBAC')
                              : i18n.t('Unknown')}
                      </Badge>
                    </div>
                  ))}
                </div>
                <p className="text-fg-dim text-[11px]">
                  {i18n.t(
                    'These checks cover common operations in the selected namespace. Admission policies, individual resources and other namespaces can have different restrictions.',
                  )}
                </p>
              </div>
            )}
            <div className="space-y-2">
              <h3 className="text-fg-dim text-[11px] font-semibold tracking-wider uppercase">
                {i18n.t('Tools and metrics')}
              </h3>
              <div className="border-border/60 divide-border/60 divide-y rounded-lg border">
                {report.tools.map((tool) => (
                  <div
                    key={tool.id}
                    className="flex items-center justify-between px-3 py-2 text-[12px]"
                  >
                    <span className="text-fg-muted font-mono">{tool.id}</span>
                    <Badge tone={tool.available ? 'success' : 'warning'}>
                      {tool.available ? i18n.t('Available') : i18n.t('Not installed')}
                    </Badge>
                  </div>
                ))}
                <div className="flex items-center justify-between px-3 py-2 text-[12px]">
                  <span className="text-fg-muted font-mono">metrics.k8s.io</span>
                  <Badge tone={report.metrics_api === 'available' ? 'success' : 'neutral'}>
                    {report.metrics_api === 'available'
                      ? i18n.t('Available')
                      : report.metrics_api === 'missing'
                        ? i18n.t('API not installed')
                        : report.metrics_api === 'unchecked'
                          ? i18n.t('Not checked')
                          : i18n.t('Unknown')}
                  </Badge>
                </div>
              </div>
              <p className="text-fg-dim text-[11px]">
                {i18n.t(
                  'kubectl is needed for interactive shells; helm is needed for chart operations. Metrics API availability and permission to read metrics are checked separately.',
                )}
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
