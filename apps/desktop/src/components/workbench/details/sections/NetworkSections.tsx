import * as i18n from '@/i18n';
import { ArrowRightLeft, ExternalLink } from 'lucide-react';
import { asArray, asObject, asString, field, isObject, spec } from '@/lib/kube/accessors';
import { BUILTIN, toGvk } from '@/lib/kube/catalog';
import { RefLink } from '@/lib/kube/columns/cells';
import { externalIps, ingressLoadBalancers, ingressRules } from '@/lib/kube/columns/network';
import { matchesSelector, parseSelector, selectorText } from '@/lib/kube/selectors';
import type { ColumnContext } from '@/lib/kube/columns';
import type { KubeObject } from '@/types';
import { useActionDialogs } from '../../actions/dialogStore';
import { openExternal } from '../../actions/openExternal';
import { servicePortOptions } from '../../actions/resourceActions';
import { useWatch } from '../../data/watchCache';
import { ChipList, MiniTable, MonoText, Row, Rows, Section } from '../primitives';
import { PodsMiniTable } from '../PodsMiniTable';
import type { SectionProps } from './types';

const EP_GVK = toGvk(BUILTIN.Endpoints);

function subsetRows(ep: KubeObject) {
  const rows: Array<{ ip: string; ready: boolean; target: string; node: string; ports: string }> =
    [];
  for (const subset of asArray(field(ep, 'subsets')).filter(isObject)) {
    const ports = asArray(subset.ports)
      .filter(isObject)
      .map((p) => `${asString(p.port)}/${asString(p.protocol) || 'TCP'}`)
      .join(', ');
    for (const [key, ready] of [
      ['addresses', true],
      ['notReadyAddresses', false],
    ] as const)
      for (const a of asArray(subset[key]).filter(isObject))
        rows.push({
          ip: asString(a.ip),
          ready,
          target: asString(asObject(a.targetRef).name),
          node: asString(a.nodeName),
          ports,
        });
  }
  return rows;
}

function EndpointTable({ ep, ctx }: { ep: KubeObject; ctx: ColumnContext }) {
  i18n.useLocale();
  return (
    <MiniTable
      rows={subsetRows(ep)}
      rowKey={(r) => `${r.ip}-${r.ports}`}
      empty={i18n.t('No endpoints')}
      columns={[
        { label: i18n.t('Address'), cell: (r) => <MonoText>{r.ip}</MonoText> },
        { label: i18n.t('Ports'), cell: (r) => r.ports },
        {
          label: i18n.t('Pod'),
          cell: (r) =>
            r.target ? (
              <RefLink
                target={{
                  apiVersion: 'v1',
                  kind: 'Pod',
                  name: r.target,
                  namespace: ep.metadata.namespace ?? null,
                }}
                ctx={ctx}
              />
            ) : (
              '—'
            ),
        },
        {
          label: i18n.t('Ready'),
          cell: (r) =>
            r.ready ? (
              <span className="text-status-running">{i18n.t('Yes')}</span>
            ) : (
              <span className="text-status-starting">{i18n.t('No')}</span>
            ),
        },
      ]}
    />
  );
}

