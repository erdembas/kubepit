import * as i18n from '@/i18n/core';
import { formatAge } from '@/lib/format';
import type { KubeObject } from '@/types';
import { asArray, asNumber, asObject, asString, field, isObject, spec, status } from '../accessors';
import { Chips, Dash, Mono, Muted, standard, Tone } from './cells';
import type { KindColumns } from './types';

const dataKeys = (o: KubeObject) => [
  ...Object.keys(asObject(field(o, 'data'))),
  ...Object.keys(asObject(field(o, 'binaryData'))),
];

export const configMapColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'keys',
      label: () => i18n.t('Keys'),
      width: 'minmax(200px, 3fr)',
      cell: (o) => <Chips values={dataKeys(o)} max={4} />,
      sort: (o) => dataKeys(o).length,
    },
  ]),
};

export const secretColumns: KindColumns = {
  searchText: (o) => asString(field(o, 'type')),
  columns: standard(true, [
    {
      id: 'keys',
      label: () => i18n.t('Keys'),
      width: 'minmax(180px, 2.5fr)',
      cell: (o) => <Chips values={Object.keys(asObject(field(o, 'data')))} max={3} />,
      sort: (o) => Object.keys(asObject(field(o, 'data'))).length,
    },
    {
      id: 'type',
      label: () => i18n.t('Type'),
      width: 'minmax(150px, 1.6fr)',
      cell: (o) => <Mono>{asString(field(o, 'type')) || 'Opaque'}</Mono>,
      sort: (o) => asString(field(o, 'type')),
    },
  ]),
};

export const resourceQuotaColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'usage',
      label: () => i18n.t('Usage'),
      width: 'minmax(240px, 3fr)',
      cell: (o) => {
        const hard = asObject(status(o).hard);
        const used = asObject(status(o).used);
        return (
          <Chips
            values={Object.keys(hard).map(
              (k) => `${k}: ${asString(used[k]) || '0'}/${asString(hard[k])}`,
            )}
            max={3}
          />
        );
      },
    },
  ]),
};

export const limitRangeColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'types',
      label: () => i18n.t('Types'),
      width: 'minmax(160px, 2fr)',
      cell: (o) => (
        <Chips
          values={asArray(spec(o).limits)
            .filter(isObject)
            .map((l) => asString(l.type))}
        />
      ),
    },
  ]),
};

export function hpaMetrics(o: KubeObject): string[] {
  const current = asArray(status(o).currentMetrics).filter(isObject);
  return asArray(spec(o).metrics)
    .filter(isObject)
    .map((m, i) => {
      const type = asString(m.type);
      const res = asObject(m.resource ?? m.containerResource);
      const target = asObject(res.target);
      const cur = asObject(asObject(current[i]?.resource).current);
      if (type === 'Resource' || type === 'ContainerResource') {
        const t =
          target.averageUtilization !== undefined
            ? `${asString(target.averageUtilization)}%`
            : asString(target.averageValue) || asString(target.value);
        const c =
          cur.averageUtilization !== undefined
            ? `${asString(cur.averageUtilization)}%`
            : asString(cur.averageValue) || '<unknown>';
        return `${asString(res.name)} ${c} / ${t}`;
      }
      return type;
    });
}

export const hpaColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'metrics',
      label: () => i18n.t('Metrics'),
      width: 'minmax(170px, 2fr)',
      cell: (o) => <Chips values={hpaMetrics(o)} />,
    },
    {
      id: 'min',
      label: () => i18n.t('Min Pods'),
      width: '72px',
      align: 'right',
      cell: (o) => <Muted>{asNumber(spec(o).minReplicas, 1)}</Muted>,
      sort: (o) => asNumber(spec(o).minReplicas, 1),
    },
    {
      id: 'max',
      label: () => i18n.t('Max Pods'),
      width: '72px',
      align: 'right',
      cell: (o) => <Muted>{asNumber(spec(o).maxReplicas)}</Muted>,
      sort: (o) => asNumber(spec(o).maxReplicas),
    },
    {
      id: 'replicas',
      label: () => i18n.t('Replicas'),
      width: '72px',
      align: 'right',
      cell: (o) => <Muted>{asNumber(status(o).currentReplicas)}</Muted>,
      sort: (o) => asNumber(status(o).currentReplicas),
    },
    {
      id: 'status',
      label: () => i18n.t('Status'),
      width: 'minmax(110px, 1fr)',
      cell: (o) => {
        const active = asArray(status(o).conditions)
          .filter(isObject)
          .find((c) => c.type === 'ScalingActive');
        return active?.status === 'False' ? (
          <Tone tone="error" title={asString(active.message)}>
            {asString(active.reason)}
          </Tone>
        ) : (
          <Tone tone="success">{i18n.t('Scaling active')}</Tone>
        );
      },
    },
  ]),
};

