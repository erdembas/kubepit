import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asObject, asString, spec, status } from '../accessors';
import {
  ENVOY_KINDS,
  GATEWAY_BUCKET_TONE,
  GATEWAY_KINDS,
  POLICY_BUCKET_TONE,
  ROUTE_BUCKET_TONE,
  attachedRouteCount,
  classController,
  conditionTone,
  conditionsOf,
  envoyProxySummary,
  findCondition,
  gatewayAddresses,
  gatewayBucket,
  gatewayClassName,
  gatewayListeners,
  grantFrom,
  grantTo,
  groupKindText,
  implementationName,
  parentLabel,
  policyBucket,
  policyFeatures,
  policySelectors,
  policyTargets,
  routeBackendRefs,
  routeHostnames,
  routeParentRefs,
  routeSummary,
  type GatewayBucket,
  type PolicyBucket,
  type RouteBucket,
} from '../gateway';
import {
  ageColumn,
  Chips,
  Dash,
  Mono,
  Muted,
  nameColumn,
  namespaceColumn,
  RefLink,
  Tone,
} from './cells';
import type { ColumnDef, KindColumns } from './types';

/** Default columns for the Gateway API and Envoy Gateway kinds (their own list pages). */

export function routeBucketLabel(bucket: RouteBucket): string {
  switch (bucket) {
    case 'accepted':
      return i18n.t('Accepted');
    case 'unresolved':
      return i18n.t('Unresolved refs');
    case 'partial':
      return i18n.t('Partly accepted');
    case 'rejected':
      return i18n.t('Not accepted');
    default:
      return i18n.t('Pending');
  }
}

export function gatewayBucketLabel(bucket: GatewayBucket): string {
  switch (bucket) {
    case 'programmed':
      return i18n.t('Programmed');
    case 'pending':
      return i18n.t('Pending');
    case 'failed':
      return i18n.t('Failed');
    default:
      return i18n.t('No status');
  }
}

export function policyBucketLabel(bucket: PolicyBucket): string {
  switch (bucket) {
    case 'accepted':
      return i18n.t('Accepted');
    case 'conflicted':
      return i18n.t('Conflicted');
    case 'rejected':
      return i18n.t('Not accepted');
    default:
      return i18n.t('Pending');
  }
}

const conditionColumn = (
  id: string,
  label: () => string,
  type: string,
  list: (o: KubeObject) => unknown = (o) => status(o).conditions,
): ColumnDef => ({
  id,
  label,
  width: '96px',
  cell: (o) => {
    const c = findCondition(conditionsOf(list(o)), type);
    if (!c) return <Dash />;
    return (
      <Tone tone={conditionTone(c)} title={[c.reason, c.message].filter(Boolean).join(': ')}>
        {c.status === 'True' ? c.type : c.reason || c.status}
      </Tone>
    );
  },
  sort: (o) => findCondition(conditionsOf(list(o)), type)?.status ?? '',
});

// ---------------------------------------------------------------------------
// GatewayClass, Gateway
// ---------------------------------------------------------------------------

const gatewayClassColumns: KindColumns = {
  searchText: (o) => `${classController(o)} ${implementationName(classController(o))}`,
  columns: [
    nameColumn,
    {
      id: 'implementation',
      label: () => i18n.t('Implementation'),
      width: 'minmax(120px, 1.2fr)',
      cell: (o) => (
        <span className="text-fg truncate">{implementationName(classController(o))}</span>
      ),
      sort: (o) => implementationName(classController(o)),
    },
    {
      id: 'controller',
      label: () => i18n.t('Controller'),
      width: 'minmax(180px, 2fr)',
      cell: (o) => <Mono title={classController(o)}>{classController(o)}</Mono>,
      sort: classController,
    },
    conditionColumn('accepted', () => i18n.t('Accepted'), 'Accepted'),
    {
      id: 'description',
      label: () => i18n.t('Description'),
      width: 'minmax(140px, 2fr)',
      defaultHidden: true,
      cell: (o) => {
        const d = asString(spec(o).description);
        return d ? <Muted title={d}>{d}</Muted> : <Dash />;
      },
      sort: (o) => asString(spec(o).description),
    },
    ageColumn,
  ],
};

