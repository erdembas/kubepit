import * as i18n from '@/i18n';
import { asNumber, asObject, asString, spec, status } from '@/lib/kube/accessors';
import { RefLink } from '@/lib/kube/columns/cells';
import { hpaMetrics } from '@/lib/kube/columns/config';
import { selectorText } from '@/lib/kube/selectors';
import { formatAge } from '@/lib/format';
import { ChipList, Row, Rows, Section, ToneText } from '../primitives';
import { ConditionsTable } from './PodSections';
import type { SectionProps } from './types';

export function HpaSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const st = status(obj);
  const target = asObject(s.scaleTargetRef);
  return (
    <>
      <Section title={i18n.t('Autoscaler')}>
        <Rows>
          <Row label={i18n.t('Target')}>
            <span className="flex items-baseline gap-1.5">
              <span className="text-fg-dim text-[11px]">{asString(target.kind)}</span>
              <RefLink
                target={{
                  apiVersion: asString(target.apiVersion),
                  kind: asString(target.kind),
                  name: asString(target.name),
                  namespace: obj.metadata.namespace ?? null,
                }}
                ctx={ctx}
              />
            </span>
          </Row>
          <Row label={i18n.t('Replicas')}>
            {i18n.t('{current} current · {desired} desired · {min}–{max} allowed', {
              current: asNumber(st.currentReplicas),
              desired: asNumber(st.desiredReplicas),
              min: asNumber(s.minReplicas, 1),
              max: asNumber(s.maxReplicas),
            })}
          </Row>
          <Row label={i18n.t('Metrics')}>
            <ChipList entries={hpaMetrics(obj)} />
          </Row>
          <Row label={i18n.t('Last scaled')}>
            {asString(st.lastScaleTime) &&
              i18n.t('{age} ago', { age: formatAge(asString(st.lastScaleTime), ctx.now) })}
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Conditions')}>
        <ConditionsTable obj={obj} now={ctx.now} />
      </Section>
    </>
  );
}

export function PdbSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const st = status(obj);
  const allowed = asNumber(st.disruptionsAllowed);
  return (
    <>
      <Section title={i18n.t('Disruption budget')}>
        <Rows>
          <Row label={i18n.t('Selector')}>
            <ChipList entries={selectorText(s.selector)} />
          </Row>
          <Row label={i18n.t('Min available')}>{asString(s.minAvailable)}</Row>
          <Row label={i18n.t('Max unavailable')}>{asString(s.maxUnavailable)}</Row>
          <Row label={i18n.t('Healthy')}>
            {i18n.t('{current} current · {desired} desired · {expected} expected', {
              current: asNumber(st.currentHealthy),
              desired: asNumber(st.desiredHealthy),
              expected: asNumber(st.expectedPods),
            })}
          </Row>
          <Row label={i18n.t('Allowed disruptions')}>
            <ToneText tone={allowed > 0 ? 'success' : 'warning'}>{allowed}</ToneText>
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Conditions')}>
        <ConditionsTable obj={obj} now={ctx.now} />
      </Section>
    </>
  );
}