export const pdbColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'minAvailable',
      label: () => i18n.t('Min Available'),
      width: '96px',
      align: 'right',
      cell: (o) => <Muted>{asString(spec(o).minAvailable) || '—'}</Muted>,
    },
    {
      id: 'maxUnavailable',
      label: () => i18n.t('Max Unavailable'),
      width: '112px',
      align: 'right',
      cell: (o) => <Muted>{asString(spec(o).maxUnavailable) || '—'}</Muted>,
    },
    {
      id: 'healthy',
      label: () => i18n.t('Current Healthy'),
      width: '104px',
      align: 'right',
      cell: (o) => <Muted>{asNumber(status(o).currentHealthy)}</Muted>,
    },
    {
      id: 'desired',
      label: () => i18n.t('Desired Healthy'),
      width: '104px',
      align: 'right',
      cell: (o) => <Muted>{asNumber(status(o).desiredHealthy)}</Muted>,
    },
    {
      id: 'allowed',
      label: () => i18n.t('Allowed Disruptions'),
      width: '124px',
      align: 'right',
      cell: (o) => {
        const n = asNumber(status(o).disruptionsAllowed);
        return <Tone tone={n > 0 ? 'success' : 'warning'}>{n}</Tone>;
      },
    },
  ]),
};

export const priorityClassColumns: KindColumns = {
  columns: standard(false, [
    {
      id: 'value',
      label: () => i18n.t('Value'),
      width: '110px',
      align: 'right',
      cell: (o) => <Muted>{asNumber(field(o, 'value'))}</Muted>,
      sort: (o) => asNumber(field(o, 'value')),
    },
    {
      id: 'globalDefault',
      label: () => i18n.t('Global Default'),
      width: '110px',
      cell: (o) =>
        field(o, 'globalDefault') === true ? (
          <Tone tone="success">{i18n.t('Yes')}</Tone>
        ) : (
          <Muted>{i18n.t('No')}</Muted>
        ),
    },
  ]),
};

export const runtimeClassColumns: KindColumns = {
  columns: standard(false, [
    {
      id: 'handler',
      label: () => i18n.t('Handler'),
      width: 'minmax(120px, 1fr)',
      cell: (o) => <Mono>{asString(field(o, 'handler'))}</Mono>,
    },
  ]),
};

export const leaseColumns: KindColumns = {
  columns: standard(true, [
    {
      id: 'holder',
      label: () => i18n.t('Holder'),
      width: 'minmax(180px, 2fr)',
      cell: (o) => <Mono>{asString(spec(o).holderIdentity) || '—'}</Mono>,
      sort: (o) => asString(spec(o).holderIdentity),
    },
    {
      id: 'renew',
      label: () => i18n.t('Renewed'),
      width: '84px',
      align: 'right',
      cell: (o, ctx) => {
        const t = asString(spec(o).renewTime);
        return t ? (
          <span className="text-fg-muted tabular-nums">{formatAge(t, ctx.now)}</span>
        ) : (
          <Dash />
        );
      },
      sort: (o) => -Date.parse(asString(spec(o).renewTime) || '0'),
    },
  ]),
};

export const webhookColumns: KindColumns = {
  columns: standard(false, [
    {
      id: 'webhooks',
      label: () => i18n.t('Webhooks'),
      width: 'minmax(200px, 3fr)',
      cell: (o) => (
        <Chips
          values={asArray(field(o, 'webhooks'))
            .filter(isObject)
            .map((w) => asString(w.name))}
        />
      ),
      sort: (o) => asArray(field(o, 'webhooks')).length,
    },
  ]),
};