const listenersText = (o: KubeObject) =>
  gatewayListeners(o).map((l) => `${l.protocol}:${l.port}${l.hostname ? ` ${l.hostname}` : ''}`);

const gatewayColumns: KindColumns = {
  searchText: (o) =>
    `${gatewayClassName(o)} ${gatewayBucket(o)} ${gatewayAddresses(o)
      .map((a) => a.value)
      .join(' ')} ${listenersText(o).join(' ')}`,
  defaultSort: { column: 'name', desc: false },
  columns: [
    nameColumn,
    namespaceColumn,
    {
      id: 'class',
      label: () => i18n.t('Class'),
      width: 'minmax(90px, 1fr)',
      cell: (o, ctx) =>
        gatewayClassName(o) ? (
          <RefLink
            target={{ apiVersion: o.apiVersion, kind: 'GatewayClass', name: gatewayClassName(o) }}
            ctx={ctx}
          />
        ) : (
          <Dash />
        ),
      sort: gatewayClassName,
    },
    {
      id: 'addresses',
      label: () => i18n.t('Addresses'),
      width: 'minmax(120px, 1.2fr)',
      cell: (o) => <Chips values={gatewayAddresses(o).map((a) => a.value)} max={1} />,
      sort: (o) => gatewayAddresses(o)[0]?.value ?? '',
    },
    {
      id: 'listeners',
      label: () => i18n.t('Listeners'),
      width: 'minmax(150px, 1.6fr)',
      cell: (o) => <Chips values={listenersText(o)} max={2} />,
      sort: (o) => gatewayListeners(o).length,
      text: (o) => listenersText(o).join(', '),
    },
    {
      id: 'routes',
      label: () => i18n.t('Routes'),
      width: '64px',
      align: 'right',
      cell: (o) => <span className="text-fg-muted tabular-nums">{attachedRouteCount(o)}</span>,
      sort: attachedRouteCount,
      value: attachedRouteCount,
    },
    {
      id: 'programmed',
      label: () => i18n.t('Status'),
      width: '100px',
      cell: (o) => {
        const bucket = gatewayBucket(o);
        const c = findCondition(conditionsOf(status(o).conditions), 'Programmed');
        return (
          <Tone
            tone={GATEWAY_BUCKET_TONE[bucket]}
            title={c ? [c.reason, c.message].filter(Boolean).join(': ') : undefined}
          >
            {gatewayBucketLabel(bucket)}
          </Tone>
        );
      },
      sort: gatewayBucket,
    },
    ageColumn,
  ],
};

