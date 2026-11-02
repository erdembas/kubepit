import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { ExternalLink } from 'lucide-react';
import { asArray, asObject, asString, isObject, spec, status } from '@/lib/kube/accessors';
import { RefLink } from '@/lib/kube/columns/cells';
import {
  gatewayBucketLabel,
  policyBucketLabel,
  routeBucketLabel,
} from '@/lib/kube/columns/gateway';
import type { ColumnContext, ObjectRef } from '@/lib/kube/columns';
import {
  GATEWAY_BUCKET_TONE,
  GATEWAY_GROUP,
  POLICY_BUCKET_TONE,
  ROUTE_BUCKET_TONE,
  buildGatewayTopology,
  classController,
  conditionsOf,
  diagnoseGateway,
  diagnoseGatewayClass,
  diagnosePolicy,
  diagnoseRoute,
  envoyKindOf,
  envoyPatches,
  envoyProxySummary,
  gatewayAddresses,
  gatewayBucket,
  gatewayClassName,
  gatewayListeners,
  gatewaysOfClass,
  grantFrom,
  grantPermits,
  grantTo,
  groupKindText,
  implementationFor,
  isEnvoyGatewayClass,
  listenerKinds,
  parametersRef,
  parentLabel,
  policiesTargeting,
  policyAncestors,
  policyBucket,
  policyFeatures,
  policySelectors,
  policyTargets,
  resolveBackends,
  resolveParents,
  routeBackendRefs,
  routeHostnames,
  routeRules,
  routeSummary,
  routesOf,
  servedExtensions,
  topologyId,
  type BackendProblem,
  type GatewayIndex,
  type GwTopoNode,
  type ResolvedBackend,
} from '@/lib/kube/gateway';
import { kindIcon } from '@/lib/kube/icons';
import { gvkFromApiResource, kindKey } from '@/lib/kube/catalog';
import { cn } from '@/lib/cn';
import { navigateTo } from '@/store/useWorkbenchStore';
import type { KubeObject } from '@/types';
import { openExternal } from '../../actions/openExternal';
import { ConditionChips, ConditionsTable, IssueList } from '../../gateway/bits';
import { EnvoyProxySection } from '../../gateway/EnvoyProxySection';
import { GatewayTopologyCanvas } from '../../gateway/GatewayTopology';
import { useGatewayData, type GatewayData } from '../../gateway/useGatewayData';
import { ChipList, MiniTable, MonoText, Row, Rows, Section, ToneText } from '../primitives';
import { JsonTree } from './GenericSections';
import type { SectionProps } from './types';

/**
 * Details sections for Gateway API and Envoy Gateway objects. Each reads
 * the shared Gateway API watches (`useGatewayData`), so references resolve
 * against live objects: parents and listeners, backends and their ports,
 * ReferenceGrants, attached routes and policies, plus the diagnosis.
 */

function useData(obj: KubeObject, ctx: ColumnContext, isActive: boolean): GatewayData {
  const namespaces = useMemo(
    () => (obj.metadata.namespace ? [obj.metadata.namespace] : []),
    [obj.metadata.namespace],
  );
  return useGatewayData(ctx.clusterId, ctx.apiResources, namespaces, isActive);
}

const refOf = (o: KubeObject): ObjectRef => ({
  apiVersion: o.apiVersion,
  kind: o.kind,
  name: o.metadata.name,
  namespace: o.metadata.namespace ?? null,
});

function Problems({
  issues,
  ctx,
  title,
}: {
  issues: ReturnType<typeof diagnoseRoute>;
  ctx: ColumnContext;
  title?: string;
}) {
  i18n.useLocale();
  return (
    <Section title={title ?? i18n.t('Diagnosis')}>
      <IssueList issues={issues} ctx={ctx} empty={i18n.t('No problems found.')} />
    </Section>
  );
}

