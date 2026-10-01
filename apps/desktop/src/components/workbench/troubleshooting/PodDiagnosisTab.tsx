import * as i18n from '@/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowUpRight,
  Bell,
  Loader2,
  RefreshCw,
  ScrollText,
  Stethoscope,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ipc } from '@/lib/ipc';
import { formatBytes, formatCpu } from '@/lib/format';
import { asString } from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import type { ColumnContext } from '@/lib/kube/columns';
import { dock } from '@/store/useDockStore';
import type { KubeObject } from '@/types';
import { usePolled } from '../data/polled';
import { CodeBlock } from '../details/primitives';
import { startInvestigation, useInvestigationStore } from '../investigations/navigation';
import { diagnosePod, evidenceError } from './model';
import { evidenceErrorLabel, evidenceLabel, findingTitle, nextCheck } from './labels';
import { readPreviousLogs, type PreviousLogState } from './previousLogs';

const POD = toGvk(BUILTIN.Pod);

export function PodDiagnosisTab({
  clusterId,
  obj,
  isActive,
  ctx,
  onEvents,
  onDetails,
}: {
  clusterId: string;
  obj: KubeObject;
  isActive: boolean;
  ctx: ColumnContext;
  onEvents: () => void;
  onDetails: () => void;
}) {
  i18n.useLocale();
  const namespace = obj.metadata.namespace ?? 'default';
  const events = usePolled(
    `${clusterId}|events|${obj.metadata.uid}`,
    () => ipc.resourceEvents(clusterId, namespace, obj.metadata.uid),
    10_000,
    isActive,
  );
  // Share the same cache as the details panel, but keep failures visible here.
  const metrics = usePolled(
    `${clusterId}|metrics-pods|${namespace}`,
    () => ipc.metricsPods(clusterId, namespace),
    15_000,
    isActive,
  );
  const diagnosis = useMemo(() => diagnosePod(obj, events.data ?? []), [obj, events.data]);
  const metric =
    !metrics.error && metrics.data?.available
      ? metrics.data.items.find(
          (item) => item.namespace === namespace && item.name === obj.metadata.name,
        )
      : undefined;
  const [containerName, setContainerName] = useState('');
  const container =
    diagnosis.containers.find((item) => item.name === containerName) ??
    diagnosis.containers.find((item) => item.lastTermination || item.restarts > 0) ??
    diagnosis.containers[0];
  const [logs, setLogs] = useState<PreviousLogState | null>(null);
  const generation = useRef(0);
  const cancelLogs = useRef<(() => void) | null>(null);
  const capturing = useInvestigationStore((state) => !!state.capturing[clusterId]);
  useEffect(() => {
    generation.current += 1;
    cancelLogs.current?.();
    cancelLogs.current = null;
    setLogs(null);
    setContainerName('');
  }, [clusterId, obj.metadata.uid]);
  useEffect(() => {
    if (!isActive)
      setLogs((previous) =>
        previous?.status === 'reading' ? { ...previous, status: 'cancelled' } : previous,
      );
    return () => {
      generation.current += 1;
      cancelLogs.current?.();
      cancelLogs.current = null;
    };
  }, [clusterId, obj.metadata.uid, isActive]);
  const selectContainer = (name: string) => {
    generation.current += 1;
    cancelLogs.current?.();
    cancelLogs.current = null;
    setLogs(null);
    setContainerName(name);
  };
  const read = () => {
    if (!container || !isActive) return;
    setContainerName(container.name);
    generation.current += 1;
    cancelLogs.current?.();
    const request = generation.current;
    cancelLogs.current = readPreviousLogs(
      ipc,
      {
        clusterId,
        namespace,
        pod: obj.metadata.name,
        container: container.name,
      },
      (next) => {
        if (request === generation.current) setLogs(next);
      },
    );
  };

  return (
    <section className="overlay-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div>
        <h3 className="text-fg flex items-center gap-2 text-[13px] font-semibold">
          <Stethoscope className="text-accent h-4 w-4" />
          {i18n.t('Pod diagnosis')}
        </h3>
        <p className="text-fg-dim mt-1.5 text-[11.5px] leading-relaxed">
          {i18n.t(
            'Observed states and recent events guide the next check. Findings do not prove a root cause; no commands are executed and no resources are changed.',
          )}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button
            size="xs"
            variant="secondary"
            onClick={onEvents}
            leftIcon={<Bell className="h-3 w-3" />}
          >
            {i18n.t('Events')}
          </Button>
          <Button size="xs" variant="secondary" onClick={onDetails}>
            {i18n.t('Details')}
          </Button>
          <Button
            size="xs"
            variant="secondary"
            disabled={events.loading || metrics.loading || !isActive}
            onClick={() => {
              void events.refresh();
              void metrics.refresh();
            }}
            leftIcon={<RefreshCw className="h-3 w-3" />}
          >
            {i18n.t('Refresh evidence')}
          </Button>
          <Button
            size="xs"
            variant="secondary"
            disabled={capturing || !isActive}
            onClick={() => void startInvestigation(clusterId, POD, obj)}
            leftIcon={
              capturing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Archive className="h-3 w-3" />
              )
            }
          >
            {i18n.t('Save investigation')}
          </Button>
        </div>
      </div>

      <div className="border-border/60 bg-surface-raised/40 space-y-2 rounded-md border p-3 text-[11.5px]">
        <p className="text-fg">
          <span className="text-fg-dim">{i18n.t('Pod phase')}: </span>
          {diagnosis.phase}
        </p>
        {events.error ? (
          <p className="text-status-starting">
            {evidenceErrorLabel(evidenceError(events.error))}{' '}
            {i18n.t('Event evidence may be incomplete or stale.')}
          </p>
        ) : !events.data ? (
          <p className="text-fg-dim">{i18n.t('Loading event evidence…')}</p>
        ) : (
          <p className="text-fg-dim">
            {i18n.plural(
              '{count} related event observed',
              '{count} related events observed',
              diagnosis.events.length,
            )}
          </p>
        )}
        {metrics.error ? (
          <p className="text-status-starting">
            {i18n.t('Metrics')}: {evidenceErrorLabel(evidenceError(metrics.error))}
          </p>
        ) : metric ? (
          <p className="text-fg-muted">
            {i18n.t('Latest Pod sample: {cpu} CPU, {memory} memory.', {
              cpu: formatCpu(metric.cpu_millicores),
              memory: formatBytes(metric.memory_bytes),
            })}
          </p>
        ) : (
          <p className="text-fg-dim">
            {i18n.t(
              'No current Pod metrics are available. No historical memory usage is inferred.',
            )}
          </p>
        )}
      </div>

      {diagnosis.findings.length ? (
        diagnosis.findings.map((finding) => (
          <article
            key={finding.id}
            className="border-border/60 border-l-status-starting rounded-md border border-l-2 p-3"
          >
            {finding.container && (
              <p className="text-accent mb-1 font-mono text-[11px]">{finding.container}</p>
            )}
            <h4 className="text-fg text-[12px] font-semibold">{findingTitle(finding.code)}</h4>
            <dl className="mt-2 space-y-2">
              {finding.evidence.map((evidence, index) => (
                <div key={index} className="text-[11px]">
                  <dt className="text-fg-dim">
                    {evidenceLabel(evidence.kind)}
                    {evidence.time && ` · ${evidence.time}`}
                  </dt>
                  <dd className="text-fg-muted mt-0.5 break-words whitespace-pre-wrap">
                    {evidence.value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-fg mt-3 text-[11px] font-semibold tracking-wide uppercase">
              {i18n.t('Next check')}
            </p>
            <p className="text-fg-muted mt-1 text-[11.5px] leading-relaxed">
              {nextCheck(finding.code)}
            </p>
          </article>
        ))
      ) : (
        <p className="text-fg-muted text-[12px] leading-relaxed">
          {i18n.t(
            'No supported failure pattern was found in the observed Pod state. This does not confirm that the workload is healthy; review Events and Logs when symptoms remain.',
          )}
        </p>
      )}

      <section className="border-border/60 rounded-md border p-3">
        <h4 className="text-fg mb-2 text-[11px] font-semibold tracking-wide uppercase">
          {i18n.t('Container evidence')}
        </h4>
        {diagnosis.containers.map((item) => (
          <div
            key={`${item.init}/${item.name}`}
            className="border-border/40 border-b py-2 text-[11.5px] last:border-b-0"
          >
            <p className="text-fg font-mono">
              {item.name}
              {item.init ? ` · ${i18n.t('init')}` : ''}
            </p>
            <p className="text-fg-muted mt-1 break-words">
              {[item.state, item.reason].filter(Boolean).join(' · ')}
            </p>
            <p className="text-fg-dim mt-1">
              {i18n.t('Restarts: {count}', { count: item.restarts })}
            </p>
            {item.lastTermination && (
              <p className="text-fg-dim mt-1">
                {i18n.t('Previous termination: {reason}, exit {code}', {
                  reason: item.lastTermination.reason,
                  code: item.lastTermination.exitCode ?? '?',
                })}
              </p>
            )}
          </div>
        ))}
        {!diagnosis.containers.length && (
          <p className="text-fg-dim text-[11.5px]">
            {i18n.t('No container status or specification is available.')}
          </p>
        )}
      </section>

      <section className="border-border/60 space-y-2 rounded-md border p-3">
        <h4 className="text-fg text-[11px] font-semibold tracking-wide uppercase">
          {i18n.t('Previous container logs')}
        </h4>
        <p className="text-fg-dim text-[11px] leading-relaxed">
          {i18n.t(
            'Read on demand: up to 200 lines and 64 KiB, with a 10-second timeout. Logs may contain sensitive application data.',
          )}
        </p>
        <Select
          value={container?.name ?? ''}
          onChange={selectContainer}
          ariaLabel={i18n.t('Container')}
          options={diagnosis.containers.map((item) => ({ value: item.name, label: item.name }))}
          className="w-full"
        />
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            variant="secondary"
            disabled={
              !container ||
              !(container.lastTermination || container.restarts > 0) ||
              logs?.status === 'reading' ||
              !isActive
            }
            onClick={read}
            leftIcon={
              logs?.status === 'reading' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ScrollText className="h-3 w-3" />
              )
            }
          >
            {i18n.t('Read previous logs')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!container || !isActive}
            onClick={() =>
              dock.logs(
                clusterId,
                namespace,
                obj.metadata.name,
                diagnosis.containers.map((item) => item.name),
                container?.name ?? null,
              )
            }
          >
            {i18n.t('Open current logs')}
          </Button>
        </div>
        {container && !container.lastTermination && container.restarts === 0 && (
          <p className="text-fg-dim text-[11px]">
            {i18n.t('No previous container instance is recorded in the observed status.')}
          </p>
        )}
        {logs?.error && (
          <p role="status" className="text-status-starting text-[11.5px]">
            {evidenceErrorLabel(logs.error)}
          </p>
        )}
        {logs?.status === 'limited' && (
          <p className="text-status-starting text-[11px]">
            {i18n.t('The log preview reached its size limit and was stopped.')}
          </p>
        )}
        {logs?.text && <CodeBlock text={logs.text} maxHeight="max-h-64" />}
        {logs?.status === 'complete' && !logs.text && (
          <p className="text-fg-dim text-[11px]">
            {i18n.t('The previous log read completed without any lines.')}
          </p>
        )}
      </section>

      {diagnosis.references.length > 0 && (
        <section>
          <h4 className="text-fg text-[11px] font-semibold tracking-wide uppercase">
            {i18n.t('Referenced resources')}
          </h4>
          <p className="text-fg-dim my-2 text-[11px]">
            {i18n.t(
              'References come from the Pod spec. Existence and access have not been checked; Secret values are not read.',
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {diagnosis.references.map((ref) => (
              <Button
                key={`${ref.kind}/${ref.name}`}
                size="xs"
                variant="secondary"
                onClick={() => ctx.navigate(ref)}
                rightIcon={<ArrowUpRight className="h-3 w-3" />}
              >
                {ref.kind}/{ref.name}
              </Button>
            ))}
          </div>
        </section>
      )}
      {diagnosis.events.length > 0 && (
        <section>
          <h4 className="text-fg text-[11px] font-semibold tracking-wide uppercase">
            {i18n.t('Recent event evidence')}
          </h4>
          {diagnosis.events.slice(0, 5).map((event) => (
            <p
              key={event.metadata.uid}
              className="text-fg-muted mt-2 text-[11.5px] leading-relaxed break-words"
            >
              {asString(event.reason)}: {asString(event.message ?? event.note)}
            </p>
          ))}
          <Button className="mt-2" size="xs" variant="ghost" onClick={onEvents}>
            {i18n.t('Open Events for timestamps and full history')}
          </Button>
        </section>
      )}
    </section>
  );
}