const listenerSetColumns: KindColumns = {
  columns: [
    nameColumn,
    namespaceColumn,
    {
      id: 'parent',
      label: () => i18n.t('Gateway'),
      width: 'minmax(120px, 1.2fr)',
      cell: (o) => {
        const p = asObject(spec(o).parentRef);
        const name = asString(p.name);
        return name ? (
          <Muted>{`${asString(p.namespace) || o.metadata.namespace}/${name}`}</Muted>
        ) : (
          <Dash />
        );
      },
      sort: (o) => asString(asObject(spec(o).parentRef).name),
    },
    {
      id: 'listeners',
      label: () => i18n.t('Listeners'),
      width: 'minmax(150px, 1.6fr)',
      cell: (o) => <Chips values={listenersText(o)} max={2} />,
      sort: (o) => gatewayListeners(o).length,
    },
    conditionColumn('accepted', () => i18n.t('Accepted'), 'Accepted'),
    conditionColumn('programmed', () => i18n.t('Programmed'), 'Programmed'),
    ageColumn,
  ],
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function routeColumns(hostnames: boolean): KindColumns {
  return {
    searchText: (o) =>
      `${routeHostnames(o).join(' ')} ${routeParentRefs(o).map(parentLabel).join(' ')} ${routeBackendRefs(
        o,
      )
        .map((b) => b.name)
        .join(' ')} ${routeSummary(o).bucket}`,
    columns: [
      nameColumn,
      namespaceColumn,
      ...(hostnames
        ? [
            {
              id: 'hostnames',
              label: () => i18n.t('Hostnames'),
              width: 'minmax(150px, 1.6fr)',
              cell: (o: KubeObject) => <Chips values={routeHostnames(o)} max={2} />,
              sort: (o: KubeObject) => routeHostnames(o)[0] ?? '',
              text: (o: KubeObject) => routeHostnames(o).join(', '),
            } satisfies ColumnDef,
          ]
        : []),
      {
        id: 'parents',
        label: () => i18n.t('Parents'),
        width: 'minmax(140px, 1.4fr)',
        cell: (o) => <Chips values={routeParentRefs(o).map(parentLabel)} max={1} />,
        sort: (o) => routeParentRefs(o).map(parentLabel)[0] ?? '',
        text: (o) => routeParentRefs(o).map(parentLabel).join(', '),
      },
      {
        id: 'backends',
        label: () => i18n.t('Backends'),
        width: 'minmax(140px, 1.4fr)',
        cell: (o) => (
          <Chips
            values={[
              ...new Set(
                routeBackendRefs(o)
                  .filter((b) => !b.mirror)
                  .map(
                    (b) =>
                      `${b.namespace !== o.metadata.namespace ? `${b.namespace}/` : ''}${b.name}${b.port !== null ? `:${b.port}` : ''}`,
                  ),
              ),
            ]}
            max={2}
          />
        ),
        sort: (o) => routeBackendRefs(o).length,
      },
      {
        id: 'status',
        label: () => i18n.t('Status'),
        width: '112px',
        cell: (o) => {
          const s = routeSummary(o);
          return (
            <Tone
              tone={ROUTE_BUCKET_TONE[s.bucket]}
              title={i18n.t('{accepted} of {parents} parents accepted', {
                accepted: s.accepted,
                parents: s.parents,
              })}
            >
              {routeBucketLabel(s.bucket)}
            </Tone>
          );
        },
        sort: (o) => routeSummary(o).bucket,
      },
      ageColumn,
    ],
  };
}

// ---------------------------------------------------------------------------
// ReferenceGrant, policies
// ---------------------------------------------------------------------------

const referenceGrantColumns: KindColumns = {
  searchText: (o) =>
    `${grantFrom(o)
      .map((f) => `${f.kind} ${f.namespace}`)
      .join(' ')} ${grantTo(o)
      .map((t) => `${t.kind} ${t.name ?? ''}`)
      .join(' ')}`,
  columns: [
    nameColumn,
    namespaceColumn,
    {
      id: 'from',
      label: () => i18n.t('From'),
      width: 'minmax(160px, 2fr)',
      cell: (o) => <Chips values={grantFrom(o).map((f) => `${f.namespace}/${f.kind}`)} max={2} />,
      sort: (o) => grantFrom(o)[0]?.namespace ?? '',
      text: (o) =>
        grantFrom(o)
          .map((f) => `${f.namespace}/${groupKindText(f)}`)
          .join(', '),
    },
    {
      id: 'to',
      label: () => i18n.t('To'),
      width: 'minmax(140px, 1.6fr)',
      cell: (o) => (
        <Chips values={grantTo(o).map((t) => (t.name ? `${t.kind}/${t.name}` : t.kind))} max={2} />
      ),
      sort: (o) => grantTo(o)[0]?.kind ?? '',
      text: (o) =>
        grantTo(o)
          .map((t) => `${groupKindText(t)}${t.name ? `/${t.name}` : ''}`)
          .join(', '),
    },
    ageColumn,
  ],
};

const targetsText = (o: KubeObject) => [
  ...policyTargets(o).map((t) => `${t.kind}/${t.name}${t.sectionName ? `:${t.sectionName}` : ''}`),
  ...policySelectors(o),
];

function policyColumns(features: boolean): KindColumns {
  return {
    searchText: (o) =>
      `${targetsText(o).join(' ')} ${policyBucket(o)} ${policyFeatures(o).join(' ')}`,
    columns: [
      nameColumn,
      namespaceColumn,
      {
        id: 'targets',
        label: () => i18n.t('Targets'),
        width: 'minmax(160px, 1.8fr)',
        cell: (o) => <Chips values={targetsText(o)} max={2} />,
        sort: (o) => targetsText(o)[0] ?? '',
        text: (o) => targetsText(o).join(', '),
      },
      ...(features
        ? [
            {
              id: 'features',
              label: () => i18n.t('Configures'),
              width: 'minmax(150px, 1.6fr)',
              cell: (o: KubeObject) => <Chips values={policyFeatures(o)} max={3} />,
              sort: (o: KubeObject) => policyFeatures(o).length,
              text: (o: KubeObject) => policyFeatures(o).join(', '),
            } satisfies ColumnDef,
          ]
        : []),
      {
        id: 'status',
        label: () => i18n.t('Status'),
        width: '100px',
        cell: (o) => {
          const bucket = policyBucket(o);
          return <Tone tone={POLICY_BUCKET_TONE[bucket]}>{policyBucketLabel(bucket)}</Tone>;
        },
        sort: policyBucket,
      },
      ageColumn,
    ],
  };
}

const envoyProxyColumns: KindColumns = {
  columns: [
    nameColumn,
    namespaceColumn,
    {
      id: 'workload',
      label: () => i18n.t('Workload'),
      width: '110px',
      cell: (o) => {
        const s = envoyProxySummary(o);
        return <Muted>{s.replicas !== null ? `${s.workload} ×${s.replicas}` : s.workload}</Muted>;
      },
      sort: (o) => envoyProxySummary(o).workload,
    },
    {
      id: 'service',
      label: () => i18n.t('Service type'),
      width: '110px',
      cell: (o) => <Muted>{envoyProxySummary(o).serviceType}</Muted>,
      sort: (o) => envoyProxySummary(o).serviceType,
    },
    {
      id: 'merge',
      label: () => i18n.t('Merged'),
      width: '72px',
      cell: (o) => (envoyProxySummary(o).mergeGateways ? <Muted>{i18n.t('Yes')}</Muted> : <Dash />),
      sort: (o) => (envoyProxySummary(o).mergeGateways ? 1 : 0),
    },
    ageColumn,
  ],
};

/** Kind key → columns; merged into the column registry. */
export const GATEWAY_COLUMNS: Record<string, KindColumns> = {
  [GATEWAY_KINDS.GatewayClass.key]: gatewayClassColumns,
  [GATEWAY_KINDS.Gateway.key]: gatewayColumns,
  [GATEWAY_KINDS.ListenerSet.key]: listenerSetColumns,
  [GATEWAY_KINDS.HTTPRoute.key]: routeColumns(true),
  [GATEWAY_KINDS.GRPCRoute.key]: routeColumns(true),
  [GATEWAY_KINDS.TLSRoute.key]: routeColumns(true),
  [GATEWAY_KINDS.TCPRoute.key]: routeColumns(false),
  [GATEWAY_KINDS.UDPRoute.key]: routeColumns(false),
  [GATEWAY_KINDS.ReferenceGrant.key]: referenceGrantColumns,
  [GATEWAY_KINDS.BackendTLSPolicy.key]: policyColumns(false),
  [ENVOY_KINDS.EnvoyProxy.key]: envoyProxyColumns,
  [ENVOY_KINDS.BackendTrafficPolicy.key]: policyColumns(true),
  [ENVOY_KINDS.ClientTrafficPolicy.key]: policyColumns(true),
  [ENVOY_KINDS.SecurityPolicy.key]: policyColumns(true),
  [ENVOY_KINDS.EnvoyExtensionPolicy.key]: policyColumns(true),
  [ENVOY_KINDS.EnvoyPatchPolicy.key]: policyColumns(false),
};
