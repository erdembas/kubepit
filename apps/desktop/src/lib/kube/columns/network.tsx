import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asArray, asObject, asString, field, isObject, spec, status } from '../accessors';
import { selectorText } from '../selectors';
import { Chips, Dash, Mono, Muted, RefLink, standard, Tone } from './cells';
import type { KindColumns } from './types';

export function servicePorts(o: KubeObject): string[] {
  return asArray(spec(o).ports)
    .filter(isObject)
    .map((p) => {
      const port = asString(p.port);
      const node = asString(p.nodePort);
      const proto = asString(p.protocol) || 'TCP';
      return `${port}${node ? `:${node}` : ''}/${proto}`;
    });
}

export function externalIps(o: KubeObject): string[] {
  const lb = asArray(asObject(status(o).loadBalancer).ingress)
    .filter(isObject)
    .map((i) => asString(i.hostname) || asString(i.ip));
  const ext = asArray(spec(o).externalIPs).map((x) => asString(x));
  if (asString(spec(o).type) === 'ExternalName') return [asString(spec(o).externalName)];
  return [...lb, ...ext].filter(Boolean);
}

export function serviceStatus(o: KubeObject): {
  label: string;
  tone: 'success' | 'warning' | 'muted';
} {
  if (asString(spec(o).type) === 'LoadBalancer')
    return externalIps(o).length
      ? { label: 'Active', tone: 'success' }
      : { label: 'Pending', tone: 'warning' };
  return { label: 'Active', tone: 'success' };
}

export const serviceColumns: KindColumns = {
  searchText: (o) =>
    `${asString(spec(o).type)} ${asString(spec(o).clusterIP)} ${externalIps(o).join(' ')}`,
  columns: standard(true, [
    {
      id: 'type',
      label: () => i18n.t('Type'),
      width: '104px',
      cell: (o) => <Muted>{asString(spec(o).type) || 'ClusterIP'}</Muted>,
      sort: (o) => asString(spec(o).type),
    },
    {
      id: 'clusterIp',
      label: () => i18n.t('Cluster IP'),
      width: 'minmax(104px, 1fr)',
      cell: (o) => <Mono>{asString(spec(o).clusterIP) || '—'}</Mono>,
      sort: (o) => asString(spec(o).clusterIP),
    },
    {
      id: 'ports',
      label: () => i18n.t('Ports'),
      width: 'minmax(120px, 1.4fr)',
      cell: (o) => <Chips values={servicePorts(o)} max={3} />,
    },
    {
      id: 'externalIp',
      label: () => i18n.t('External IP'),
      width: 'minmax(120px, 1.4fr)',
      cell: (o) => {
        const ips = externalIps(o);
        return ips.length ? <Mono title={ips.join('\n')}>{ips.join(', ')}</Mono> : <Dash />;
      },
    },
    {
      id: 'selector',
      label: () => i18n.t('Selector'),
      width: 'minmax(140px, 1.4fr)',
      cell: (o) => <Chips values={selectorText(spec(o).selector)} />,
    },
    {
      id: 'status',
      label: () => i18n.t('Status'),
      width: '76px',
      cell: (o) => {
        const s = serviceStatus(o);
        return <Tone tone={s.tone}>{s.label}</Tone>;
      },
    },
  ]),
};

function endpointAddresses(o: KubeObject): string[] {
  const out: string[] = [];
  for (const subset of asArray(field(o, 'subsets')).filter(isObject)) {
    const ports = asArray(subset.ports)
      .filter(isObject)
      .map((p) => asString(p.port));
    for (const a of asArray(subset.addresses).filter(isObject)) {
      const ip = asString(a.ip);
      out.push(...(ports.length ? ports.map((p) => `${ip}:${p}`) : [ip]));
    }
  }
  return out;
}

export const endpointsColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'endpoints',
      label: () => i18n.t('Endpoints'),
      width: 'minmax(220px, 3fr)',
      cell: (o) => <Chips values={endpointAddresses(o)} max={3} />,
      sort: (o) => endpointAddresses(o).length,
    },
  ]),
};

