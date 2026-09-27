import * as i18n from '@/i18n';
import { asArray, asObject, asString, isObject, spec, status } from '@/lib/kube/accessors';
import { podNode } from '@/lib/kube/pods';
import {
  nodeConditions,
  nodeResources,
  nodeRoles,
  nodeTaints,
  taintText,
  toneText,
} from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';
import { formatBytes, formatCpu, formatPercent } from '@/lib/format';
import { usageBarClass } from '@/lib/resourceTone';
import { Bar, ChipList, MiniTable, MonoText, Row, Rows, Section } from '../primitives';
import { NodeMetricsHistory } from '../MetricsHistoryCard';
import { PodsMiniTable } from '../PodsMiniTable';
import { ConditionsTable } from './PodSections';
import type { SectionProps } from './types';

function UsageRow({
  label,
  used,
  total,
  format,
}: {
  label: string;
  used: number;
  total: number;
  format: (n: number) => string;
}) {
  const pct = total ? (used / total) * 100 : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11.5px]">
        <span className="text-fg-muted">{label}</span>
        <span className="text-fg tabular-nums">
          {format(used)} / {format(total)}{' '}
          <span className="text-fg-dim ml-1">{formatPercent(pct)}</span>
        </span>
      </div>
      <Bar used={used} total={total} tone={usageBarClass(pct)} />
    </div>
  );
}

export function NodeSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const st = status(obj);
  const info = asObject(st.nodeInfo);
  const cap = asObject(st.capacity);
  const alloc = asObject(st.allocatable);
  const a = nodeResources(obj, 'allocatable');
  const metric = ctx.nodeMetrics.byKey.get(obj.metadata.name);
  const taints = nodeTaints(obj);
  const chips = nodeConditions(obj);
  return (
    <>
      <Section title={i18n.t('Node')}>
        <Rows>
          <Row label={i18n.t('Status')}>
            <span className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <span
                  key={c.label}
                  className={cn('font-medium', toneText(c.tone))}
                  title={c.message}
                >
                  {c.label}
                </span>
              ))}
            </span>
          </Row>
          <Row label={i18n.t('Roles')}>{nodeRoles(obj).join(', ') || '<none>'}</Row>
          <Row label={i18n.t('Addresses')}>
            <span className="flex flex-col gap-0.5">
              {asArray(st.addresses)
                .filter(isObject)
                .map((ad) => (
                  <span key={`${asString(ad.type)}-${asString(ad.address)}`}>
                    <span className="text-fg-dim mr-1.5 text-[11px]">{asString(ad.type)}</span>
                    <MonoText>{asString(ad.address)}</MonoText>
                  </span>
                ))}
            </span>
          </Row>
          <Row label={i18n.t('Pod CIDR')}>
            {asString(spec(obj).podCIDR) && <MonoText>{asString(spec(obj).podCIDR)}</MonoText>}
          </Row>
          <Row label={i18n.t('Provider ID')}>
            {asString(spec(obj).providerID) && (
              <MonoText>{asString(spec(obj).providerID)}</MonoText>
            )}
          </Row>
          <Row label={i18n.t('Taints')}>
            {taints.length ? <ChipList entries={taints.map(taintText)} /> : null}
          </Row>
        </Rows>
      </Section>
      {metric && (
        <Section title={i18n.t('Usage')}>
          <div className="space-y-3">
            <UsageRow
              label={i18n.t('CPU')}
              used={metric.cpu_millicores}
              total={a.cpu}
              format={formatCpu}
            />
            <UsageRow
              label={i18n.t('Memory')}
              used={metric.memory_bytes}
              total={a.memory}
              format={formatBytes}
            />
          </div>
        </Section>
      )}
      <NodeMetricsHistory obj={obj} ctx={ctx} isActive={isActive} />
      <Section title={i18n.t('Capacity')}>
        <MiniTable
          rows={Object.keys(cap)}
          rowKey={(k) => k}
          columns={[
            { label: i18n.t('Resource'), cell: (k) => <span className="text-fg">{k}</span> },
            {
              label: i18n.t('Capacity'),
              className: 'text-right font-mono',
              cell: (k) => asString(cap[k]),
            },
            {
              label: i18n.t('Allocatable'),
              className: 'text-right font-mono',
              cell: (k) => asString(alloc[k]) || '—',
            },
          ]}
        />
      </Section>
      <Section title={i18n.t('System info')}>
        <Rows>
          <Row
            label={i18n.t('OS')}
          >{`${asString(info.osImage)} (${asString(info.operatingSystem)}/${asString(info.architecture)})`}</Row>
          <Row label={i18n.t('Kernel')}>
            <MonoText>{asString(info.kernelVersion)}</MonoText>
          </Row>
          <Row label={i18n.t('Container runtime')}>
            <MonoText>{asString(info.containerRuntimeVersion)}</MonoText>
          </Row>
          <Row label={i18n.t('Kubelet')}>
            <MonoText>{asString(info.kubeletVersion)}</MonoText>
          </Row>
          <Row label={i18n.t('Machine ID')}>
            <MonoText>{asString(info.machineID)}</MonoText>
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Conditions')}>
        <ConditionsTable obj={obj} now={ctx.now} />
      </Section>
      <Section title={i18n.t('Pods')}>
        <PodsMiniTable
          ctx={ctx}
          namespace={null}
          isActive={isActive}
          showNode={false}
          showNamespace
          match={(p) => podNode(p) === obj.metadata.name}
        />
      </Section>
    </>
  );
}
