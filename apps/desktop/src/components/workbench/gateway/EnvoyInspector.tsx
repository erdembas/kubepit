import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { Tabs } from '@/components/ui/Tabs';
import { ipc } from '@/lib/ipc';
import type { ObjectRef } from '@/lib/kube/columns';
import {
  ENVOY_ADMIN_PORT,
  GATEWAY_GROUP,
  filterStats,
  parseClusters,
  parseServerInfo,
  parseStats,
  prettyBody,
  statHighlights,
  summarizeConfigDump,
  xdsOrigin,
} from '@/lib/kube/gateway';
import { cn } from '@/lib/cn';
import type { ClusterId, EnvoyAdminEndpoint, EnvoyAdminResponse } from '@/types';
import { CodeBlock, MiniTable, MonoText, Row, Rows, Section } from '../details/primitives';
import { errorText } from '../util';

/**
 * Read-only Envoy admin inspection of one proxy pod: each tab is one GET
 * of a fixed admin endpoint over an in-process port-forward (`envoy_admin`;
 * Envoy's mutating endpoints are unreachable). Names Envoy Gateway
 * generates from routes and gateways link back to those objects.
 */

type TabKey = 'summary' | 'listeners' | 'routes' | 'clusters' | 'stats' | 'raw';

/** Characters of the raw config dump drawn at once. */
const RAW_LIMIT = 1_000_000;

const TAB_ENDPOINT: Record<TabKey, EnvoyAdminEndpoint> = {
  summary: 'server_info',
  listeners: 'config_dump',
  routes: 'config_dump',
  clusters: 'clusters',
  stats: 'stats',
  raw: 'config_dump',
};

interface Fetched {
  loading: boolean;
  response: EnvoyAdminResponse | null;
  error: string | null;
}

function useAdmin(clusterId: ClusterId, namespace: string, pod: string, port: number) {
  const [state, setState] = useState<Partial<Record<EnvoyAdminEndpoint, Fetched>>>({});
  const load = useCallback(
    (endpoint: EnvoyAdminEndpoint) => {
      setState((s) => ({
        ...s,
        [endpoint]: { loading: true, response: s[endpoint]?.response ?? null, error: null },
      }));
      ipc
        .envoyAdmin(clusterId, namespace, pod, port, endpoint)
        .then((response) =>
          setState((s) => ({ ...s, [endpoint]: { loading: false, response, error: null } })),
        )
        .catch((e: unknown) =>
          setState((s) => ({
            ...s,
            [endpoint]: { loading: false, response: null, error: errorText(e) },
          })),
        );
    },
    [clusterId, namespace, pod, port],
  );
  return { state, load };
}

function OriginLink({ name, onOpen }: { name: string; onOpen: (ref: ObjectRef) => void }) {
  const origin = xdsOrigin(name);
  if (!origin) return <MonoText>{name}</MonoText>;
  return (
    <button
      type="button"
      className="text-accent hover:text-accent-hover min-w-0 text-left font-mono text-[11px] break-all hover:underline"
      title={`${origin.kind} ${origin.namespace}/${origin.name}`}
      onClick={() =>
        onOpen({
          apiVersion: `${GATEWAY_GROUP}/v1`,
          kind: origin.kind,
          namespace: origin.namespace,
          name: origin.name,
        })
      }
    >
      {name}
    </button>
  );
}

function Status({ fetched }: { fetched: Fetched | undefined }) {
  i18n.useLocale();
  if (!fetched || (fetched.loading && !fetched.response))
    return (
      <p className="text-fg-muted flex items-center gap-2 py-6 text-[12px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {i18n.t('Asking Envoy…')}
      </p>
    );
  if (fetched.error)
    return (
      <div className="border-status-error/30 bg-status-error/[0.06] rounded-lg border px-3 py-2">
        <p className="text-status-error flex items-center gap-1.5 text-[12px] font-semibold">
          <TriangleAlert className="h-3.5 w-3.5" />
          {i18n.t('Could not reach the Envoy admin interface')}
        </p>
        <pre className="text-status-error/90 mt-1 font-mono text-[11px] break-words whitespace-pre-wrap">
          {fetched.error}
        </pre>
      </div>
    );
  if (fetched.response && (fetched.response.status < 200 || fetched.response.status >= 300))
    return (
      <p className="text-status-error text-[12px]">
        {i18n.t('Envoy answered HTTP {status}', { status: fetched.response.status })}
      </p>
    );
  return null;
}

