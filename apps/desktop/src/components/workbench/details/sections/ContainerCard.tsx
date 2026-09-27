import * as i18n from '@/i18n';
import { useState } from 'react';
import { ArrowRightLeft, ChevronRight, ScrollText, SquareTerminal } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { asArray, asObject, asString, isObject, type JsonObject } from '@/lib/kube/accessors';
import { containerTone, type ContainerInfo } from '@/lib/kube/pods';
import { cn } from '@/lib/cn';
import { formatAge, formatBytes, formatCpu } from '@/lib/format';
import { dock } from '@/store/useDockStore';
import type { KubeObject, PodMetric } from '@/types';
import { useActionDialogs } from '../../actions/dialogStore';
import { openPodLogs, podPorts } from '../../actions/resourceActions';
import { ChipList, CodeBlock, MonoText, Row, Rows } from '../primitives';

function envValue(e: JsonObject): string {
  if (e.value !== undefined) return asString(e.value);
  const from = asObject(e.valueFrom);
  if (isObject(from.secretKeyRef))
    return `secretKeyRef: ${asString(from.secretKeyRef.name)}/${asString(from.secretKeyRef.key)}`;
  if (isObject(from.configMapKeyRef))
    return `configMapKeyRef: ${asString(from.configMapKeyRef.name)}/${asString(from.configMapKeyRef.key)}`;
  if (isObject(from.fieldRef)) return `fieldRef: ${asString(from.fieldRef.fieldPath)}`;
  if (isObject(from.resourceFieldRef))
    return `resourceFieldRef: ${asString(from.resourceFieldRef.resource)}`;
  return '';
}

function probeText(p: unknown): string | null {
  if (!isObject(p)) return null;
  let target = '';
  if (isObject(p.httpGet))
    target = `http-get ${asString(p.httpGet.scheme).toLowerCase() || 'http'}://:${asString(p.httpGet.port)}${asString(p.httpGet.path)}`;
  else if (isObject(p.tcpSocket)) target = `tcp-socket :${asString(p.tcpSocket.port)}`;
  else if (isObject(p.exec))
    target = `exec [${asArray(p.exec.command)
      .map((x) => asString(x))
      .join(' ')}]`;
  else if (isObject(p.grpc)) target = `grpc :${asString(p.grpc.port)}`;
  const timing = [
    p.initialDelaySeconds !== undefined && `delay=${asString(p.initialDelaySeconds)}s`,
    p.timeoutSeconds !== undefined && `timeout=${asString(p.timeoutSeconds)}s`,
    p.periodSeconds !== undefined && `period=${asString(p.periodSeconds)}s`,
    p.failureThreshold !== undefined && `#failure=${asString(p.failureThreshold)}`,
  ].filter(Boolean);
  return `${target} ${timing.join(' ')}`.trim();
}

