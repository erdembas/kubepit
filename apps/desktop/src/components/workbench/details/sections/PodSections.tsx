import * as i18n from '@/i18n';
import {
  asArray,
  asObject,
  asString,
  conditions,
  isObject,
  spec,
  status,
} from '@/lib/kube/accessors';
import { RefLink } from '@/lib/kube/columns/cells';
import { podContainers, podStatus, podStatusTone } from '@/lib/kube/pods';
import { formatAge, formatBytes, formatCpu } from '@/lib/format';
import { ChipList, MiniTable, MonoText, Row, Rows, Section, ToneText } from '../primitives';
import { ContainerCard } from './ContainerCard';
import { EphemeralContainersSection } from './EphemeralContainers';
import type { SectionProps } from './types';

export function ConditionsTable({ obj, now }: { obj: SectionProps['obj']; now: number }) {
  i18n.useLocale();
  return (
    <MiniTable
      rows={conditions(obj)}
      rowKey={(c) => c.type}
      columns={[
        { label: i18n.t('Type'), cell: (c) => <span className="text-fg">{c.type}</span> },
        {
          label: i18n.t('Status'),
          cell: (c) => (
            <ToneText
              tone={c.status === 'True' ? 'success' : c.status === 'False' ? 'muted' : 'warning'}
            >
              {c.status}
            </ToneText>
          ),
        },
        { label: i18n.t('Reason'), cell: (c) => <span title={c.message}>{c.reason ?? '—'}</span> },
        {
          label: i18n.t('Updated'),
          cell: (c) => formatAge(c.lastTransitionTime ?? c.lastHeartbeatTime, now),
          className: 'text-right whitespace-nowrap',
        },
      ]}
    />
  );
}

