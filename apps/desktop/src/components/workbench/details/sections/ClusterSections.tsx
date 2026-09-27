import * as i18n from '@/i18n';
import { asNumber, asObject, asString, field, lastTimestamp, status } from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { RefLink } from '@/lib/kube/columns/cells';
import { cpuMillicores, memoryBytes } from '@/lib/kube/quantity';
import { phaseTone } from '@/lib/kube/workloads';
import { formatAge } from '@/lib/format';
import { usageBarClass } from '@/lib/resourceTone';
import { useWatch } from '../../data/watchCache';
import { NamespaceMetricsHistory } from '../MetricsHistoryCard';
import { Bar, MonoText, Row, Rows, Section, ToneText } from '../primitives';
import type { SectionProps } from './types';

const QUOTA_GVK = toGvk(BUILTIN.ResourceQuota);

function quotaNumber(key: string, value: unknown) {
  return /cpu/.test(key)
    ? cpuMillicores(value)
    : /memory|storage/.test(key)
      ? memoryBytes(value)
      : asNumber(value);
}

export function NamespaceSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const phase = obj.metadata.deletionTimestamp
    ? 'Terminating'
    : asString(status(obj).phase) || 'Active';
  const quotas = useWatch(ctx.clusterId, QUOTA_GVK, [obj.metadata.name], isActive);
  return (
    <>
      <Section title={i18n.t('Namespace')}>
        <Rows>
          <Row label={i18n.t('Status')}>
            <ToneText tone={phaseTone(phase)}>{phase}</ToneText>
          </Row>
        </Rows>
      </Section>
      <NamespaceMetricsHistory obj={obj} ctx={ctx} isActive={isActive} />
      <Section title={i18n.t('Resource quotas')}>
        {!quotas.items.length ? (
          <p className="text-fg-dim text-[12px]">
            {quotas.synced ? i18n.t('No resource quotas') : i18n.t('Loading…')}
          </p>
        ) : (
          <div className="space-y-4">
            {quotas.items.map((q) => {
              const hard = asObject(status(q).hard);
              const used = asObject(status(q).used);
              return (
                <div key={q.metadata.uid}>
                  <RefLink
                    target={{
                      apiVersion: 'v1',
                      kind: 'ResourceQuota',
                      name: q.metadata.name,
                      namespace: q.metadata.namespace ?? null,
                    }}
                    ctx={ctx}
                  />
                  <div className="mt-2 space-y-2">
                    {Object.keys(hard).map((k) => {
                      const u = quotaNumber(k, used[k]);
                      const h = quotaNumber(k, hard[k]);
                      const pct = h ? (u / h) * 100 : 0;
                      return (
                        <div key={k}>
                          <div className="mb-1 flex justify-between text-[11.5px]">
                            <span className="text-fg-muted font-mono">{k}</span>
                            <span className="text-fg tabular-nums">
                              {asString(used[k]) || '0'} / {asString(hard[k])}
                            </span>
                          </div>
                          <Bar used={u} total={h} tone={usageBarClass(pct)} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}

export function EventSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const io = asObject(field(obj, 'involvedObject'));
  const src = asObject(field(obj, 'source'));
  const warning = asString(field(obj, 'type')) === 'Warning';
  return (
    <Section title={i18n.t('Event')}>
      <Rows>
        <Row label={i18n.t('Type')}>
          <ToneText tone={warning ? 'warning' : 'muted'}>{asString(field(obj, 'type'))}</ToneText>
        </Row>
        <Row label={i18n.t('Reason')}>{asString(field(obj, 'reason'))}</Row>
        <Row label={i18n.t('Message')}>
          <span className="leading-relaxed">{asString(field(obj, 'message'))}</span>
        </Row>
        <Row label={i18n.t('Involved object')}>
          {asString(io.name) && (
            <span className="flex items-baseline gap-1.5">
              <span className="text-fg-dim text-[11px]">{asString(io.kind)}</span>
              <RefLink
                target={{
                  apiVersion: asString(io.apiVersion) || undefined,
                  kind: asString(io.kind),
                  name: asString(io.name),
                  namespace: asString(io.namespace) || null,
                }}
                ctx={ctx}
              />
            </span>
          )}
        </Row>
        <Row label={i18n.t('Field path')}>
          {asString(io.fieldPath) && <MonoText>{asString(io.fieldPath)}</MonoText>}
        </Row>
        <Row label={i18n.t('Source')}>
          {[
            asString(src.component) || asString(field(obj, 'reportingComponent')),
            asString(src.host),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Row>
        <Row label={i18n.t('Count')}>{asNumber(field(obj, 'count'), 1)}</Row>
        <Row label={i18n.t('First seen')}>
          {asString(field(obj, 'firstTimestamp')) &&
            i18n.t('{age} ago', {
              age: formatAge(asString(field(obj, 'firstTimestamp')), ctx.now),
            })}
        </Row>
        <Row label={i18n.t('Last seen')}>
          {lastTimestamp(obj) &&
            i18n.t('{age} ago', { age: formatAge(lastTimestamp(obj), ctx.now) })}
        </Row>
      </Rows>
    </Section>
  );
}