function Topology({
  obj,
  index,
  ctx,
}: {
  obj: KubeObject;
  index: GatewayIndex;
  ctx: ColumnContext;
}) {
  i18n.useLocale();
  const id = topologyId(obj);
  const topology = useMemo(
    () => buildGatewayTopology(index, { namespaces: [], focus: id }),
    [index, id],
  );
  const open = (n: GwTopoNode) =>
    ctx.navigate({ apiVersion: n.apiVersion, kind: n.kind, name: n.name, namespace: n.namespace });
  if (topology.nodes.length < 2) return null;
  return (
    <Section title={i18n.t('Topology')}>
      <GatewayTopologyCanvas
        topology={topology}
        activeId={id}
        onOpen={open}
        className="border-border/60 -mx-1 max-h-[420px] rounded-md border"
      />
    </Section>
  );
}

function AttachedPolicies({
  obj,
  policies,
  ctx,
}: {
  obj: KubeObject;
  policies: readonly KubeObject[];
  ctx: ColumnContext;
}) {
  i18n.useLocale();
  const attached = useMemo(() => policiesTargeting(obj, policies), [obj, policies]);
  if (!attached.length) return null;
  return (
    <Section title={i18n.t('Policies')}>
      <MiniTable
        rows={attached}
        rowKey={(a) => a.policy.metadata.uid}
        columns={[
          { label: i18n.t('Kind'), lang: 'en', cell: (a) => a.policy.kind },
          { label: i18n.t('Name'), cell: (a) => <RefLink target={refOf(a.policy)} ctx={ctx} /> },
          {
            label: i18n.t('Section'),
            className: 'font-mono',
            cell: (a) => (a.sections.length ? a.sections.join(', ') : '—'),
          },
          {
            label: i18n.t('Configures'),
            className: 'font-mono',
            cell: (a) => policyFeatures(a.policy).join(', ') || '—',
          },
          {
            label: i18n.t('Status'),
            cell: (a) => {
              const bucket = policyBucket(a.policy);
              return (
                <ToneText tone={POLICY_BUCKET_TONE[bucket]}>{policyBucketLabel(bucket)}</ToneText>
              );
            },
          },
        ]}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// GatewayClass
// ---------------------------------------------------------------------------

export function GatewayClassSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const data = useData(obj, ctx, isActive);
  const controller = classController(obj);
  const impl = implementationFor(controller);
  const params = parametersRef(obj);
  const gateways = useMemo(
    () => gatewaysOfClass(data.index, obj.metadata.name),
    [data.index, obj.metadata.name],
  );
  const issues = useMemo(() => diagnoseGatewayClass(data.index, obj), [data.index, obj]);
  const extensions = useMemo(
    () => (impl ? servedExtensions(impl, ctx.apiResources) : []),
    [impl, ctx.apiResources],
  );
  const features = asArray(status(obj).supportedFeatures).map((f) =>
    isObject(f) ? asString(f.name) : asString(f),
  );
  return (
    <>
      <Section title="GatewayClass">
        <Rows>
          <Row label={i18n.t('Implementation')}>
            {impl ? (
              <button
                type="button"
                onClick={() => void openExternal(impl.docs)}
                className="text-accent inline-flex items-center gap-1 hover:underline"
              >
                {impl.name}
                <ExternalLink className="h-2.5 w-2.5" />
              </button>
            ) : (
              <span className="text-fg-muted">{i18n.t('Unknown implementation')}</span>
            )}
          </Row>
          <Row label={i18n.t('Controller')}>
            <MonoText>{controller}</MonoText>
          </Row>
          <Row label={i18n.t('Parameters')}>
            {params && (
              <span className="flex items-baseline gap-1.5">
                <span className="text-fg-dim text-[11px]">{params.kind}</span>
                <RefLink
                  target={{
                    apiVersion: params.group ? `${params.group}/v1` : 'v1',
                    kind: params.kind,
                    name: params.name,
                    namespace: params.namespace,
                  }}
                  ctx={ctx}
                />
              </span>
            )}
          </Row>
          <Row label={i18n.t('Description')}>{asString(spec(obj).description) || null}</Row>
          <Row label={i18n.t('Status')}>
            <ConditionChips conditions={conditionsOf(status(obj).conditions)} />
          </Row>
        </Rows>
      </Section>
      <Problems issues={issues} ctx={ctx} />
      <Section title={i18n.t('Gateways')}>
        <MiniTable
          rows={gateways}
          rowKey={(g) => g.metadata.uid}
          empty={i18n.t('No Gateway uses this class.')}
          columns={[
            {
              label: i18n.t('Gateway'),
              cell: (g) => (
                <RefLink
                  target={refOf(g)}
                  ctx={ctx}
                  label={`${g.metadata.namespace}/${g.metadata.name}`}
                />
              ),
            },
            {
              label: i18n.t('Addresses'),
              className: 'font-mono',
              cell: (g) =>
                gatewayAddresses(g)
                  .map((a) => a.value)
                  .join(', ') || '—',
            },
            {
              label: i18n.t('Status'),
              cell: (g) => (
                <ToneText tone={GATEWAY_BUCKET_TONE[gatewayBucket(g)]}>
                  {gatewayBucketLabel(gatewayBucket(g))}
                </ToneText>
              ),
            },
          ]}
        />
      </Section>
      {extensions.length > 0 && impl && (
        <Section title={i18n.t('{implementation} resources', { implementation: impl.name })}>
          <div className="flex flex-wrap gap-1.5">
            {extensions.map((r) => {
              const Icon = kindIcon(kindKey(r));
              return (
                <button
                  key={kindKey(r)}
                  type="button"
                  onClick={() => navigateTo(ctx.clusterId, gvkFromApiResource(r))}
                  className="bg-fg/5 text-fg-muted ring-border/60 hover:text-fg hover:ring-border-strong inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] ring-1 transition"
                  title={`${r.kind}.${r.group}`}
                >
                  <Icon className="h-3 w-3" />
                  {r.kind}
                </button>
              );
            })}
          </div>
        </Section>
      )}
      {features.length > 0 && (
        <Section title={i18n.t('Supported features')}>
          <ChipList entries={features} limit={12} />
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export function GatewayObjectSections({ obj, ctx, isActive, readOnly }: SectionProps) {
  i18n.useLocale();
  const data = useData(obj, ctx, isActive);
  const className = gatewayClassName(obj);
  const cls = data.index.classes.get(className) ?? null;
  const impl = cls ? implementationFor(classController(cls)) : null;
  const listeners = gatewayListeners(obj);
  const attached = useMemo(() => routesOf(data.index, obj), [data.index, obj]);
  const issues = useMemo(() => diagnoseGateway(data.index, obj), [data.index, obj]);
  const policies = useMemo(
    () => [...data.envoyPolicies, ...data.backendTlsPolicies],
    [data.envoyPolicies, data.backendTlsPolicies],
  );
  const params = parametersRef(obj);
  const bucket = gatewayBucket(obj);
  return (
    <>
      <Section title="Gateway">
        <Rows>
          <Row label={i18n.t('Class')}>
            <span className="flex items-baseline gap-1.5">
              <RefLink
                target={{ apiVersion: obj.apiVersion, kind: 'GatewayClass', name: className }}
                ctx={ctx}
              />
              {impl && <span className="text-fg-dim text-[11px]">{impl.name}</span>}
            </span>
          </Row>
          <Row label={i18n.t('Status')}>
            {conditionsOf(status(obj).conditions).length ? (
              <ConditionChips conditions={conditionsOf(status(obj).conditions)} />
            ) : (
              <ToneText tone={GATEWAY_BUCKET_TONE[bucket]}>{gatewayBucketLabel(bucket)}</ToneText>
            )}
          </Row>
          <Row label={i18n.t('Addresses')}>
            {gatewayAddresses(obj).length > 0 && (
              <ChipList entries={gatewayAddresses(obj).map((a) => a.value)} />
            )}
          </Row>
          <Row label={i18n.t('Infrastructure')}>
            {params && (
              <span className="flex items-baseline gap-1.5">
                <span className="text-fg-dim text-[11px]">{params.kind}</span>
                <RefLink
                  target={{
                    apiVersion: params.group ? `${params.group}/v1` : 'v1',
                    kind: params.kind,
                    name: params.name,
                    namespace: params.namespace,
                  }}
                  ctx={ctx}
                />
              </span>
            )}
          </Row>
        </Rows>
      </Section>
      <Problems issues={issues} ctx={ctx} />
      <Section title={i18n.t('Listeners')}>
        <MiniTable
          rows={listeners}
          rowKey={(l) => l.name}
          columns={[
            { label: i18n.t('Name'), cell: (l) => <span className="text-fg">{l.name}</span> },
            {
              label: i18n.t('Port'),
              className: 'font-mono whitespace-nowrap',
              cell: (l) => `${l.protocol}:${l.port}`,
            },
            { label: i18n.t('Hostname'), className: 'font-mono', cell: (l) => l.hostname ?? '*' },
            {
              label: 'TLS',
              lang: 'en',
              cell: (l) =>
                l.tls ? (
                  <span className="flex flex-col gap-0.5">
                    <span>{l.tls.mode}</span>
                    {l.tls.certificateRefs.map((c) => (
                      <RefLink
                        key={`${c.namespace}/${c.name}`}
                        target={{
                          apiVersion: 'v1',
                          kind: c.kind,
                          name: c.name,
                          namespace: c.namespace,
                        }}
                        ctx={ctx}
                        label={
                          c.namespace !== obj.metadata.namespace
                            ? `${c.namespace}/${c.name}`
                            : c.name
                        }
                      />
                    ))}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              label: i18n.t('Allowed routes'),
              cell: (l) => (
                <span className="flex flex-col">
                  <span>
                    {l.allowedFrom === 'Same'
                      ? i18n.t('Same namespace')
                      : l.allowedFrom === 'All'
                        ? i18n.t('All namespaces')
                        : l.allowedFrom === 'Selector'
                          ? i18n.t('Selected namespaces')
                          : l.allowedFrom}
                  </span>
                  <span className="text-fg-dim font-mono text-[10.5px]">
                    {(listenerKinds(l) ?? []).map((k) => k.kind).join(', ')}
                  </span>
                </span>
              ),
            },
            {
              label: i18n.t('Routes'),
              className: 'text-right tabular-nums',
              cell: (l) => l.status?.attachedRoutes ?? '—',
            },
            {
              label: i18n.t('Status'),
              cell: (l) => <ConditionChips conditions={l.status?.conditions ?? []} />,
            },
          ]}
        />
      </Section>
      <Section title={i18n.t('Attached routes')}>
        <MiniTable
          rows={attached}
          rowKey={(a) => `${a.route.metadata.uid}|${parentLabel(a.parent.ref)}`}
          empty={i18n.t('No route names this Gateway as a parent.')}
          columns={[
            { label: i18n.t('Kind'), lang: 'en', cell: (a) => a.route.kind },
            {
              label: i18n.t('Route'),
              cell: (a) => (
                <RefLink
                  target={refOf(a.route)}
                  ctx={ctx}
                  label={`${a.route.metadata.namespace}/${a.route.metadata.name}`}
                />
              ),
            },
            {
              label: i18n.t('Hostnames'),
              className: 'font-mono',
              cell: (a) => routeHostnames(a.route).join(', ') || '*',
            },
            {
              label: i18n.t('Listeners'),
              className: 'font-mono',
              cell: (a) =>
                a.listeners.length ? (
                  a.listeners.join(', ')
                ) : (
                  <span className="text-status-error">{i18n.t('none match')}</span>
                ),
            },
            {
              label: i18n.t('Status'),
              cell: (a) => <ConditionChips conditions={a.parent.status?.conditions ?? []} />,
            },
          ]}
        />
      </Section>
      <Topology obj={obj} index={data.index} ctx={ctx} />
      <AttachedPolicies obj={obj} policies={policies} ctx={ctx} />
      {isEnvoyGatewayClass(cls) && (
        <EnvoyProxySection
          gateway={obj}
          gatewayClass={cls}
          envoyProxies={data.envoyProxies}
          ctx={ctx}
          isActive={isActive}
          readOnly={readOnly}
        />
      )}
      <Section title={i18n.t('Conditions')}>
        <ConditionsTable conditions={conditionsOf(status(obj).conditions)} now={ctx.now} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function backendProblemText(p: BackendProblem): string {
  switch (p) {
    case 'service-missing':
      return i18n.t('not found');
    case 'port-missing':
      return i18n.t('no port');
    case 'port-unknown':
      return i18n.t('port not exposed');
    case 'not-permitted':
      return i18n.t('no ReferenceGrant');
    default:
      return i18n.t('not checked');
  }
}

function BackendCell({
  b,
  ctx,
  routeNs,
}: {
  b: ResolvedBackend;
  ctx: ColumnContext;
  routeNs: string;
}) {
  i18n.useLocale();
  const bad = b.problems.filter((p) => p !== 'unchecked-kind');
  const label = `${b.ref.namespace !== routeNs ? `${b.ref.namespace}/` : ''}${b.ref.name}${b.ref.port !== null ? `:${b.ref.port}` : ''}`;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      {b.ref.kind !== 'Service' && <span className="text-fg-dim text-[11px]">{b.ref.kind}</span>}
      <RefLink
        target={{
          apiVersion: b.ref.group ? `${b.ref.group}/v1alpha1` : 'v1',
          kind: b.ref.kind,
          name: b.ref.name,
          namespace: b.ref.namespace,
        }}
        ctx={ctx}
        label={label}
      />
      {b.ref.weight !== 1 && (
        <span className="text-fg-dim text-[10.5px] tabular-nums">w{b.ref.weight}</span>
      )}
      {b.ref.mirror && <span className="text-fg-dim text-[10.5px]">{i18n.t('mirror')}</span>}
      {b.grant && (
        <span
          className="text-fg-dim text-[10.5px]"
          title={i18n.t('Permitted by ReferenceGrant {name}', { name: b.grant.metadata.name })}
        >
          {i18n.t('granted')}
        </span>
      )}
      {bad.map((p) => (
        <span key={p} className="text-status-error text-[10.5px]">
          {backendProblemText(p)}
        </span>
      ))}
    </span>
  );
}

export function RouteSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const data = useData(obj, ctx, isActive);
  const parents = useMemo(() => resolveParents(data.index, obj), [data.index, obj]);
  const backends = useMemo(() => resolveBackends(data.index, obj), [data.index, obj]);
  const issues = useMemo(() => diagnoseRoute(data.index, obj), [data.index, obj]);
  const policies = useMemo(
    () => [...data.envoyPolicies, ...data.backendTlsPolicies],
    [data.envoyPolicies, data.backendTlsPolicies],
  );
  const rules = routeRules(obj);
  const summary = routeSummary(obj);
  const hostnames = routeHostnames(obj);
  const routeNs = obj.metadata.namespace ?? '';
  return (
    <>
      <Section title={obj.kind}>
        <Rows>
          <Row label={i18n.t('Status')}>
            <ToneText tone={ROUTE_BUCKET_TONE[summary.bucket]}>
              {routeBucketLabel(summary.bucket)}
            </ToneText>
            <span className="text-fg-dim ml-2 text-[11px]">
              {i18n.t('{accepted} of {parents} parents accepted', {
                accepted: summary.accepted,
                parents: summary.parents,
              })}
            </span>
          </Row>
          {(obj.kind === 'HTTPRoute' || obj.kind === 'GRPCRoute' || obj.kind === 'TLSRoute') && (
            <Row label={i18n.t('Hostnames')}>
              {hostnames.length ? (
                <ChipList entries={hostnames} />
              ) : (
                <span className="text-fg-dim">{i18n.t('Any (the listener decides)')}</span>
              )}
            </Row>
          )}
        </Rows>
      </Section>
      <Problems issues={issues} ctx={ctx} title={i18n.t('Why is this route not working?')} />
      <Section title={i18n.t('Parents')}>
        <MiniTable
          rows={parents}
          rowKey={(p, i) => `${parentLabel(p.ref)}|${i}`}
          empty={i18n.t('No parentRefs.')}
          columns={[
            {
              label: i18n.t('Parent'),
              cell: (p) => (
                <span className="flex items-baseline gap-1.5">
                  {p.ref.kind !== 'Gateway' && (
                    <span className="text-fg-dim text-[11px]">{p.ref.kind}</span>
                  )}
                  <RefLink
                    target={{
                      apiVersion: p.ref.group ? `${p.ref.group}/v1` : 'v1',
                      kind: p.ref.kind,
                      name: p.ref.name,
                      namespace: p.ref.namespace,
                    }}
                    ctx={ctx}
                    label={
                      p.ref.namespace !== routeNs ? `${p.ref.namespace}/${p.ref.name}` : p.ref.name
                    }
                  />
                </span>
              ),
            },
            {
              label: i18n.t('Section'),
              className: 'font-mono',
              cell: (p) => p.ref.sectionName ?? (p.ref.port !== null ? String(p.ref.port) : '—'),
            },
            {
              label: i18n.t('Listeners'),
              className: 'font-mono',
              cell: (p) => {
                const ok = p.listeners.filter((m) => m.ok).map((m) => m.listener.name);
                if (ok.length) return ok.join(', ');
                // Only a checked mismatch is an error; an unchecked parent is unknown.
                return p.problem && p.problem !== 'unchecked-kind' ? (
                  <span className="text-status-error">{i18n.t('none match')}</span>
                ) : (
                  '—'
                );
              },
            },
            {
              label: i18n.t('Status'),
              cell: (p) => <ConditionChips conditions={p.status?.conditions ?? []} />,
            },
          ]}
        />
      </Section>
      <Section title={i18n.t('Rules')}>
        <MiniTable
          rows={rules}
          rowKey={(r) => String(r.index)}
          empty={i18n.t('No rules.')}
          columns={[
            { label: '#', className: 'tabular-nums', cell: (r) => r.name || r.index + 1 },
            ...(obj.kind === 'HTTPRoute' || obj.kind === 'GRPCRoute'
              ? [
                  {
                    label: i18n.t('Matches'),
                    className: 'font-mono',
                    cell: (r: (typeof rules)[number]) => (
                      <span className="flex flex-col">
                        {r.matches.map((m, i) => (
                          <span key={i}>{m}</span>
                        ))}
                      </span>
                    ),
                  },
                  {
                    label: i18n.t('Filters'),
                    className: 'font-mono',
                    cell: (r: (typeof rules)[number]) => r.filters.join(', ') || '—',
                  },
                ]
              : []),
            {
              label: i18n.t('Backends'),
              cell: (r) => {
                const list = backends.filter((b) => b.ref.rule === r.index);
                return list.length ? (
                  <span className="flex flex-col gap-0.5">
                    {list.map((b, i) => (
                      <BackendCell key={i} b={b} ctx={ctx} routeNs={routeNs} />
                    ))}
                  </span>
                ) : (
                  <span className={cn(r.terminal ? 'text-fg-dim' : 'text-status-starting')}>
                    {r.terminal ? i18n.t('answered by a filter') : i18n.t('none')}
                  </span>
                );
              },
            },
          ]}
        />
      </Section>
      <Topology obj={obj} index={data.index} ctx={ctx} />
      <AttachedPolicies obj={obj} policies={policies} ctx={ctx} />
    </>
  );
}

// ---------------------------------------------------------------------------
// ReferenceGrant
// ---------------------------------------------------------------------------

export function ReferenceGrantSections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const data = useData(obj, ctx, isActive);
  const uses = useMemo(() => {
    const out: Array<{ from: KubeObject; to: string }> = [];
    for (const route of data.routes)
      for (const b of routeBackendRefs(route))
        if (
          b.namespace !== route.metadata.namespace &&
          grantPermits(
            obj,
            { group: GATEWAY_GROUP, kind: route.kind, namespace: route.metadata.namespace ?? '' },
            { group: b.group, kind: b.kind, namespace: b.namespace, name: b.name },
          )
        )
          out.push({ from: route, to: `${b.kind} ${b.name}` });
    for (const gw of data.gateways)
      for (const l of gatewayListeners(gw))
        for (const c of l.tls?.certificateRefs ?? [])
          if (
            c.namespace !== gw.metadata.namespace &&
            grantPermits(
              obj,
              { group: GATEWAY_GROUP, kind: 'Gateway', namespace: gw.metadata.namespace ?? '' },
              { group: c.group, kind: c.kind, namespace: c.namespace, name: c.name },
            )
          )
            out.push({ from: gw, to: `${c.kind} ${c.name}` });
    return out;
  }, [data.routes, data.gateways, obj]);
  return (
    <>
      <Section title={i18n.t('From')}>
        <MiniTable
          rows={grantFrom(obj)}
          rowKey={(f, i) => `${f.namespace}|${f.kind}|${i}`}
          columns={[
            {
              label: i18n.t('Namespace'),
              cell: (f) => (
                <RefLink
                  target={{ apiVersion: 'v1', kind: 'Namespace', name: f.namespace }}
                  ctx={ctx}
                />
              ),
            },
            {
              label: i18n.t('Kind'),
              lang: 'en',
              className: 'font-mono',
              cell: (f) => groupKindText(f),
            },
          ]}
        />
      </Section>
      <Section title={i18n.t('To')}>
        <MiniTable
          rows={grantTo(obj)}
          rowKey={(t, i) => `${t.kind}|${t.name ?? ''}|${i}`}
          columns={[
            {
              label: i18n.t('Kind'),
              lang: 'en',
              className: 'font-mono',
              cell: (t) => groupKindText(t),
            },
            {
              label: i18n.t('Name'),
              cell: (t) =>
                t.name ? (
                  <RefLink
                    target={{
                      apiVersion: t.group ? `${t.group}/v1` : 'v1',
                      kind: t.kind,
                      name: t.name,
                      namespace: obj.metadata.namespace ?? null,
                    }}
                    ctx={ctx}
                  />
                ) : (
                  <span className="text-fg-dim">
                    {i18n.t('Every object of the kind in {namespace}', {
                      namespace: obj.metadata.namespace ?? '',
                    })}
                  </span>
                ),
            },
          ]}
        />
      </Section>
      <Section title={i18n.t('References it permits')}>
        <MiniTable
          rows={uses}
          rowKey={(u, i) => `${u.from.metadata.uid}|${i}`}
          empty={i18n.t('Nothing currently relies on this grant.')}
          columns={[
            {
              label: i18n.t('Referrer'),
              cell: (u) => (
                <RefLink
                  target={refOf(u.from)}
                  ctx={ctx}
                  label={`${u.from.kind} ${u.from.metadata.namespace}/${u.from.metadata.name}`}
                />
              ),
            },
            { label: i18n.t('Referenced'), className: 'font-mono', cell: (u) => u.to },
          ]}
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Policies: BackendTLSPolicy and Envoy Gateway policies
// ---------------------------------------------------------------------------

const SKIP_SPEC = new Set(['targetRef', 'targetRefs', 'targetSelectors']);

export function GatewayPolicySections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const data = useData(obj, ctx, isActive);
  const issues = useMemo(() => diagnosePolicy(data.index, obj), [data.index, obj]);
  const targets = policyTargets(obj);
  const selectors = policySelectors(obj);
  const ancestors = policyAncestors(obj);
  const bucket = policyBucket(obj);
  const s = spec(obj);
  const validation = asObject(s.validation);
  const rest = Object.fromEntries(Object.entries(s).filter(([k]) => !SKIP_SPEC.has(k)));
  const patches = envoyKindOf(obj) === 'EnvoyPatchPolicy' ? envoyPatches(obj) : [];
  return (
    <>
      <Section title={obj.kind}>
        <Rows>
          <Row label={i18n.t('Status')}>
            <ToneText tone={POLICY_BUCKET_TONE[bucket]}>{policyBucketLabel(bucket)}</ToneText>
          </Row>
          <Row label={i18n.t('Configures')}>
            {policyFeatures(obj).length > 0 && <ChipList entries={policyFeatures(obj)} />}
          </Row>
          {obj.kind === 'BackendTLSPolicy' && (
            <>
              <Row label={i18n.t('Hostname')}>
                {asString(validation.hostname) && (
                  <MonoText>{asString(validation.hostname)}</MonoText>
                )}
              </Row>
              <Row label={i18n.t('CA certificates')}>
                {asString(validation.wellKnownCACertificates) ||
                  asArray(validation.caCertificateRefs)
                    .filter(isObject)
                    .map((c) => `${asString(c.kind)}/${asString(c.name)}`)
                    .join(', ') ||
                  null}
              </Row>
            </>
          )}
        </Rows>
      </Section>
      <Problems issues={issues} ctx={ctx} />
      <Section title={i18n.t('Targets')}>
        <MiniTable
          rows={targets}
          rowKey={(t, i) => `${t.kind}|${t.name}|${i}`}
          empty={selectors.length ? i18n.t('Selected by labels only.') : i18n.t('No targetRefs.')}
          columns={[
            { label: i18n.t('Kind'), lang: 'en', cell: (t) => t.kind },
            {
              label: i18n.t('Name'),
              cell: (t) => (
                <RefLink
                  target={{
                    apiVersion: t.group ? `${t.group}/v1` : 'v1',
                    kind: t.kind,
                    name: t.name,
                    namespace: t.kind === 'GatewayClass' ? null : t.namespace,
                  }}
                  ctx={ctx}
                />
              ),
            },
            { label: i18n.t('Section'), className: 'font-mono', cell: (t) => t.sectionName ?? '—' },
          ]}
        />
        {selectors.length > 0 && (
          <div className="mt-2">
            <ChipList entries={selectors} />
          </div>
        )}
      </Section>
      <Section title={i18n.t('Status by ancestor')}>
        <MiniTable
          rows={ancestors}
          rowKey={(a, i) => `${parentLabel(a.ancestorRef)}|${i}`}
          empty={i18n.t('No controller has reported on this policy.')}
          columns={[
            {
              label: i18n.t('Ancestor'),
              cell: (a) => (
                <RefLink
                  target={{
                    apiVersion: a.ancestorRef.group ? `${a.ancestorRef.group}/v1` : 'v1',
                    kind: a.ancestorRef.kind,
                    name: a.ancestorRef.name,
                    namespace: a.ancestorRef.namespace,
                  }}
                  ctx={ctx}
                  label={`${a.ancestorRef.kind} ${parentLabel(a.ancestorRef)}`}
                />
              ),
            },
            { label: i18n.t('Status'), cell: (a) => <ConditionChips conditions={a.conditions} /> },
          ]}
        />
      </Section>
      {patches.length > 0 && (
        <Section title={i18n.t('Patches')}>
          <MiniTable
            rows={patches}
            rowKey={(p, i) => `${p.name}|${i}`}
            columns={[
              { label: i18n.t('Type'), className: 'font-mono', cell: (p) => p.type },
              { label: i18n.t('Name'), className: 'font-mono break-all', cell: (p) => p.name },
              {
                label: i18n.t('Operation'),
                className: 'font-mono',
                cell: (p) => `${p.op} ${p.path}`,
              },
            ]}
          />
        </Section>
      )}
      {Object.keys(rest).length > 0 && (
        <Section title="spec">
          <JsonTree value={rest} />
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// EnvoyProxy
// ---------------------------------------------------------------------------

export function EnvoyProxySections({ obj, ctx, isActive }: SectionProps) {
  i18n.useLocale();
  const data = useData(obj, ctx, isActive);
  const summary = envoyProxySummary(obj);
  const users = useMemo(() => {
    const matches = (o: KubeObject) => {
      const ref = parametersRef(o);
      return (
        !!ref &&
        ref.kind === 'EnvoyProxy' &&
        ref.name === obj.metadata.name &&
        ref.namespace === (obj.metadata.namespace ?? null)
      );
    };
    return [...data.classes.filter(matches), ...data.gateways.filter(matches)];
  }, [data.classes, data.gateways, obj]);
  return (
    <>
      <Section title="EnvoyProxy">
        <Rows>
          <Row label={i18n.t('Workload')}>
            {summary.replicas !== null
              ? `${summary.workload} ×${summary.replicas}`
              : summary.workload}
          </Row>
          <Row label={i18n.t('Service type')}>{summary.serviceType}</Row>
          <Row label={i18n.t('Merged')}>
            {summary.mergeGateways
              ? i18n.t('One proxy fleet serves every Gateway of the class')
              : null}
          </Row>
          <Row label={i18n.t('Log level')}>{summary.logLevel || null}</Row>
          <Row label={i18n.t('Telemetry')}>
            {summary.telemetry.length ? <ChipList entries={summary.telemetry} /> : null}
          </Row>
          <Row label={i18n.t('Bootstrap')}>{summary.bootstrap || null}</Row>
        </Rows>
      </Section>
      <Section title={i18n.t('Used by')}>
        <MiniTable
          rows={users}
          rowKey={(u) => u.metadata.uid}
          empty={i18n.t('No GatewayClass or Gateway references this EnvoyProxy.')}
          columns={[
            { label: i18n.t('Kind'), lang: 'en', cell: (u) => u.kind },
            { label: i18n.t('Name'), cell: (u) => <RefLink target={refOf(u)} ctx={ctx} /> },
          ]}
        />
      </Section>
      <Section title="spec">
        <JsonTree value={spec(obj)} />
      </Section>
    </>
  );
}
