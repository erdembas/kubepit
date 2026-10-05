import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  CircleHelp,
  Loader2,
  Play,
  Shield,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/lib/ipc/invoke';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo } from '@/types';
import type { NetworkDiagnosticsReport, NetworkProbeProtocol } from '@/types/networkDiagnostics';
import { useSelectedNamespaces } from '../data/hooks';
import { useWatch } from '../data/watchCache';
import { NamespacePicker } from '../header/NamespacePicker';
import {
  networkDiagnosticsError,
  objectKey,
  probeReasonLabel,
  probeStatusLabel,
  runningContainers,
  servicePorts,
  validProbePath,
} from './model';

const PODS = toGvk(BUILTIN.Pod);
const SERVICES = toGvk(BUILTIN.Service);

export function NetworkDiagnosticsPage({
  clusterId,
  viewKey,
  isActive,
}: {
  clusterId: string;
  viewKey: string;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const namespaces = useSelectedNamespaces(clusterId, viewKey);
  const podWatch = useWatch(clusterId, PODS, namespaces, isActive);
  const serviceWatch = useWatch(clusterId, SERVICES, namespaces, isActive);
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const [sourceKey, setSourceKey] = useState('');
  const [containerName, setContainerName] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [portValue, setPortValue] = useState('');
  const [protocol, setProtocol] = useState<NetworkProbeProtocol>('http');
  const [path, setPath] = useState('/');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<NetworkDiagnosticsReport | null>(null);
  const runId = useRef(0);
  useEffect(() => {
    runId.current += 1;
    setReport(null);
    setError(null);
    setRunning(false);
    setSourceKey('');
    setContainerName('');
    setTargetKey('');
    setPortValue('');
    return () => {
      runId.current += 1;
    };
  }, [clusterId]);
  const pods = useMemo(
    () => podWatch.items.filter((p) => runningContainers(p).length > 0),
    [podWatch.items],
  );
  const services = useMemo(
    () => serviceWatch.items.filter((s) => servicePorts(s).length > 0),
    [serviceWatch.items],
  );
  const source = sourceKey ? pods.find((p) => objectKey(p) === sourceKey) : pods[0];
  const containers = runningContainers(source);
  const container = containerName
    ? containers.includes(containerName)
      ? containerName
      : ''
    : (containers[0] ?? '');
  const target = targetKey ? services.find((s) => objectKey(s) === targetKey) : services[0];
  const ports = servicePorts(target);
  const port = portValue
    ? ports.includes(Number(portValue))
      ? Number(portValue)
      : undefined
    : ports[0];
  const pathValid = validProbePath(path);
  const ready = !!source && !!target && !!container && !!port && (protocol === 'tcp' || pathValid);

  async function run() {
    if (!ready || running || cluster?.read_only || !source || !target || !port) return;
    const id = ++runId.current;
    setSourceKey(objectKey(source));
    setContainerName(container);
    setTargetKey(objectKey(target));
    setPortValue(String(port));
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const next = await ipc.networkDiagnosticsRun(clusterId, {
        namespace: source.metadata.namespace ?? 'default',
        pod: source.metadata.name,
        container,
        target_namespace: target.metadata.namespace ?? 'default',
        service: target.metadata.name,
        port,
        protocol,
        path: protocol === 'tcp' ? '/' : path,
      });
      if (runId.current === id) setReport(next);
    } catch (e) {
      if (runId.current === id) setError(networkDiagnosticsError(e));
    } finally {
      if (runId.current === id) setRunning(false);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-accent/10 text-accent flex h-6 w-6 items-center justify-center rounded-md">
          <Activity className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg text-[13px] font-semibold">{i18n.t('Live network diagnostics')}</h2>
        <span className="ml-auto" />
        <NamespacePicker clusterId={clusterId} viewKey={viewKey} isActive={isActive} />
        <Button
          size="xs"
          leftIcon={<Shield className="h-3 w-3" />}
          onClick={() =>
            useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.netpolSimulator)
          }
        >
          {i18n.t('Open policy simulator')}
        </Button>
      </div>
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-5xl space-y-4">
          <p className="text-fg-muted text-[12px] leading-relaxed">
            {i18n.t(
              'Trace DNS, TCP, TLS and HTTP from an existing running container to a Service. Each probe has an eight-second limit.',
            )}
          </p>
          {!isTauri && (
            <p className="border-accent/20 bg-accent/5 text-accent rounded-lg border px-3 py-2 text-[11px]">
              {i18n.t('Demo results are simulated from fixture data; no cluster traffic is sent.')}
            </p>
          )}
          {cluster?.read_only && (
            <p className="border-status-starting/25 bg-status-starting/5 text-status-starting rounded-lg border px-3 py-2 text-[12px]">
              {i18n.t(
                'This cluster is read-only. Network probes require Pod exec and are disabled.',
              )}
            </p>
          )}
          {(podWatch.error || serviceWatch.error) && (
            <div role="alert" className="text-status-starting text-[11px]">
              {i18n.t('Some sources or targets could not be loaded.')}
              <pre className="mt-1 whitespace-pre-wrap">
                {[podWatch.error, serviceWatch.error].filter(Boolean).join('\n')}
              </pre>
            </div>
          )}
          <div className="border-border/60 bg-surface rounded-lg border p-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 @xl:grid-cols-2">
              <Field label={i18n.t('Source Pod')}>
                <Select
                  disabled={running}
                  className="w-full"
                  ariaLabel={i18n.t('Source Pod')}
                  value={source ? objectKey(source) : ''}
                  onChange={(key) => {
                    setSourceKey(key);
                    setContainerName('');
                  }}
                  options={pods.map((p) => ({ value: objectKey(p), label: objectKey(p) }))}
                  placeholder={i18n.t('No running Pods')}
                />
              </Field>
              <Field label={i18n.t('Source container')}>
                <Select
                  disabled={running}
                  className="w-full"
                  ariaLabel={i18n.t('Source container')}
                  value={container}
                  onChange={setContainerName}
                  options={containers.map((name) => ({ value: name, label: name }))}
                />
              </Field>
              <Field label={i18n.t('Target Service')}>
                <Select
                  disabled={running}
                  className="w-full"
                  ariaLabel={i18n.t('Target Service')}
                  value={target ? objectKey(target) : ''}
                  onChange={(key) => {
                    setTargetKey(key);
                    setPortValue('');
                  }}
                  options={services.map((s) => ({ value: objectKey(s), label: objectKey(s) }))}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={i18n.t('Service port')}>
                  <Select
                    disabled={running}
                    className="w-full"
                    ariaLabel={i18n.t('Service port')}
                    value={String(port ?? '')}
                    onChange={setPortValue}
                    options={ports.map((n) => ({ value: String(n), label: String(n) }))}
                  />
                </Field>
                <Field label={i18n.t('Protocol')}>
                  <Select
                    disabled={running}
                    className="w-full"
                    ariaLabel={i18n.t('Protocol')}
                    value={protocol}
                    onChange={setProtocol}
                    options={[
                      { value: 'tcp', label: 'TCP' },
                      { value: 'http', label: 'HTTP' },
                      { value: 'https', label: 'HTTPS' },
                    ]}
                  />
                </Field>
              </div>
              {protocol !== 'tcp' && (
                <Field
                  className="md:col-span-2"
                  label={i18n.t('HTTP HEAD path')}
                  error={
                    pathValid ? null : i18n.t('Use an absolute path without a query or fragment.')
                  }
                >
                  <Input
                    aria-label={i18n.t('HTTP HEAD path')}
                    disabled={running}
                    mono
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                  />
                </Field>
              )}
            </div>
            <div className="border-border/50 mt-4 flex flex-wrap items-center gap-3 border-t pt-3">
              <Button
                variant="primary"
                size="sm"
                disabled={!ready || running || cluster?.read_only}
                leftIcon={
                  running ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )
                }
                onClick={() => void run()}
              >
                {running ? i18n.t('Running probes…') : i18n.t('Run diagnostics')}
              </Button>
              <span className="text-fg-dim max-w-xl text-[11px]">
                {i18n.t(
                  'Uses tools already in the container. Missing tools are reported as unavailable. HTTP uses HEAD without redirects.',
                )}
              </span>
            </div>
          </div>
          {sourceKey && !source && (
            <p className="text-status-starting text-[12px]">
              {i18n.t(
                'The selected source is no longer running. Choose a source before running again.',
              )}
            </p>
          )}
          {!pods.length && podWatch.synced && (
            <p className="text-fg-dim text-[12px]">
              {i18n.t('Select a namespace containing a running Pod to start.')}
            </p>
          )}
          {error && (
            <div
              role="alert"
              className="border-status-error/25 bg-status-error/5 text-status-error rounded-lg border p-3 text-[12px] whitespace-pre-wrap"
            >
              {error}
            </div>
          )}
          {running && (
            <p role="status" className="text-fg-muted flex items-center gap-2 text-[12px]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {i18n.t('Inspecting Service endpoints and running bounded probes…')}
            </p>
          )}
          {report && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-fg-dim">{i18n.t('Executed from')}</span>
                <code className="text-fg">
                  {report.request.namespace}/{report.request.pod}:{report.request.container}
                </code>
                <ArrowRight className="text-fg-dim h-3 w-3" />
                <code className="text-fg">
                  {report.host}:{report.request.port}
                </code>
                <time className="text-fg-dim ml-auto" dateTime={report.checked_at}>
                  {new Date(report.checked_at).toLocaleTimeString()}
                </time>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {report.probes.map((probe) => (
                  <div
                    key={probe.kind}
                    className="border-border/60 bg-surface relative overflow-hidden rounded-lg border p-3"
                  >
                    <span
                      className={cn(
                        'absolute inset-y-0 left-0 w-0.5',
                        probe.status === 'passed'
                          ? 'bg-status-running'
                          : probe.status === 'failed' || probe.status === 'timed_out'
                            ? 'bg-status-error'
                            : 'bg-fg/20',
                      )}
                    />
                    <div className="flex items-center gap-2">
                      {probe.status === 'passed' ? (
                        <Check className="text-status-running h-3.5 w-3.5" />
                      ) : probe.status === 'unavailable' ? (
                        <CircleHelp className="text-fg-dim h-3.5 w-3.5" />
                      ) : (
                        <TriangleAlert className="text-status-starting h-3.5 w-3.5" />
                      )}
                      <span className="text-fg text-[12px] font-semibold">
                        {probe.kind === 'http' ? i18n.t('HTTP HEAD') : probe.kind.toUpperCase()}
                      </span>
                      <span className="text-fg-muted text-[11px]">
                        {probeStatusLabel(probe.status)}
                      </span>
                      <span className="text-fg-dim ml-auto text-[11px] tabular-nums">
                        {probe.duration_ms} ms
                      </span>
                    </div>
                    <p className="text-fg-muted mt-2 text-[11px]">{probeReasonLabel(probe)}</p>
                    {probe.output && (
                      <pre className="overlay-scroll bg-fg/3 text-fg-muted mt-2 max-h-40 overflow-auto rounded p-2 font-mono text-[11px] break-all whitespace-pre-wrap">
                        {probe.output}
                      </pre>
                    )}
                    <details className="text-fg-dim mt-2 text-[11px]">
                      <summary className="hover:text-fg cursor-pointer">
                        {i18n.t('Executed command')}
                      </summary>
                      <pre className="mt-1 break-all whitespace-pre-wrap">
                        {probe.command.map((arg) => JSON.stringify(arg)).join(' ')}
                      </pre>
                    </details>
                  </div>
                ))}
              </div>
              <div className="border-border/60 bg-surface rounded-lg border p-3 text-[12px]">
                <h3 className="text-fg-dim text-[11px] font-semibold tracking-wider uppercase">
                  {i18n.t('Service context')}
                </h3>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <div>
                    <span className="text-fg-dim text-[11px]">{i18n.t('Cluster IP')}</span>
                    <code className="text-fg mt-1 block">
                      {report.service.cluster_ip ?? report.service.external_name ?? '—'}
                    </code>
                  </div>
                  <div>
                    <span className="text-fg-dim text-[11px]">{i18n.t('Ready endpoints')}</span>
                    <div className="text-fg mt-1">
                      {report.service.endpoints_error ? '—' : report.service.ready_endpoints}
                    </div>
                  </div>
                  <div>
                    <span className="text-fg-dim text-[11px]">{i18n.t('Not-ready endpoints')}</span>
                    <div className="text-fg mt-1">
                      {report.service.endpoints_error ? '—' : report.service.unready_endpoints}
                    </div>
                  </div>
                </div>
                {report.service.endpoints_error && (
                  <p className="text-status-starting mt-3 text-[11px]">
                    {i18n.t('EndpointSlice information is unavailable: {error}', {
                      error: report.service.endpoints_error,
                    })}
                  </p>
                )}
                {report.service.endpoints_truncated && (
                  <p className="text-status-starting mt-3 text-[11px]">
                    {i18n.t(
                      'Endpoint counts are partial because the inspection limit was reached.',
                    )}
                  </p>
                )}
                {!report.service.endpoints_error &&
                  !report.service.ready_endpoints &&
                  !report.service.external_name && (
                    <p className="text-status-starting mt-3 text-[11px]">
                      {i18n.t(
                        'This Service has no ready endpoints in the inspected EndpointSlices.',
                      )}
                    </p>
                  )}
                <div className="text-fg-dim mt-3 text-[11px]">
                  {i18n.t('Selector')}
                  <code className="text-fg-muted ml-2">
                    {Object.entries(report.service.selector)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(', ') || i18n.t('No selector')}
                  </code>
                </div>
                {report.service.addresses.length > 0 && (
                  <pre className="text-fg-dim mt-2 text-[11px] whitespace-pre-wrap">
                    {report.service.addresses.join(' · ')}
                  </pre>
                )}
              </div>
              <div className="text-fg-dim flex items-start gap-2 text-[11px] leading-relaxed">
                <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  {i18n.t(
                    'A failed probe can have several causes. Compare these observations with the Network Policy Simulator; live probes do not identify which policy enforced a decision.',
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
