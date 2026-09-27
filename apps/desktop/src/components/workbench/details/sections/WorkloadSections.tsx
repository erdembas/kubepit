import * as i18n from '@/i18n';
import { asArray, asObject, asString, isObject, spec } from '@/lib/kube/accessors';
import { parseSelector, matchesSelector, selectorText } from '@/lib/kube/selectors';
import { replicaCounts } from '@/lib/kube/workloads';
import { ChipList, MiniTable, MonoText, Row, Rows, Section } from '../primitives';
import { PodsMiniTable } from '../PodsMiniTable';
import { ConditionsTable } from './PodSections';
import type { SectionProps } from './types';

export function TemplateContainers({ template }: { template: unknown }) {
  i18n.useLocale();
  const podSpec = asObject(asObject(template).spec);
  const rows = [
    ...asArray(podSpec.initContainers)
      .filter(isObject)
      .map((c) => ({ c, init: true })),
    ...asArray(podSpec.containers)
      .filter(isObject)
      .map((c) => ({ c, init: false })),
  ];
  return (
    <MiniTable
      rows={rows}
      rowKey={(r) => `${r.init}:${asString(r.c.name)}`}
      columns={[
        {
          label: i18n.t('Container'),
          cell: (r) => (
            <span className="text-fg">
              {asString(r.c.name)}
              {r.init && <span className="text-fg-dim ml-1.5 text-[10px]">{i18n.t('init')}</span>}
            </span>
          ),
        },
        { label: i18n.t('Image'), cell: (r) => <MonoText>{asString(r.c.image)}</MonoText> },
        {
          label: i18n.t('Ports'),
          cell: (r) =>
            asArray(r.c.ports)
              .filter(isObject)
              .map((p) => asString(p.containerPort))
              .join(', ') || '—',
        },
      ]}
    />
  );
}

export function WorkloadSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const c = replicaCounts(obj);
  const selector = parseSelector(s.selector);
  const strategy = asObject(s.strategy ?? s.updateStrategy);
  const rolling = asObject(strategy.rollingUpdate);
  const isDs = obj.kind === 'DaemonSet';
  return (
    <>
      <Section title={obj.kind}>
        <Rows>
          <Row label={i18n.t('Selector')}>
            <ChipList entries={selectorText(s.selector)} />
          </Row>
          <Row label={isDs ? i18n.t('Scheduled') : i18n.t('Replicas')}>
            <span className="tabular-nums">
              {[
                i18n.t('{count} desired', { count: c.desired }),
                i18n.t('{count} current', { count: c.current }),
                i18n.t('{count} ready', { count: c.ready }),
                obj.kind !== 'ReplicaSet' && obj.kind !== 'ReplicationController'
                  ? i18n.t('{count} updated', { count: c.updated })
                  : null,
                i18n.t('{count} available', { count: c.available }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </Row>
          <Row label={i18n.t('Strategy')}>
            {asString(strategy.type) && (
              <span>
                {asString(strategy.type)}
                {(rolling.maxSurge !== undefined ||
                  rolling.maxUnavailable !== undefined ||
                  rolling.partition !== undefined) && (
                  <span className="text-fg-dim ml-1.5 text-[11px]">
                    {[
                      rolling.maxSurge !== undefined && `maxSurge ${asString(rolling.maxSurge)}`,
                      rolling.maxUnavailable !== undefined &&
                        `maxUnavailable ${asString(rolling.maxUnavailable)}`,
                      rolling.partition !== undefined && `partition ${asString(rolling.partition)}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </span>
            )}
          </Row>
          <Row label={i18n.t('Revision')}>
            {obj.metadata.annotations?.['deployment.kubernetes.io/revision']}
          </Row>
          <Row label={i18n.t('Service')}>{asString(s.serviceName)}</Row>
          <Row label={i18n.t('Pod management')}>{asString(s.podManagementPolicy)}</Row>
          <Row label={i18n.t('Paused')}>{s.paused === true ? i18n.t('Yes') : null}</Row>
          <Row label={i18n.t('Node selector')}>
            {Object.keys(asObject(asObject(asObject(s.template).spec).nodeSelector)).length > 0 && (
              <ChipList
                entries={Object.entries(
                  asObject(asObject(asObject(s.template).spec).nodeSelector),
                ).map(([k, v]) => [k, asString(v)] as [string, string])}
              />
            )}
          </Row>
        </Rows>
      </Section>
      {!isDs && obj.kind !== 'ReplicaSet' && (
        <Section title={i18n.t('Conditions')}>
          <ConditionsTable obj={obj} now={ctx.now} />
        </Section>
      )}
      <Section title={i18n.t('Pod template')}>
        <TemplateContainers template={s.template} />
      </Section>
      <Section title={i18n.t('Pods')}>
        <PodsMiniTable
          ctx={ctx}
          namespace={obj.metadata.namespace ?? null}
          isActive={isActive}
          match={(p) => matchesSelector(selector, p.metadata.labels)}
        />
      </Section>
    </>
  );
}