export const endpointSliceColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'addressType',
      label: () => i18n.t('Address Type'),
      width: '104px',
      cell: (o) => <Muted>{asString(field(o, 'addressType'))}</Muted>,
    },
    {
      id: 'ports',
      label: () => i18n.t('Ports'),
      width: 'minmax(100px, 1fr)',
      cell: (o) => (
        <Chips
          values={asArray(field(o, 'ports'))
            .filter(isObject)
            .map((p) => `${asString(p.port)}/${asString(p.protocol) || 'TCP'}`)}
        />
      ),
    },
    {
      id: 'endpoints',
      label: () => i18n.t('Endpoints'),
      width: 'minmax(200px, 2fr)',
      cell: (o) => (
        <Chips
          values={asArray(field(o, 'endpoints'))
            .filter(isObject)
            .flatMap((e) => asArray(e.addresses).map((a) => asString(a)))}
          max={3}
        />
      ),
    },
  ]),
};

export function ingressRules(
  o: KubeObject,
): Array<{ host: string; path: string; service: string; port: string }> {
  const out: Array<{ host: string; path: string; service: string; port: string }> = [];
  for (const rule of asArray(spec(o).rules).filter(isObject)) {
    const host = asString(rule.host) || '*';
    for (const p of asArray(asObject(rule.http).paths).filter(isObject)) {
      const svc = asObject(asObject(p.backend).service);
      const port = asObject(svc.port);
      out.push({
        host,
        path: asString(p.path) || '/',
        service: asString(svc.name),
        port: asString(port.number) || asString(port.name),
      });
    }
  }
  return out;
}

export function ingressLoadBalancers(o: KubeObject): string[] {
  return asArray(asObject(status(o).loadBalancer).ingress)
    .filter(isObject)
    .map((i) => asString(i.hostname) || asString(i.ip))
    .filter(Boolean);
}

export const ingressColumns: KindColumns = {
  searchText: (o) =>
    ingressRules(o)
      .map((r) => `${r.host} ${r.path} ${r.service}`)
      .join(' '),
  columns: standard(true, [
    {
      id: 'loadBalancers',
      label: () => i18n.t('Load Balancers'),
      width: 'minmax(140px, 1.5fr)',
      cell: (o) => {
        const lb = ingressLoadBalancers(o);
        return lb.length ? <Mono title={lb.join('\n')}>{lb.join(', ')}</Mono> : <Dash />;
      },
    },
    {
      id: 'rules',
      label: () => i18n.t('Rules'),
      width: 'minmax(220px, 3fr)',
      cell: (o, ctx) => {
        const rules = ingressRules(o);
        if (!rules.length) return <Dash />;
        const first = rules[0]!;
        return (
          <span
            className="flex min-w-0 items-center gap-1 truncate"
            title={rules.map((r) => `${r.host}${r.path} → ${r.service}:${r.port}`).join('\n')}
          >
            <span className="text-fg-muted truncate">{`${first.host}${first.path}`}</span>
            <span className="text-fg-dim">→</span>
            <RefLink
              target={{
                apiVersion: 'v1',
                kind: 'Service',
                name: first.service,
                namespace: o.metadata.namespace ?? null,
              }}
              ctx={ctx}
              label={`${first.service}:${first.port}`}
            />
            {rules.length > 1 && (
              <span className="text-fg-dim shrink-0 text-[10.5px]">+{rules.length - 1}</span>
            )}
          </span>
        );
      },
    },
  ]),
};

export const ingressClassColumns: KindColumns = {
  columns: standard(false, [
    {
      id: 'controller',
      label: () => i18n.t('Controller'),
      width: 'minmax(160px, 2fr)',
      cell: (o) => <Mono>{asString(spec(o).controller)}</Mono>,
      sort: (o) => asString(spec(o).controller),
    },
    {
      id: 'default',
      label: () => i18n.t('Default'),
      width: '76px',
      cell: (o) =>
        o.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true' ? (
          <Tone tone="success">{i18n.t('Yes')}</Tone>
        ) : (
          <Dash />
        ),
    },
  ]),
};

export const networkPolicyColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'podSelector',
      label: () => i18n.t('Pod Selector'),
      width: 'minmax(160px, 2fr)',
      cell: (o) => {
        const sel = selectorText(spec(o).podSelector);
        return sel.length ? <Chips values={sel} /> : <Muted>{i18n.t('All pods')}</Muted>;
      },
    },
    {
      id: 'types',
      label: () => i18n.t('Policy Types'),
      width: 'minmax(110px, 1fr)',
      cell: (o) => (
        <Muted>
          {asArray(spec(o).policyTypes)
            .map((x) => asString(x))
            .join(', ') || '—'}
        </Muted>
      ),
    },
  ]),
};