export function ServiceSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const ns = obj.metadata.namespace ?? 'default';
  const ports = asArray(s.ports).filter(isObject);
  const options = servicePortOptions(obj);
  const eps = useWatch(ctx.clusterId, EP_GVK, [ns], isActive);
  const ep = eps.items.find((e) => e.metadata.name === obj.metadata.name);
  const selector = parseSelector(s.selector);
  return (
    <>
      <Section title={i18n.t('Service')}>
        <Rows>
          <Row label={i18n.t('Type')}>{asString(s.type) || 'ClusterIP'}</Row>
          <Row label={i18n.t('Cluster IP')}>
            {asString(s.clusterIP) && (
              <MonoText>
                {asArray(s.clusterIPs)
                  .map((x) => asString(x))
                  .join(', ') || asString(s.clusterIP)}
              </MonoText>
            )}
          </Row>
          <Row label={i18n.t('External')}>
            {externalIps(obj).length > 0 && <MonoText>{externalIps(obj).join(', ')}</MonoText>}
          </Row>
          <Row label={i18n.t('Session affinity')}>{asString(s.sessionAffinity)}</Row>
          <Row label={i18n.t('Traffic policy')}>
            {asString(s.externalTrafficPolicy) || asString(s.internalTrafficPolicy)}
          </Row>
          <Row label={i18n.t('IP families')}>
            {asArray(s.ipFamilies)
              .map((x) => asString(x))
              .join(', ')}
          </Row>
          <Row label={i18n.t('Selector')}>
            {selectorText(s.selector).length > 0 && <ChipList entries={selectorText(s.selector)} />}
          </Row>
        </Rows>
      </Section>
      {ports.length > 0 && (
        <Section title={i18n.t('Ports')}>
          <MiniTable
            rows={ports}
            rowKey={(p) => `${asString(p.port)}-${asString(p.protocol)}`}
            columns={[
              { label: i18n.t('Name'), cell: (p) => asString(p.name) || '—' },
              {
                label: i18n.t('Port'),
                className: 'font-mono',
                cell: (p) => `${asString(p.port)}/${asString(p.protocol) || 'TCP'}`,
              },
              {
                label: i18n.t('Target'),
                className: 'font-mono',
                cell: (p) => asString(p.targetPort) || asString(p.port),
              },
              {
                label: i18n.t('Node port'),
                className: 'font-mono',
                cell: (p) => asString(p.nodePort) || '—',
              },
              {
                label: '',
                className: 'text-right',
                cell: (p) =>
                  asString(s.type) !== 'ExternalName' &&
                  (asString(p.protocol) || 'TCP') === 'TCP' ? (
                    <button
                      type="button"
                      onClick={() =>
                        useActionDialogs.getState().open({
                          kind: 'port-forward',
                          clusterId: ctx.clusterId,
                          target: 'service',
                          namespace: ns,
                          name: obj.metadata.name,
                          ports: options,
                          port: Number(p.port),
                        })
                      }
                      className="text-fg-dim hover:text-accent inline-flex items-center gap-1 text-[11px]"
                    >
                      <ArrowRightLeft className="h-3 w-3" />
                      {i18n.t('Forward')}
                    </button>
                  ) : null,
              },
            ]}
          />
        </Section>
      )}
      {selector && (
        <>
          <Section title={i18n.t('Endpoints')}>
            {ep ? (
              <EndpointTable ep={ep} ctx={ctx} />
            ) : (
              <p className="text-fg-dim text-[12px]">{i18n.t('No endpoints')}</p>
            )}
          </Section>
          <Section title={i18n.t('Pods')}>
            <PodsMiniTable
              ctx={ctx}
              namespace={ns}
              isActive={isActive}
              match={(p) => matchesSelector(selector, p.metadata.labels)}
            />
          </Section>
        </>
      )}
    </>
  );
}

export function EndpointsSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  return (
    <Section title={i18n.t('Addresses')}>
      <EndpointTable ep={obj} ctx={ctx} />
    </Section>
  );
}

export function IngressSections({ obj, ctx }: SectionProps) {
  i18n.useLocale();
  const s = spec(obj);
  const ns = obj.metadata.namespace ?? null;
  const tls = asArray(s.tls).filter(isObject);
  const tlsHosts = new Set(tls.flatMap((t) => asArray(t.hosts).map((h) => asString(h))));
  const lbs = ingressLoadBalancers(obj);
  return (
    <>
      <Section title={i18n.t('Ingress')}>
        <Rows>
          <Row label={i18n.t('Class')}>
            {asString(s.ingressClassName) && (
              <RefLink
                target={{
                  apiVersion: 'networking.k8s.io/v1',
                  kind: 'IngressClass',
                  name: asString(s.ingressClassName),
                }}
                ctx={ctx}
              />
            )}
          </Row>
          <Row label={i18n.t('Load balancers')}>
            {lbs.length > 0 && <MonoText>{lbs.join(', ')}</MonoText>}
          </Row>
          <Row label="TLS">
            {tls.length > 0 && (
              <span className="flex flex-col gap-0.5">
                {tls.map((t) => (
                  <span
                    key={asString(t.secretName)}
                    className="flex flex-wrap items-baseline gap-1.5"
                  >
                    <span className="text-fg-muted">
                      {asArray(t.hosts)
                        .map((h) => asString(h))
                        .join(', ')}
                    </span>
                    <span className="text-fg-dim">→</span>
                    <RefLink
                      target={{
                        apiVersion: 'v1',
                        kind: 'Secret',
                        name: asString(t.secretName),
                        namespace: ns,
                      }}
                      ctx={ctx}
                    />
                  </span>
                ))}
              </span>
            )}
          </Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Rules')}>
        <MiniTable
          rows={ingressRules(obj)}
          rowKey={(r, i) => `${r.host}${r.path}${i}`}
          columns={[
            {
              label: i18n.t('Host'),
              cell: (r) =>
                r.host === '*' ? (
                  '*'
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      void openExternal(
                        `${tlsHosts.has(r.host) ? 'https' : 'http'}://${r.host}${r.path}`,
                      )
                    }
                    className="text-accent inline-flex items-center gap-1 hover:underline"
                  >
                    {r.host}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </button>
                ),
            },
            { label: i18n.t('Path'), className: 'font-mono', cell: (r) => r.path },
            {
              label: i18n.t('Backend'),
              cell: (r) =>
                r.service ? (
                  <RefLink
                    target={{ apiVersion: 'v1', kind: 'Service', name: r.service, namespace: ns }}
                    ctx={ctx}
                    label={`${r.service}:${r.port}`}
                  />
                ) : (
                  '—'
                ),
            },
          ]}
        />
      </Section>
    </>
  );
}