export function EnvoyInspector({
  clusterId,
  namespace,
  pod,
  port = ENVOY_ADMIN_PORT,
  onOpen,
  onClose,
}: {
  clusterId: ClusterId;
  namespace: string;
  pod: string;
  port?: number;
  /** Open a Gateway API object the proxy configuration was generated from. */
  onOpen: (ref: ObjectRef) => void;
  onClose: () => void;
}) {
  i18n.useLocale();
  const [tab, setTab] = useState<TabKey>('summary');
  const [query, setQuery] = useState('');
  const { state, load } = useAdmin(clusterId, namespace, pod, port);
  const endpoint = TAB_ENDPOINT[tab];
  const fetched = state[endpoint];
  const needsStats = tab === 'summary' || tab === 'stats';

  useEffect(() => {
    if (!state[endpoint]) load(endpoint);
    if (needsStats && !state.stats) load('stats');
    // Each endpoint loads once; Refresh reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, needsStats]);

  const ok = (f: Fetched | undefined) =>
    f?.response && f.response.status >= 200 && f.response.status < 300 ? f.response.body : null;
  const dump = useMemo(() => {
    const body = ok(state.config_dump);
    return body ? summarizeConfigDump(body) : null;
  }, [state.config_dump]);
  const info = useMemo(() => {
    const body = ok(state.server_info);
    return body ? parseServerInfo(body) : null;
  }, [state.server_info]);
  const stats = useMemo(() => {
    const body = ok(state.stats);
    return body ? parseStats(body) : null;
  }, [state.stats]);
  const clusters = useMemo(() => {
    const body = ok(state.clusters);
    return body ? parseClusters(body) : null;
  }, [state.clusters]);
  // Pretty-printing a large dump is not free: only for its own tab, and capped on screen.
  const raw = useMemo(() => {
    const body = tab === 'raw' ? ok(state.config_dump) : null;
    return body ? prettyBody(body) : '';
  }, [tab, state.config_dump]);
  const rawText = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? raw
          .split('\n')
          .filter((l) => l.toLowerCase().includes(q))
          .join('\n')
      : raw;
  }, [raw, query]);
  const q = query.trim().toLowerCase();
  const highlights = stats ? statHighlights(stats) : null;

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'summary', label: i18n.t('Summary') },
    { key: 'listeners', label: i18n.t('Listeners') },
    { key: 'routes', label: i18n.t('Routes') },
    { key: 'clusters', label: i18n.t('Clusters') },
    { key: 'stats', label: i18n.t('Stats') },
    { key: 'raw', label: i18n.t('Config dump') },
  ];
  const filterable = tab !== 'summary';
  const number = (n: number | null) => (n === null ? '—' : i18n.number(n));

  return (
    <Dialog
      title={i18n.t('Envoy proxy {pod}', { pod })}
      subtitle={`${namespace}/${pod} · 127.0.0.1:${port}`}
      onClose={onClose}
      size="xl"
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-border/60 flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        <div className="ml-auto flex items-center gap-1.5">
          {filterable && (
            <div className="bg-surface border-border focus-within:border-accent/50 flex h-7 w-56 items-center gap-2 rounded-lg border px-2.5">
              <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={i18n.t('Filter…')}
                aria-label={i18n.t('Filter')}
                className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none"
              />
            </div>
          )}
          <IconButton
            label={i18n.t('Refresh')}
            icon={<RefreshCw className={cn(fetched?.loading && 'animate-spin')} />}
            onClick={() => {
              load(endpoint);
              if (needsStats && endpoint !== 'stats') load('stats');
            }}
          />
        </div>
      </div>
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
        <div className="px-0 py-0">
          {(!ok(fetched) || fetched?.loading) && (
            <div className="px-4 pt-4">
              <Status fetched={fetched} />
            </div>
          )}
          {tab === 'summary' && info && (
            <>
              <Section title={i18n.t('Server')}>
                <Rows>
                  <Row label={i18n.t('State')}>{info.state}</Row>
                  <Row label={i18n.t('Version')}>
                    <MonoText>{info.version}</MonoText>
                  </Row>
                  <Row label={i18n.t('Uptime')}>
                    {info.uptimeSeconds !== null
                      ? i18n.t('{hours} h {minutes} min', {
                          hours: Math.floor(info.uptimeSeconds / 3600),
                          minutes: Math.floor((info.uptimeSeconds % 3600) / 60),
                        })
                      : null}
                  </Row>
                  <Row label={i18n.t('Node')}>
                    <MonoText>{info.nodeId}</MonoText>
                  </Row>
                  <Row label={i18n.t('Cluster')}>
                    <MonoText>{info.cluster}</MonoText>
                  </Row>
                </Rows>
              </Section>
              {highlights && (
                <Section title={i18n.t('Traffic since start')}>
                  <Rows>
                    <Row label={i18n.t('Downstream requests')}>
                      {number(highlights.downstreamRequests)}
                    </Row>
                    <Row label={i18n.t('Downstream 5xx')}>
                      <span className={cn(highlights.downstream5xx > 0 && 'text-status-error')}>
                        {number(highlights.downstream5xx)}
                      </span>
                    </Row>
                    <Row label={i18n.t('Active requests')}>
                      {number(highlights.downstreamActive)}
                    </Row>
                    <Row label={i18n.t('Upstream requests')}>
                      {number(highlights.upstreamRequests)}
                    </Row>
                    <Row label={i18n.t('Upstream 5xx')}>
                      <span className={cn(highlights.upstream5xx > 0 && 'text-status-error')}>
                        {number(highlights.upstream5xx)}
                      </span>
                    </Row>
                    <Row label={i18n.t('Active clusters')}>{number(highlights.clustersActive)}</Row>
                    <Row label={i18n.t('Active listeners')}>
                      {number(highlights.listenersActive)}
                    </Row>
                  </Rows>
                </Section>
              )}
            </>
          )}
          {tab === 'listeners' && dump && (
            <Section
              title={i18n.plural('{count} listener', '{count} listeners', dump.listeners.length)}
            >
              <MiniTable
                rows={dump.listeners.filter(
                  (l) => !q || `${l.name} ${l.address}`.toLowerCase().includes(q),
                )}
                rowKey={(l) => `${l.name}|${l.address}`}
                columns={[
                  {
                    label: i18n.t('Name'),
                    cell: (l) => <OriginLink name={l.name} onOpen={onOpen} />,
                  },
                  { label: i18n.t('Address'), className: 'font-mono', cell: (l) => l.address },
                  {
                    label: i18n.t('Filter chains'),
                    cell: (l) => (
                      <span className="flex flex-col gap-0.5">
                        {l.chains.map((c, i) => (
                          <span key={i} className="font-mono text-[11px]">
                            {c.serverNames.length ? `${c.serverNames.join(', ')} → ` : ''}
                            {c.filters.join(', ')}
                          </span>
                        ))}
                      </span>
                    ),
                  },
                  { label: i18n.t('State'), cell: (l) => l.state },
                ]}
              />
            </Section>
          )}
          {tab === 'routes' && dump && (
            <Section
              title={i18n.plural(
                '{count} virtual host',
                '{count} virtual hosts',
                dump.virtualHosts.length,
              )}
            >
              <div className="flex flex-col gap-3">
                {dump.virtualHosts
                  .filter(
                    (vh) =>
                      !q ||
                      `${vh.name} ${vh.domains.join(' ')} ${vh.routes.map((r) => `${r.name} ${r.action}`).join(' ')}`
                        .toLowerCase()
                        .includes(q),
                  )
                  .map((vh) => (
                    <div key={`${vh.routeConfig}|${vh.name}`}>
                      <p className="text-fg mb-1 flex flex-wrap items-baseline gap-2 text-[12px]">
                        <OriginLink name={vh.routeConfig} onOpen={onOpen} />
                        <span className="text-fg-muted font-mono text-[11px]">
                          {vh.domains.join(', ')}
                        </span>
                      </p>
                      <MiniTable
                        rows={vh.routes}
                        rowKey={(r, i) => `${r.name}|${i}`}
                        columns={[
                          {
                            label: i18n.t('Match'),
                            className: 'font-mono',
                            cell: (r) => r.match || '—',
                          },
                          {
                            label: i18n.t('Action'),
                            className: 'font-mono break-all',
                            cell: (r) => r.action || '—',
                          },
                          {
                            label: i18n.t('Route'),
                            cell: (r) =>
                              r.name ? <OriginLink name={r.name} onOpen={onOpen} /> : '—',
                          },
                        ]}
                      />
                    </div>
                  ))}
              </div>
            </Section>
          )}
          {tab === 'clusters' && clusters && (
            <Section title={i18n.plural('{count} cluster', '{count} clusters', clusters.length)}>
              <MiniTable
                rows={clusters.filter((c) => !q || c.name.toLowerCase().includes(q))}
                rowKey={(c) => c.name}
                rowClass={(c) =>
                  c.hosts.length && c.healthy < c.hosts.length ? 'bg-status-error/[0.04]' : ''
                }
                columns={[
                  {
                    label: i18n.t('Cluster'),
                    cell: (c) => <OriginLink name={c.name} onOpen={onOpen} />,
                  },
                  {
                    label: i18n.t('Healthy'),
                    className: 'whitespace-nowrap tabular-nums',
                    cell: (c) => (
                      <span className={cn(c.healthy < c.hosts.length && 'text-status-error')}>
                        {c.healthy}/{c.hosts.length}
                      </span>
                    ),
                  },
                  {
                    label: i18n.t('Endpoints'),
                    cell: (c) => (
                      <span className="flex flex-col gap-0.5">
                        {c.hosts.map((h) => (
                          <span key={h.address} className="font-mono text-[11px]">
                            {h.address}{' '}
                            <span
                              className={cn(
                                h.health === 'HEALTHY'
                                  ? 'text-status-running'
                                  : 'text-status-error',
                              )}
                            >
                              {h.health}
                            </span>{' '}
                            <span className="text-fg-dim">
                              {i18n.t('{requests} req, {errors} err', {
                                requests: h.requests,
                                errors: h.errors,
                              })}
                            </span>
                          </span>
                        ))}
                      </span>
                    ),
                  },
                ]}
              />
            </Section>
          )}
          {tab === 'stats' && stats && (
            <Section title={i18n.plural('{count} stat', '{count} stats', stats.length)}>
              <MiniTable
                rows={filterStats(stats, query).slice(0, 500)}
                rowKey={(s) => s.name}
                columns={[
                  { label: i18n.t('Name'), className: 'font-mono break-all', cell: (s) => s.name },
                  {
                    label: i18n.t('Value'),
                    className: 'text-right tabular-nums',
                    cell: (s) => i18n.number(s.value),
                  },
                ]}
              />
              {filterStats(stats, query).length > 500 && (
                <p className="text-fg-dim mt-2 text-[11px]">
                  {i18n.t('Showing the first 500; narrow the filter to see more.')}
                </p>
              )}
            </Section>
          )}
          {tab === 'raw' && raw && (
            <Section title={i18n.t('Config dump')}>
              {dump && (
                <p className="text-fg-dim mb-2 text-[11px]">
                  {i18n.t(
                    '{listeners} listeners, {hosts} virtual hosts, {clusters} clusters, {secrets} secrets (names only)',
                    {
                      listeners: dump.listeners.length,
                      hosts: dump.virtualHosts.length,
                      clusters: dump.clusters.length,
                      secrets: dump.secrets.length,
                    },
                  )}
                </p>
              )}
              <CodeBlock text={rawText.slice(0, RAW_LIMIT)} maxHeight="max-h-[60vh]" />
              {rawText.length > RAW_LIMIT && (
                <p className="text-fg-dim mt-2 text-[11px]">
                  {i18n.t('Showing the first million characters; filter to find the rest.')}
                </p>
              )}
            </Section>
          )}
        </div>
      </div>
    </Dialog>
  );
}