export function PodSections({ obj, ctx, readOnly }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const st = status(obj);
  const value = podStatus(obj);
  const containers = podContainers(obj);
  const metric = ctx.podMetrics.byKey.get(`${obj.metadata.namespace}/${obj.metadata.name}`);
  const tolerations = asArray(s.tolerations).filter(isObject);
  const node = asString(s.nodeName);
  const volumes = asArray(s.volumes).filter(isObject);
  return (
    <>
      <Section title={i18n.t('Pod')}>
        <Rows>
          <Row label={i18n.t('Status')}>
            <ToneText tone={podStatusTone(value)}>{value}</ToneText>
            {asString(st.message) && (
              <p className="text-fg-dim mt-0.5 text-[11px]">{asString(st.message)}</p>
            )}
          </Row>
          <Row label={i18n.t('Node')}>
            {node ? (
              <RefLink target={{ apiVersion: 'v1', kind: 'Node', name: node }} ctx={ctx} />
            ) : (
              <span className="text-fg-dim">{i18n.t('Not scheduled')}</span>
            )}
          </Row>
          <Row label={i18n.t('Pod IP')}>
            {asString(st.podIP) && (
              <MonoText>
                {asArray(st.podIPs)
                  .map((p) => asString(asObject(p).ip))
                  .join(', ') || asString(st.podIP)}
              </MonoText>
            )}
          </Row>
          <Row label={i18n.t('Host IP')}>
            {asString(st.hostIP) && <MonoText>{asString(st.hostIP)}</MonoText>}
          </Row>
          <Row label={i18n.t('QoS class')}>{asString(st.qosClass)}</Row>
          <Row label={i18n.t('Service account')}>
            {asString(s.serviceAccountName) && (
              <RefLink
                target={{
                  apiVersion: 'v1',
                  kind: 'ServiceAccount',
                  name: asString(s.serviceAccountName),
                  namespace: obj.metadata.namespace ?? null,
                }}
                ctx={ctx}
              />
            )}
          </Row>
          <Row label={i18n.t('Priority class')}>{asString(s.priorityClassName)}</Row>
          <Row label={i18n.t('Restart policy')}>{asString(s.restartPolicy)}</Row>
          <Row label={i18n.t('Started')}>
            {asString(st.startTime) &&
              i18n.t('{age} ago', { age: formatAge(asString(st.startTime), ctx.now) })}
          </Row>
          {metric && (
            <Row label={i18n.t('Usage')}>
              <span className="tabular-nums">
                {formatCpu(metric.cpu_millicores)} CPU · {formatBytes(metric.memory_bytes)}
              </span>
            </Row>
          )}
          <Row label={i18n.t('Node selector')}>
            {Object.keys(asObject(s.nodeSelector)).length > 0 && (
              <ChipList
                entries={Object.entries(asObject(s.nodeSelector)).map(
                  ([k, v]) => [k, asString(v)] as [string, string],
                )}
              />
            )}
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Conditions')}>
        <ConditionsTable obj={obj} now={ctx.now} />
      </Section>
      <Section title={i18n.t('Containers')}>
        <div className="space-y-2.5">
          {containers.map((c) => (
            <ContainerCard
              key={`${c.init ? 'i' : 'c'}:${c.name}`}
              clusterId={ctx.clusterId}
              pod={obj}
              c={c}
              metric={metric?.containers.find((m) => m.name === c.name)}
              now={ctx.now}
            />
          ))}
        </div>
      </Section>
      <EphemeralContainersSection
        clusterId={ctx.clusterId}
        pod={obj}
        readOnly={readOnly}
        now={ctx.now}
      />
      {volumes.length > 0 && (
        <Section title={i18n.t('Volumes')}>
          <MiniTable
            rows={volumes}
            rowKey={(v) => asString(v.name)}
            columns={[
              {
                label: i18n.t('Name'),
                cell: (v) => <span className="text-fg">{asString(v.name)}</span>,
              },
              {
                label: i18n.t('Type'),
                cell: (v) => Object.keys(v).find((k) => k !== 'name') ?? '—',
              },
              {
                label: i18n.t('Source'),
                cell: (v) => {
                  if (isObject(v.persistentVolumeClaim))
                    return (
                      <RefLink
                        target={{
                          apiVersion: 'v1',
                          kind: 'PersistentVolumeClaim',
                          name: asString(v.persistentVolumeClaim.claimName),
                          namespace: obj.metadata.namespace ?? null,
                        }}
                        ctx={ctx}
                      />
                    );
                  if (isObject(v.configMap))
                    return (
                      <RefLink
                        target={{
                          apiVersion: 'v1',
                          kind: 'ConfigMap',
                          name: asString(v.configMap.name),
                          namespace: obj.metadata.namespace ?? null,
                        }}
                        ctx={ctx}
                      />
                    );
                  if (isObject(v.secret))
                    return (
                      <RefLink
                        target={{
                          apiVersion: 'v1',
                          kind: 'Secret',
                          name: asString(v.secret.secretName),
                          namespace: obj.metadata.namespace ?? null,
                        }}
                        ctx={ctx}
                      />
                    );
                  if (isObject(v.hostPath)) return <MonoText>{asString(v.hostPath.path)}</MonoText>;
                  return '—';
                },
              },
            ]}
          />
        </Section>
      )}
      {tolerations.length > 0 && (
        <Section title={i18n.t('Tolerations')}>
          <MiniTable
            rows={tolerations}
            rowKey={(t, i) => `${asString(t.key)}-${i}`}
            columns={[
              { label: i18n.t('Key'), cell: (t) => <MonoText>{asString(t.key) || '*'}</MonoText> },
              { label: i18n.t('Operator'), cell: (t) => asString(t.operator) || 'Equal' },
              { label: i18n.t('Value'), cell: (t) => asString(t.value) || '—' },
              { label: i18n.t('Effect'), cell: (t) => asString(t.effect) || i18n.t('All') },
              { label: i18n.t('Seconds'), cell: (t) => asString(t.tolerationSeconds) || '—' },
            ]}
          />
        </Section>
      )}
    </>
  );
}