export function ContainerCard({
  clusterId,
  pod,
  c,
  metric,
  now,
}: {
  clusterId: string;
  pod: KubeObject;
  c: ContainerInfo;
  metric?: PodMetric['containers'][number];
  now: number;
}) {
  i18n.useLocale();
  const [showEnv, setShowEnv] = useState(false);
  const s = c.spec;
  const env = asArray(s.env).filter(isObject);
  const envFrom = asArray(s.envFrom).filter(isObject);
  const mounts = asArray(s.volumeMounts).filter(isObject);
  const resources = asObject(s.resources);
  const requests = asObject(resources.requests);
  const limits = asObject(resources.limits);
  const ports = podPorts({ ...pod, spec: { containers: [s] } });
  const ns = pod.metadata.namespace ?? 'default';
  const stateLabel =
    c.state === 'running'
      ? c.ready
        ? 'Running'
        : 'Running (not ready)'
      : c.state === 'unknown'
        ? 'Unknown'
        : `${c.state === 'waiting' ? 'Waiting' : 'Terminated'}${c.reason ? `: ${c.reason}` : ''}`;

  return (
    <div className="border-border bg-surface-raised/40 rounded-lg border">
      <div className="border-border/60 flex items-center gap-2 border-b px-3 py-2">
        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-[2px]', containerTone(c))} aria-hidden />
        <span className="text-fg truncate text-[12.5px] font-semibold">{c.name}</span>
        {c.init && (
          <span className="bg-fg/6 text-fg-muted rounded px-1.5 py-px text-[10px] font-medium">
            {i18n.t('init')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<ScrollText className="h-3 w-3" />}
            onClick={() => openPodLogs(clusterId, pod, c.name)}
          >
            {i18n.t('Logs')}
          </Button>
          {!c.init && c.state === 'running' && (
            <Button
              size="xs"
              variant="ghost"
              leftIcon={<SquareTerminal className="h-3 w-3" />}
              onClick={() => dock.podExec(clusterId, ns, pod.metadata.name, c.name)}
            >
              {i18n.t('Shell')}
            </Button>
          )}
        </div>
      </div>
      <div className="px-3 py-2.5">
        <Rows>
          <Row label={i18n.t('Image')}>
            <MonoText>{c.image}</MonoText>
          </Row>
          <Row label={i18n.t('State')}>
            <span
              className={cn(
                c.state === 'running' && c.ready
                  ? 'text-status-running'
                  : c.state === 'terminated' && !c.exitCode
                    ? 'text-fg-muted'
                    : c.state === 'running'
                      ? 'text-status-starting'
                      : 'text-status-error',
              )}
            >
              {stateLabel}
            </span>
            {c.startedAt && (
              <span className="text-fg-dim ml-1.5 text-[11px]">
                {i18n.t('since {age}', { age: formatAge(c.startedAt, now) })}
              </span>
            )}
            {c.message && <p className="text-fg-dim mt-0.5 text-[11px] break-words">{c.message}</p>}
          </Row>
          {c.lastTermination && (
            <Row label={i18n.t('Last state')}>
              <span className="text-fg-muted">
                {c.lastTermination.reason}
                {c.lastTermination.exitCode !== null &&
                  ` (${i18n.t('exit code {code}', { code: c.lastTermination.exitCode })})`}
                {c.lastTermination.finishedAt && (
                  <span className="text-fg-dim ml-1.5 text-[11px]">
                    {formatAge(c.lastTermination.finishedAt, now)}
                  </span>
                )}
              </span>
            </Row>
          )}
          <Row label={i18n.t('Ready')}>{c.ready ? i18n.t('Yes') : i18n.t('No')}</Row>
          <Row label={i18n.t('Restarts')}>
            <span
              className={cn('tabular-nums', c.restarts > 5 && 'text-status-starting font-medium')}
            >
              {c.restarts}
            </span>
          </Row>
          {metric && (
            <Row label={i18n.t('Usage')}>
              <span className="tabular-nums">
                {formatCpu(metric.cpu_millicores)} CPU · {formatBytes(metric.memory_bytes)}
              </span>
            </Row>
          )}
          {(Object.keys(requests).length > 0 || Object.keys(limits).length > 0) && (
            <Row label={i18n.t('Resources')}>
              <span className="text-fg-muted font-mono text-[11px]">
                {i18n.t('requests')}: {asString(requests.cpu) || '—'} /{' '}
                {asString(requests.memory) || '—'} · {i18n.t('limits')}:{' '}
                {asString(limits.cpu) || '—'} / {asString(limits.memory) || '—'}
              </span>
            </Row>
          )}
          {ports.length > 0 && (
            <Row label={i18n.t('Ports')}>
              <span className="flex flex-wrap gap-1">
                {ports.map((p) => (
                  <button
                    key={p.port}
                    type="button"
                    onClick={() =>
                      useActionDialogs.getState().open({
                        kind: 'port-forward',
                        clusterId,
                        target: 'pod',
                        namespace: ns,
                        name: pod.metadata.name,
                        ports,
                        port: p.port,
                      })
                    }
                    title={i18n.t('Port forward {port}', { port: p.port })}
                    className="bg-fg/5 ring-border/60 text-fg-muted hover:text-accent hover:ring-accent/40 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10.5px] ring-1 transition"
                  >
                    {p.name ? `${p.name}: ` : ''}
                    {p.port}/{p.protocol}
                    <ArrowRightLeft className="h-2.5 w-2.5" />
                  </button>
                ))}
              </span>
            </Row>
          )}
          {s.command !== undefined && (
            <Row label={i18n.t('Command')}>
              <MonoText>
                {asArray(s.command)
                  .map((x) => asString(x))
                  .join(' ')}
              </MonoText>
            </Row>
          )}
          {s.args !== undefined && (
            <Row label={i18n.t('Arguments')}>
              <MonoText>
                {asArray(s.args)
                  .map((x) => asString(x))
                  .join(' ')}
              </MonoText>
            </Row>
          )}
          <Row label={i18n.t('Liveness')}>
            {probeText(s.livenessProbe) && <MonoText>{probeText(s.livenessProbe)}</MonoText>}
          </Row>
          <Row label={i18n.t('Readiness')}>
            {probeText(s.readinessProbe) && <MonoText>{probeText(s.readinessProbe)}</MonoText>}
          </Row>
          <Row label={i18n.t('Startup')}>
            {probeText(s.startupProbe) && <MonoText>{probeText(s.startupProbe)}</MonoText>}
          </Row>
          {mounts.length > 0 && (
            <Row label={i18n.t('Mounts')}>
              <span className="flex flex-col gap-0.5">
                {mounts.map((m) => (
                  <span
                    key={`${asString(m.name)}:${asString(m.mountPath)}`}
                    className="font-mono text-[11px]"
                  >
                    <span className="text-fg">{asString(m.mountPath)}</span>
                    <span className="text-fg-dim">
                      {' '}
                      ← {asString(m.name)}
                      {m.readOnly ? ' (ro)' : ''}
                    </span>
                  </span>
                ))}
              </span>
            </Row>
          )}
          {envFrom.length > 0 && (
            <Row label={i18n.t('Env from')}>
              <ChipList
                entries={envFrom.map((e) =>
                  isObject(e.secretRef)
                    ? `secret/${asString(e.secretRef.name)}`
                    : `configmap/${asString(asObject(e.configMapRef).name)}`,
                )}
              />
            </Row>
          )}
          {env.length > 0 && (
            <Row label={i18n.t('Environment')}>
              <button
                type="button"
                onClick={() => setShowEnv((x) => !x)}
                className="text-accent inline-flex items-center gap-1 text-[11.5px] hover:underline"
              >
                <ChevronRight
                  className={cn('h-3 w-3 transition-transform', showEnv && 'rotate-90')}
                />
                {i18n.t('{count} variables', { count: env.length })}
              </button>
              {showEnv && (
                <div className="mt-1.5">
                  <CodeBlock
                    text={env.map((e) => `${asString(e.name)}=${envValue(e)}`).join('\n')}
                    maxHeight="max-h-56"
                  />
                </div>
              )}
            </Row>
          )}
        </Rows>
      </div>
    </div>
  );
}
