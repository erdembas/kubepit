import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import {
  ArrowUpCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  Router,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { ipc } from '@/lib/ipc';
import {
  BUILTIN,
  gvkForKey,
  gvkFromApiResource,
  kindKey,
  resolveRef,
  toGvk,
} from '@/lib/kube/catalog';
import { Chips } from '@/lib/kube/columns/cells';
import {
  gatewayBucketLabel,
  policyBucketLabel,
  routeBucketLabel,
} from '@/lib/kube/columns/gateway';
import type { ColumnContext, ObjectRef } from '@/lib/kube/columns';
import {
  GATEWAY_BUCKET_TONE,
  GATEWAY_KINDS,
  POLICY_BUCKET_TONE,
  ROUTE_BUCKET_TONE,
  attachedRouteCount,
  buildGatewayTopology,
  classController,
  controllerDomain,
  countBySeverity,
  detectGatewayApi,
  diagnoseAll,
  diagnoseGateway,
  gatewayAddresses,
  gatewayBucket,
  gatewayClassName,
  gatewayListeners,
  implementationFor,
  implementationsServing,
  installedBundle,
  parentLabel,
  policyBucket,
  policyFeatures,
  policySelectors,
  policyTargets,
  routeBackendRefs,
  routeHostnames,
  routeParentRefs,
  routeSummary,
  servedExtensions,
  topologyId,
  type GatewayImplementation,
  type GatewayIssue,
  type GwTopoNode,
  type IssueSeverity,
} from '@/lib/kube/gateway';
import { kindIcon } from '@/lib/kube/icons';
import { toneText } from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';
import { VIEW, navigateTo, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, KubeObject } from '@/types';
import { openExternal } from '../actions/openExternal';
import { useSelectedNamespaces } from '../data/hooks';
import { usePolled } from '../data/polled';
import { DetailsPanel } from '../details/DetailsPanel';
import { NamespacePicker } from '../header/NamespacePicker';
import { TableSkeleton } from '../table/TableStates';
import { IssueList, SeverityIcon, severityLabel } from './bits';
import { installedBundleKey } from './crdInstall';
import { GatewayApiMissing, GatewayCrdsInstall } from './GatewayCrdsInstall';
import { GatewayTopologyCanvas } from './GatewayTopology';
import { useGatewayData } from './useGatewayData';

/**
 * Gateway API view (`@gateway-api`): implementations detected from the
 * GatewayClasses' controllers, Gateways and routes with their status and
 * problems, the traffic topology, a diagnosis of everything in scope and
 * the attached policies (BackendTLSPolicy, Envoy Gateway). Objects open in
 * a docked details panel. Without the CRDs the view offers their install.
 */

type Tab = 'overview' | 'topology' | 'diagnosis' | 'policies';

const pickedTab = new Map<string, Tab>();

/** Rows drawn per table; the filter and namespace picker narrow the rest. */
const ROW_LIMIT = 300;
const ISSUE_LIMIT = 500;

function MoreRows({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="text-fg-dim px-3 py-2 text-[11px]">
      {i18n.t('Showing {shown} of {total}; narrow the filter or namespaces to see the rest.', {
        shown,
        total,
      })}
    </p>
  );
}

const TEMPLATE_GW =
  'minmax(150px,2fr) minmax(72px,1fr) minmax(100px,1.1fr) minmax(110px,1.2fr) minmax(130px,1.5fr) 56px 96px 64px';
const TEMPLATE_ROUTE =
  '84px minmax(150px,2fr) minmax(130px,1.6fr) minmax(130px,1.4fr) minmax(120px,1.4fr) 104px 64px';
const TEMPLATE_POLICY = '140px minmax(150px,2fr) minmax(160px,2fr) minmax(130px,1.6fr) 96px 64px';

function scopeLabel(namespaces: string[]) {
  if (!namespaces.length) return i18n.t('All namespaces');
  if (namespaces.length === 1) return namespaces[0]!;
  return i18n.t('{count} namespaces', { count: namespaces.length });
}

const subjectKey = (r: ObjectRef) => `${r.kind}|${r.namespace ?? ''}|${r.name}`;

function issueCount(issues: readonly GatewayIssue[]) {
  const c = countBySeverity(issues);
  return c;
}

function ProblemCell({ issues }: { issues: readonly GatewayIssue[] | undefined }) {
  const c = issueCount(issues ?? []);
  if (!c.error && !c.warning) return <span className="text-fg-dim/60">—</span>;
  return (
    <span className="flex items-center gap-2 tabular-nums">
      {c.error > 0 && (
        <span
          className="text-status-error flex items-center gap-0.5"
          title={severityLabel('error')}
        >
          <SeverityIcon severity="error" className="h-3 w-3" />
          {c.error}
        </span>
      )}
      {c.warning > 0 && (
        <span
          className="text-status-starting flex items-center gap-0.5"
          title={severityLabel('warning')}
        >
          <SeverityIcon severity="warning" className="h-3 w-3" />
          {c.warning}
        </span>
      )}
    </span>
  );
}

function HeaderRow({ template, labels, min }: { template: string; labels: string[]; min: string }) {
  return (
    <div
      role="row"
      style={{ gridTemplateColumns: template }}
      className={cn(
        'border-border/70 text-fg-dim bg-surface/95 sticky top-0 z-10 grid h-8 items-center gap-x-3 border-b px-3 text-[10.5px] font-semibold tracking-[0.08em] uppercase',
        min,
      )}
    >
      {labels.map((h, i) => (
        <span key={`${h}${i}`} role="columnheader" className="truncate">
          {h}
        </span>
      ))}
    </div>
  );
}

function SectionTitle({ children, count }: { children: string; count?: number }) {
  return (
    <h3 className="text-fg-dim mb-2 flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.12em] uppercase">
      {children}
      {count !== undefined && (
        <span className="bg-surface-muted text-fg-dim rounded-full px-1.5 py-0.5 text-[10px] tracking-normal tabular-nums">
          {count}
        </span>
      )}
    </h3>
  );
}

interface ImplCard {
  id: string;
  impl: GatewayImplementation | null;
  name: string;
  controllers: string[];
  classes: KubeObject[];
  gateways: number;
  routes: number;
  extensions: ApiResourceInfo[];
  errors: number;
}

export function GatewayApiPage({
  clusterId,
  viewKey,
  isActive,
  apiResources,
}: {
  clusterId: string;
  viewKey: string;
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const namespaces = useSelectedNamespaces(clusterId, viewKey);
  const [tab, setTabState] = useState<Tab>(() => pickedTab.get(clusterId) ?? 'overview');
  const setTab = (t: Tab) => {
    pickedTab.set(clusterId, t);
    setTabState(t);
  };
  const [severity, setSeverity] = useState<'all' | IssueSeverity>('all');
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const filter = useWorkbenchStore((s) => s.filters[`${clusterId}|${VIEW.gatewayApi}`] ?? '');
  const setFilter = (text: string) =>
    useWorkbenchStore.getState().setFilter(clusterId, VIEW.gatewayApi, text);
  const selection = useWorkbenchStore((s) => s.selection[clusterId]?.[VIEW.gatewayApi] ?? null);
  const detection = detectGatewayApi(apiResources);
  const data = useGatewayData(clusterId, apiResources, namespaces, isActive && detection.served);

  const crdGvk = useMemo(() => toGvk(BUILTIN.CustomResourceDefinition), []);
  const bundle = usePolled(
    detection.served ? installedBundleKey(clusterId) : null,
    () =>
      ipc
        .resourceGet(clusterId, crdGvk, null, GATEWAY_KINDS.Gateway.key)
        .then((crd) => installedBundle(crd))
        .catch(() => null),
    5 * 60_000,
    isActive,
  );

  const inScope = (o: KubeObject) =>
    !namespaces.length || namespaces.includes(o.metadata.namespace ?? '');
  const q = filter.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);

  const gateways = useMemo(
    () =>
      data.gateways
        .filter(inScope)
        .filter((g) =>
          matches(
            `${g.metadata.namespace}/${g.metadata.name} ${gatewayClassName(g)} ${gatewayAddresses(g)
              .map((a) => a.value)
              .join(' ')} ${gatewayListeners(g)
              .map((l) => l.hostname ?? '')
              .join(' ')}`,
          ),
        )
        .sort(
          (a, b) =>
            (a.metadata.namespace ?? '').localeCompare(b.metadata.namespace ?? '') ||
            a.metadata.name.localeCompare(b.metadata.name),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.gateways, namespaces, q],
  );
  const routes = useMemo(
    () =>
      data.routes
        .filter(inScope)
        .filter((r) =>
          matches(
            `${r.kind} ${r.metadata.namespace}/${r.metadata.name} ${routeHostnames(r).join(' ')} ${routeParentRefs(
              r,
            )
              .map(parentLabel)
              .join(' ')} ${routeBackendRefs(r)
              .map((b) => b.name)
              .join(' ')}`,
          ),
        )
        .sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) ||
            (a.metadata.namespace ?? '').localeCompare(b.metadata.namespace ?? '') ||
            a.metadata.name.localeCompare(b.metadata.name),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.routes, namespaces, q],
  );
  const policies = useMemo(
    () =>
      [...data.backendTlsPolicies, ...data.envoyPolicies]
        .filter(inScope)
        .filter((p) =>
          matches(
            `${p.kind} ${p.metadata.namespace}/${p.metadata.name} ${policyTargets(p)
              .map((t) => t.name)
              .join(' ')}`,
          ),
        )
        .sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) ||
            (a.metadata.namespace ?? '').localeCompare(b.metadata.namespace ?? '') ||
            a.metadata.name.localeCompare(b.metadata.name),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.backendTlsPolicies, data.envoyPolicies, namespaces, q],
  );

  const issues = useMemo(
    () =>
      diagnoseAll(data.index, {
        classes: data.classes,
        gateways,
        routes,
        policies,
      }),
    [data.index, data.classes, gateways, routes, policies],
  );
  const issuesBySubject = useMemo(() => {
    const map = new Map<string, GatewayIssue[]>();
    for (const i of issues) {
      const key = subjectKey(i.subject);
      map.set(key, [...(map.get(key) ?? []), i]);
    }
    return map;
  }, [issues]);
  const issuesOf = (o: KubeObject) =>
    issuesBySubject.get(
      subjectKey({ kind: o.kind, name: o.metadata.name, namespace: o.metadata.namespace ?? null }),
    );
  const severityCounts = countBySeverity(issues);

  // Card counts cover the whole cluster, so they do not follow the filter.
  const gatewayErrors = useMemo(() => {
    const out = new Map<string, number>();
    for (const g of data.gateways)
      out.set(
        g.metadata.uid,
        diagnoseGateway(data.index, g).filter((i) => i.severity === 'error').length,
      );
    return out;
  }, [data.gateways, data.index]);
  const implementations = useMemo((): ImplCard[] => {
    const cards = new Map<string, ImplCard>();
    for (const cls of data.classes) {
      const controller = classController(cls);
      const impl = implementationFor(controller);
      const id = impl?.id ?? controllerDomain(controller);
      const card =
        cards.get(id) ??
        ({
          id,
          impl,
          name: impl?.name ?? controllerDomain(controller),
          controllers: [],
          classes: [],
          gateways: 0,
          routes: 0,
          extensions: impl ? servedExtensions(impl, apiResources) : [],
          errors: 0,
        } satisfies ImplCard);
      if (!card.controllers.includes(controller)) card.controllers.push(controller);
      card.classes.push(cls);
      cards.set(id, card);
    }
    for (const g of data.gateways) {
      const cls = data.index.classes.get(gatewayClassName(g));
      if (!cls) continue;
      const impl = implementationFor(classController(cls));
      const card = cards.get(impl?.id ?? controllerDomain(classController(cls)));
      if (!card) continue;
      card.gateways++;
      card.routes += attachedRouteCount(g);
      card.errors += gatewayErrors.get(g.metadata.uid) ?? 0;
    }
    // Implementations whose extension CRDs are served without a class yet.
    for (const impl of implementationsServing(apiResources))
      if (!cards.has(impl.id))
        cards.set(impl.id, {
          id: impl.id,
          impl,
          name: impl.name,
          controllers: [],
          classes: [],
          gateways: 0,
          routes: 0,
          extensions: servedExtensions(impl, apiResources),
          errors: 0,
        });
    return [...cards.values()].sort(
      (a, b) => b.gateways - a.gateways || a.name.localeCompare(b.name),
    );
  }, [data.classes, data.gateways, data.index, apiResources, gatewayErrors]);

  // Only the Topology tab draws it; a large cluster's build is not free.
  const topology = useMemo(
    () => (tab === 'topology' ? buildGatewayTopology(data.index, { namespaces }) : null),
    [tab, data.index, namespaces],
  );

  // Selection → docked details.
  const selectedGvk = selection ? gvkForKey(selection.key, apiResources) : null;
  const selectedObj = useMemo(() => {
    if (!selection || !selectedGvk) return null;
    const pools = [
      data.classes,
      data.gateways,
      data.routes,
      data.grants,
      data.backendTlsPolicies,
      data.envoyPolicies,
      data.envoyProxies,
    ];
    for (const list of pools)
      for (const o of list)
        if (
          o.kind === selectedGvk.kind &&
          o.metadata.name === selection.name &&
          (o.metadata.namespace ?? null) === (selection.namespace ?? null)
        )
          return o;
    return null;
  }, [selection, selectedGvk, data]);

  const navigate = (ref: ObjectRef) => {
    const gvk = resolveRef(ref.apiVersion, ref.kind, apiResources);
    if (!gvk) return;
    // Gateway API objects open beside the view; everything else in its own tab.
    const docked = ['gateway.networking.k8s.io', 'gateway.envoyproxy.io'].includes(gvk.group);
    if (docked)
      useWorkbenchStore.getState().select(clusterId, VIEW.gatewayApi, {
        key: kindKey(gvk),
        namespace: gvk.namespaced ? (ref.namespace ?? null) : null,
        name: ref.name,
      });
    else navigateTo(clusterId, gvk, ref.namespace ?? null, ref.name);
  };
  const open = (o: KubeObject) =>
    navigate({
      apiVersion: o.apiVersion,
      kind: o.kind,
      name: o.metadata.name,
      namespace: o.metadata.namespace ?? null,
    });
  const isSelected = (o: KubeObject) =>
    !!selection &&
    !!selectedGvk &&
    selectedGvk.kind === o.kind &&
    selection.name === o.metadata.name &&
    (selection.namespace ?? null) === (o.metadata.namespace ?? null);
  const linkCtx = { navigate } as Pick<ColumnContext, 'navigate'>;

  const tabs: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: 'overview', label: i18n.t('Overview') },
    { id: 'topology', label: i18n.t('Topology') },
    {
      id: 'diagnosis',
      label: i18n.t('Diagnosis'),
      badge: severityCounts.error + severityCounts.warning,
    },
    { id: 'policies', label: i18n.t('Policies'), badge: policies.length },
  ];
  const rowClass = (active: boolean) =>
    cn(
      'border-border/40 grid h-8 cursor-default items-center gap-x-3 border-b px-3 text-[12px] transition-colors',
      active ? 'bg-fg/7 shadow-[inset_2px_0_0_rgb(var(--accent))]' : 'hover:bg-fg/4',
    );

  const shownIssues = severity === 'all' ? issues : issues.filter((i) => i.severity === severity);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
            <Router className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-fg shrink-0 text-[13px] font-semibold">{i18n.t('Gateway API')}</h2>
          {bundle.data && (
            <span
              className="bg-surface-muted text-fg-dim shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px]"
              title={i18n.t('Installed CRD bundle')}
            >
              {bundle.data.version}
              {bundle.data.channel ? ` · ${bundle.data.channel}` : ''}
            </span>
          )}
          <span className="text-fg-dim hidden truncate text-[11px] @2xl:inline">
            {scopeLabel(namespaces)}
          </span>
          <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-1.5">
            {detection.served && (
              <>
                <NamespacePicker clusterId={clusterId} viewKey={viewKey} isActive={isActive} />
                <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-56 min-w-24 shrink items-center gap-2 rounded-lg border px-2.5">
                  <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
                    placeholder={i18n.t('Filter gateways and routes…')}
                    aria-label={i18n.t('Filter gateways and routes')}
                    className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
                  />
                  {filter && (
                    <button
                      type="button"
                      onClick={() => setFilter('')}
                      aria-label={i18n.t('Clear filter')}
                      className="text-fg-dim hover:text-fg"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <IconButton
                  label={i18n.t('Install or upgrade the Gateway API CRDs')}
                  icon={<ArrowUpCircle />}
                  onClick={() => setUpgradeOpen(true)}
                />
                <IconButton
                  label={i18n.t('Restart watches')}
                  icon={<RefreshCw />}
                  onClick={data.restart}
                />
              </>
            )}
          </div>
        </div>
        {detection.served && (
          <div className="border-border/60 flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
            <div
              className="flex items-center gap-0.5"
              role="radiogroup"
              aria-label={i18n.t('Section')}
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] whitespace-nowrap transition',
                    tab === t.id
                      ? 'bg-fg/7 text-fg font-medium'
                      : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
                  )}
                >
                  {t.label}
                  {!!t.badge && <span className="text-fg-dim tabular-nums">{t.badge}</span>}
                </button>
              ))}
            </div>
            {tab === 'diagnosis' && (
              <>
                <span className="bg-border/80 mx-1.5 h-4 w-px shrink-0" aria-hidden />
                <div
                  className="flex items-center gap-0.5"
                  role="radiogroup"
                  aria-label={i18n.t('Severity')}
                >
                  {(['all', 'error', 'warning', 'info'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={severity === s}
                      onClick={() => setSeverity(s)}
                      className={cn(
                        'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition',
                        severity === s
                          ? 'bg-fg/7 text-fg font-medium'
                          : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
                      )}
                    >
                      {s === 'all' ? i18n.t('Any severity') : severityLabel(s)}
                      <span className="text-fg-dim tabular-nums">
                        {s === 'all' ? issues.length : severityCounts[s]}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {data.errors.length > 0 && (
          <div className="border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg flex shrink-0 flex-col gap-0.5 border-b px-4 py-1.5 text-[11.5px]">
            {data.errors.map((w) => (
              <span key={w.gvk.kind} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0 break-words">
                  {w.gvk.kind}: {w.snap.error}
                </span>
              </span>
            ))}
          </div>
        )}
        {!apiResources ? (
          <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Discovering API resources…')}
          </div>
        ) : !detection.served ? (
          <GatewayApiMissing clusterId={clusterId} />
        ) : !data.synced && !data.gateways.length ? (
          <TableSkeleton rows={8} />
        ) : tab === 'topology' && topology ? (
          <GatewayTopologyCanvas
            topology={topology}
            activeId={selectedObj ? topologyId(selectedObj) : null}
            onOpen={(n: GwTopoNode) =>
              navigate({
                apiVersion: n.apiVersion,
                kind: n.kind,
                name: n.name,
                namespace: n.namespace,
              })
            }
            className="flex-1 p-3"
          />
        ) : (
          <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
            <div className="mx-auto max-w-7xl p-5">
              {tab === 'overview' && (
                <>
                  <SectionTitle count={implementations.length}>
                    {i18n.t('Implementations')}
                  </SectionTitle>
                  {implementations.length ? (
                    <div className="mb-6 grid gap-3 @3xl:grid-cols-2 @6xl:grid-cols-3">
                      {implementations.map((c) => (
                        <div
                          key={c.id}
                          className="border-border bg-surface-raised/40 rounded-lg border px-3.5 py-3"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-fg text-[12.5px] font-semibold">{c.name}</span>
                            {c.impl && (
                              <button
                                type="button"
                                onClick={() => void openExternal(c.impl!.docs)}
                                className="text-fg-dim hover:text-fg"
                                aria-label={i18n.t('Documentation')}
                                title={i18n.t('Documentation')}
                              >
                                <ExternalLink className="h-3 w-3" />
                              </button>
                            )}
                            {c.errors > 0 && (
                              <span className="text-status-error ml-auto flex items-center gap-1 text-[11px]">
                                <SeverityIcon severity="error" className="h-3 w-3" />
                                {c.errors}
                              </span>
                            )}
                          </div>
                          <p
                            className="text-fg-dim mt-0.5 truncate font-mono text-[10.5px]"
                            title={c.controllers.join('\n')}
                          >
                            {c.controllers.join(', ') || i18n.t('No GatewayClass yet')}
                          </p>
                          <div className="text-fg-muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
                            <span>
                              {i18n.plural('{count} class', '{count} classes', c.classes.length)}
                            </span>
                            <span>
                              {i18n.plural('{count} gateway', '{count} gateways', c.gateways)}
                            </span>
                            <span>
                              {i18n.plural(
                                '{count} attached route',
                                '{count} attached routes',
                                c.routes,
                              )}
                            </span>
                          </div>
                          {c.classes.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {c.classes.map((cls) => (
                                <button
                                  key={cls.metadata.uid}
                                  type="button"
                                  onClick={() => open(cls)}
                                  className="bg-fg/5 text-fg-muted ring-border/60 hover:text-fg rounded-md px-1.5 py-0.5 font-mono text-[10.5px] ring-1"
                                >
                                  {cls.metadata.name}
                                </button>
                              ))}
                            </div>
                          )}
                          {c.extensions.length > 0 && (
                            <div className="border-border/60 mt-2.5 border-t pt-2">
                              <p className="text-fg-dim mb-1 text-[10px] font-semibold tracking-[0.1em] uppercase">
                                {i18n.t('Policy and extension resources')}
                              </p>
                              <div className="flex flex-wrap gap-1">
                                {c.extensions.map((r) => {
                                  const Icon = kindIcon(kindKey(r));
                                  return (
                                    <button
                                      key={kindKey(r)}
                                      type="button"
                                      onClick={() => navigateTo(clusterId, gvkFromApiResource(r))}
                                      title={`${r.kind}.${r.group}`}
                                      className="text-fg-muted hover:bg-fg/5 hover:text-fg inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]"
                                    >
                                      <Icon className="h-3 w-3" />
                                      {r.kind}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-fg-dim mb-6 text-[12px]">
                      {i18n.t(
                        'No GatewayClass yet. Install an implementation (Envoy Gateway, Istio, Cilium, NGINX Gateway Fabric…) to serve Gateways.',
                      )}
                    </p>
                  )}

                  <SectionTitle count={gateways.length}>{i18n.t('Gateways')}</SectionTitle>
                  <div
                    role="table"
                    aria-label={i18n.t('Gateways')}
                    className="border-border/60 mb-6 overflow-x-auto rounded-lg border"
                  >
                    <HeaderRow
                      template={TEMPLATE_GW}
                      min="min-w-[920px]"
                      labels={[
                        i18n.t('Name'),
                        i18n.t('Class'),
                        i18n.t('Implementation'),
                        i18n.t('Addresses'),
                        i18n.t('Listeners'),
                        i18n.t('Routes'),
                        i18n.t('Status'),
                        i18n.t('Problems'),
                      ]}
                    />
                    {gateways.length ? (
                      gateways.slice(0, ROW_LIMIT).map((g) => {
                        const cls = data.index.classes.get(gatewayClassName(g));
                        const bucket = gatewayBucket(g);
                        return (
                          <div
                            key={g.metadata.uid}
                            role="row"
                            onClick={() => open(g)}
                            style={{ gridTemplateColumns: TEMPLATE_GW }}
                            className={cn(rowClass(isSelected(g)), 'min-w-[920px]')}
                          >
                            <span
                              role="cell"
                              className="text-fg truncate"
                              title={`${g.metadata.namespace}/${g.metadata.name}`}
                            >
                              <span className="text-fg-dim">{g.metadata.namespace}/</span>
                              {g.metadata.name}
                            </span>
                            <span role="cell" className="text-fg-muted truncate">
                              {gatewayClassName(g)}
                            </span>
                            <span role="cell" className="text-fg-muted truncate">
                              {cls
                                ? (implementationFor(classController(cls))?.name ??
                                  controllerDomain(classController(cls)))
                                : '—'}
                            </span>
                            <span role="cell" className="min-w-0">
                              <Chips values={gatewayAddresses(g).map((a) => a.value)} max={1} />
                            </span>
                            <span role="cell" className="min-w-0">
                              <Chips
                                values={gatewayListeners(g).map((l) => `${l.protocol}:${l.port}`)}
                                max={3}
                              />
                            </span>
                            <span role="cell" className="text-fg-muted text-right tabular-nums">
                              {attachedRouteCount(g)}
                            </span>
                            <span
                              role="cell"
                              className={cn(
                                'truncate font-medium',
                                toneText(GATEWAY_BUCKET_TONE[bucket]),
                              )}
                            >
                              {gatewayBucketLabel(bucket)}
                            </span>
                            <span role="cell">
                              <ProblemCell issues={issuesOf(g)} />
                            </span>
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-fg-dim px-3 py-3 text-[12px]">
                        {data.gateways.length
                          ? i18n.t('Nothing matches the current filters.')
                          : i18n.t('No Gateways yet.')}
                      </p>
                    )}
                    <MoreRows shown={ROW_LIMIT} total={gateways.length} />
                  </div>

                  <SectionTitle count={routes.length}>{i18n.t('Routes')}</SectionTitle>
                  <div
                    role="table"
                    aria-label={i18n.t('Routes')}
                    className="border-border/60 overflow-x-auto rounded-lg border"
                  >
                    <HeaderRow
                      template={TEMPLATE_ROUTE}
                      min="min-w-[880px]"
                      labels={[
                        i18n.t('Kind'),
                        i18n.t('Name'),
                        i18n.t('Hostnames'),
                        i18n.t('Parents'),
                        i18n.t('Backends'),
                        i18n.t('Status'),
                        i18n.t('Problems'),
                      ]}
                    />
                    {routes.length ? (
                      routes.slice(0, ROW_LIMIT).map((r) => {
                        const s = routeSummary(r);
                        return (
                          <div
                            key={r.metadata.uid}
                            role="row"
                            onClick={() => open(r)}
                            style={{ gridTemplateColumns: TEMPLATE_ROUTE }}
                            className={cn(rowClass(isSelected(r)), 'min-w-[880px]')}
                          >
                            <span role="cell" className="text-fg-muted truncate">
                              {r.kind}
                            </span>
                            <span
                              role="cell"
                              className="text-fg truncate"
                              title={`${r.metadata.namespace}/${r.metadata.name}`}
                            >
                              <span className="text-fg-dim">{r.metadata.namespace}/</span>
                              {r.metadata.name}
                            </span>
                            <span role="cell" className="min-w-0">
                              <Chips values={routeHostnames(r)} max={1} />
                            </span>
                            <span role="cell" className="min-w-0">
                              <Chips values={routeParentRefs(r).map(parentLabel)} max={1} />
                            </span>
                            <span role="cell" className="min-w-0">
                              <Chips
                                values={[
                                  ...new Set(
                                    routeBackendRefs(r)
                                      .filter((b) => !b.mirror)
                                      .map(
                                        (b) => `${b.name}${b.port !== null ? `:${b.port}` : ''}`,
                                      ),
                                  ),
                                ]}
                                max={2}
                              />
                            </span>
                            <span
                              role="cell"
                              className={cn(
                                'truncate font-medium',
                                toneText(ROUTE_BUCKET_TONE[s.bucket]),
                              )}
                              title={i18n.t('{accepted} of {parents} parents accepted', {
                                accepted: s.accepted,
                                parents: s.parents,
                              })}
                            >
                              {routeBucketLabel(s.bucket)}
                            </span>
                            <span role="cell">
                              <ProblemCell issues={issuesOf(r)} />
                            </span>
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-fg-dim px-3 py-3 text-[12px]">
                        {data.routes.length
                          ? i18n.t('Nothing matches the current filters.')
                          : i18n.t('No routes yet.')}
                      </p>
                    )}
                    <MoreRows shown={ROW_LIMIT} total={routes.length} />
                  </div>
                </>
              )}
              {tab === 'diagnosis' && (
                <>
                  <IssueList
                    issues={shownIssues.slice(0, ISSUE_LIMIT)}
                    ctx={linkCtx}
                    showSubject
                    empty={i18n.t('No problems found in the selected namespaces.')}
                  />
                  <MoreRows shown={ISSUE_LIMIT} total={shownIssues.length} />
                </>
              )}
              {tab === 'policies' && (
                <div
                  role="table"
                  aria-label={i18n.t('Policies')}
                  className="border-border/60 overflow-x-auto rounded-lg border"
                >
                  <HeaderRow
                    template={TEMPLATE_POLICY}
                    min="min-w-[820px]"
                    labels={[
                      i18n.t('Kind'),
                      i18n.t('Name'),
                      i18n.t('Targets'),
                      i18n.t('Configures'),
                      i18n.t('Status'),
                      i18n.t('Problems'),
                    ]}
                  />
                  {policies.length ? (
                    policies.slice(0, ROW_LIMIT).map((p) => {
                      const bucket = policyBucket(p);
                      return (
                        <div
                          key={p.metadata.uid}
                          role="row"
                          onClick={() => open(p)}
                          style={{ gridTemplateColumns: TEMPLATE_POLICY }}
                          className={cn(rowClass(isSelected(p)), 'min-w-[820px]')}
                        >
                          <span role="cell" className="text-fg-muted truncate">
                            {p.kind}
                          </span>
                          <span role="cell" className="text-fg truncate">
                            <span className="text-fg-dim">{p.metadata.namespace}/</span>
                            {p.metadata.name}
                          </span>
                          <span role="cell" className="min-w-0">
                            <Chips
                              values={[
                                ...policyTargets(p).map(
                                  (t) =>
                                    `${t.kind}/${t.name}${t.sectionName ? `:${t.sectionName}` : ''}`,
                                ),
                                ...policySelectors(p),
                              ]}
                              max={2}
                            />
                          </span>
                          <span role="cell" className="min-w-0">
                            <Chips values={policyFeatures(p)} max={3} />
                          </span>
                          <span
                            role="cell"
                            className={cn(
                              'truncate font-medium',
                              toneText(POLICY_BUCKET_TONE[bucket]),
                            )}
                          >
                            {policyBucketLabel(bucket)}
                          </span>
                          <span role="cell">
                            <ProblemCell issues={issuesOf(p)} />
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-fg-dim px-3 py-3 text-[12px]">
                      {detection.envoy || detection.backendTls
                        ? i18n.t('No policies in the selected namespaces.')
                        : i18n.t(
                            'Neither BackendTLSPolicy nor Envoy Gateway policies are served by this cluster.',
                          )}
                    </p>
                  )}
                  <MoreRows shown={ROW_LIMIT} total={policies.length} />
                </div>
              )}
            </div>
          </div>
        )}
        <div className="border-border/60 text-fg-dim flex h-7 shrink-0 items-center gap-2 border-t px-4 text-[11px] tabular-nums">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              data.errors.length
                ? 'bg-status-error'
                : data.synced && isActive
                  ? 'bg-status-running animate-breathe'
                  : 'bg-fg-dim/50',
            )}
          />
          <span>
            {!isActive
              ? i18n.t('Paused')
              : data.synced || !detection.served
                ? i18n.t('Live')
                : i18n.t('Loading…')}
          </span>
          {detection.served && (
            <>
              <span className="text-fg-dim/40">·</span>
              <span>{i18n.plural('{count} gateway', '{count} gateways', gateways.length)}</span>
              <span className="text-fg-dim/40">·</span>
              <span>{i18n.plural('{count} route', '{count} routes', routes.length)}</span>
              {severityCounts.error > 0 && (
                <>
                  <span className="text-fg-dim/40">·</span>
                  <span className="text-status-error">
                    {i18n.plural('{count} error', '{count} errors', severityCounts.error)}
                  </span>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {selection && selectedGvk && (
        <DetailsPanel
          clusterId={clusterId}
          gvk={selectedGvk}
          kindKey={selection.key}
          selection={selection}
          liveObject={selectedObj}
          isActive={isActive}
          apiResources={apiResources}
          viewKey={VIEW.gatewayApi}
        />
      )}
      {upgradeOpen && (
        <Dialog
          title={i18n.t('Gateway API CRDs')}
          subtitle={bundle.data ? `${bundle.data.version} · ${bundle.data.channel}` : undefined}
          onClose={() => setUpgradeOpen(false)}
          size="md"
          footer={
            <Button size="sm" variant="secondary" onClick={() => setUpgradeOpen(false)}>
              {i18n.t('Close')}
            </Button>
          }
        >
          <GatewayCrdsInstall clusterId={clusterId} installed={bundle.data ?? null} />
        </Dialog>
      )}
    </div>
  );
}
