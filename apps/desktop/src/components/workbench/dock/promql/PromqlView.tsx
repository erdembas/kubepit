import { AssistantQueryActions } from '../AssistantQueryActions';
import * as i18n from '@/i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Flame, History, Loader2, Play, RefreshCw, Settings2 } from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import {
  PROMQL_EXAMPLES,
  PROM_RANGES,
  PROM_RANGE_MS,
  formatSi,
  kindLabel,
  loadQueryHistory,
  promRangeLabel,
  promRangeTitle,
  rangeEndingNow,
  rememberQuery,
  seriesColor,
  seriesLabel,
  serviceAddress,
  serviceLabel,
  toSeriesPoints,
  type PromRangeKey,
} from '@/lib/prometheus';
import { clusterMatchers } from '@/lib/prometheusAccess';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ClusterId, PromQueryResult } from '@/types';
import { ProxyForbiddenNotice } from '../../common/ProxyForbiddenNotice';
import { MultiSeriesChart, type MultiSeries } from '../../overview/MultiSeriesChart';
import { redetectPrometheus, usePrometheusStatus } from '../../metrics/usePrometheus';
import { DockStripAction } from '../DockStripAction';

type PromqlTab = Extract<DockTab, { kind: 'promql' }>;

/** Series drawn at most (the backend returns up to 200). */
const MAX_DRAWN = 60;

/** Height of an element that may mount later (callback ref). */
function useElementHeight<T extends HTMLElement>() {
  const [node, setNode] = useState<T | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!node) return;
    setHeight(node.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      setHeight(Math.round(entry?.contentRect.height ?? 0));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, height] as const;
}

function lastPoint(points: readonly [number, number][]) {
  return points.length ? points[points.length - 1]![1] : null;
}

/**
 * Ad-hoc PromQL against the cluster's Prometheus: an expression input
 * (Enter runs, Shift+Enter adds a line), a range picker, an SVG chart of
 * every returned series and a legend to hide or highlight them.
 */
export function PromqlView({
  clusterId,
  tab,
  active,
}: {
  clusterId: ClusterId;
  tab: PromqlTab;
  active: boolean;
}) {
  i18n.useLocale();
  const status = usePrometheusStatus(clusterId, active);
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const updateTab = useDockStore((s) => s.updateTab);
  const [draft, setDraft] = useState(tab.query);
  const [result, setResult] = useState<PromQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [redetecting, setRedetecting] = useState(false);
  const [chartRef, chartHeight] = useElementHeight<HTMLDivElement>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const runId = useRef(0);
  const available = status.data?.state === 'available';

  const run = useCallback(
    async (query: string, range: PromRangeKey) => {
      const q = query.trim();
      if (!q) return;
      const id = ++runId.current;
      setLoading(true);
      setError(null);
      updateTab(clusterId, tab.id, { query: q, range });
      try {
        const next = await ipc.prometheusQueryRange(clusterId, q, rangeEndingNow(range));
        if (id !== runId.current) return;
        setResult(next);
        setHidden(new Set());
        rememberQuery(q);
      } catch (e) {
        if (id !== runId.current) return;
        setResult(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (id === runId.current) setLoading(false);
      }
    },
    [clusterId, tab.id, updateTab],
  );

  // A tab opened with a query (from a chart) runs it once Prometheus answers.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !available || !tab.query.trim()) return;
    autoRan.current = true;
    void run(tab.query, tab.range);
  }, [available, tab.query, tab.range, run]);

  const setRange = (range: PromRangeKey) => {
    updateTab(clusterId, tab.id, { range });
    if (draft.trim()) void run(draft, range);
  };

  const series = useMemo<MultiSeries[]>(
    () =>
      (result?.series ?? []).slice(0, MAX_DRAWN).map((s, i) => ({
        key: String(i),
        label: seriesLabel(s.labels),
        points: toSeriesPoints(s.points),
        color: seriesColor(i),
      })),
    [result],
  );
  const shown = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);
  const to = result?.end ?? Date.now();
  const from = result ? result.start : to - PROM_RANGE_MS[tab.range];

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const historyItems = (): FileContextMenuEntry[] => {
    const short = (q: string) => (q.length > 72 ? `${q.slice(0, 71)}…` : q);
    const pick = (q: string) => () => {
      setDraft(q);
      void run(q, tab.range);
      inputRef.current?.focus();
    };
    const recent = loadQueryHistory();
    return [
      ...recent.map((q, i) => ({
        id: `recent-${i}`,
        label: short(q),
        title: q,
        icon: <History size={12} />,
        onClick: pick(q),
      })),
      ...(recent.length ? [{ id: 'sep', separator: true as const }] : []),
      ...PROMQL_EXAMPLES.map((q, i) => ({
        id: `example-${i}`,
        label: short(q),
        title: q,
        icon: <Flame size={12} />,
        onClick: pick(q),
      })),
    ];
  };

  const settings = () =>
    cluster && useAppStore.getState().openClusterEditor({ mode: 'edit', cluster });
  const redetect = () => {
    setRedetecting(true);
    void redetectPrometheus(clusterId)
      .catch(() => undefined)
      .finally(() => setRedetecting(false));
  };

  const st = status.data;
  const service = st?.service ?? null;
  // Presets get the cluster selector of a shared Prometheus; typed PromQL does not.
  const matchers = clusterMatchers(cluster?.prometheus_access);

  let overlay: React.ReactNode = null;
  if (loading && !result)
    overlay = (
      <span className="text-fg-dim flex items-center gap-1.5 text-[11px]">
        <Loader2 className="h-3 w-3 animate-spin" />
        {i18n.t('Running query…')}
      </span>
    );
  else if (error)
    overlay = (
      <span className="text-status-error max-w-2xl font-mono text-[11px] break-words whitespace-pre-wrap">
        {error}
      </span>
    );
  else if (!result)
    overlay = (
      <span className="text-fg-dim text-[11.5px]">
        {i18n.t('Enter a PromQL expression and press Enter.')}
      </span>
    );
  else if (result.result_type === 'string')
    overlay = (
      <span className="text-fg-dim text-[11.5px]">
        {i18n.t('This query returns a string, which cannot be charted.')}
      </span>
    );
  else if (!series.some((s) => s.points.length))
    overlay = (
      <span className="text-fg-dim text-[11.5px]">
        {i18n.t('No series matched in this range.')}
      </span>
    );

  if (st && !available)
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Flame className="text-fg-dim h-5 w-5" />
        {st.state === 'forbidden' ? (
          <ProxyForbiddenNotice
            what="Prometheus"
            namespace={st.service?.namespace ?? '—'}
            message={st.error}
          />
        ) : (
          <>
            <p className="text-fg text-[12.5px] font-medium">
              {st.state === 'off'
                ? i18n.t('Prometheus is turned off for this cluster.')
                : st.state === 'unreachable'
                  ? i18n.t('Prometheus does not answer')
                  : i18n.t('No Prometheus found on this cluster')}
            </p>
            <p className="text-fg-dim max-w-lg text-[11.5px]">
              {st.state === 'unreachable' && st.error
                ? st.error
                : i18n.t(
                    'Kubepit looks for kube-prometheus-stack, the Prometheus chart, Thanos, VictoriaMetrics, Mimir and OpenShift monitoring, and queries them through the API server. You can also set the service in the cluster settings.',
                  )}
            </p>
          </>
        )}
        <div className="mt-1 flex gap-1.5">
          {st.state !== 'off' && (
            <button
              type="button"
              onClick={redetect}
              disabled={redetecting}
              className="btn-chrome rounded-app-sm flex h-6 items-center gap-1.5 px-2.5 text-[11px] font-medium"
            >
              <RefreshCw className={cn('h-3 w-3', redetecting && 'animate-spin')} />
              {i18n.t('Detect again')}
            </button>
          )}
          {cluster && (
            <button
              type="button"
              onClick={settings}
              className="btn-chrome rounded-app-sm flex h-6 items-center gap-1.5 px-2.5 text-[11px] font-medium"
            >
              <Settings2 className="h-3 w-3" />
              {i18n.t('Prometheus settings')}
            </button>
          )}
        </div>
      </div>
    );

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="border-border/60 flex items-start gap-2 border-b px-3 py-2">
        <Flame className="text-accent/80 mt-1.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void run(draft, tab.range);
            }
          }}
          rows={Math.min(5, Math.max(1, draft.split('\n').length))}
          spellCheck={false}
          autoFocus={active && !tab.query}
          placeholder={'sum by (namespace) (rate(container_cpu_usage_seconds_total[5m]))'}
          aria-label={i18n.t('PromQL expression')}
          className="border-border bg-surface-raised text-fg placeholder:text-fg-dim focus:border-accent rounded-app-sm min-w-0 flex-1 resize-none border px-2 py-1 font-mono text-[12px] leading-[18px] outline-none"
        />
        <AssistantQueryActions clusterId={clusterId} language="promql" query={draft} />
        <button
          type="button"
          onClick={() => void run(draft, tab.range)}
          disabled={!draft.trim() || loading || !available}
          title={i18n.t('Run query (Enter)')}
          className="bg-accent text-accent-fg hover:bg-accent-hover rounded-app-sm flex h-[28px] shrink-0 items-center gap-1.5 px-2.5 text-[11.5px] font-medium transition disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          {i18n.t('Run')}
        </button>
        <div
          className="bg-fg/4 mt-[3px] inline-flex shrink-0 gap-0.5 rounded-md p-0.5"
          role="group"
        >
          {PROM_RANGES.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab.range === key}
              onClick={() => setRange(key)}
              title={promRangeTitle(key)}
              className={cn(
                'rounded px-1.5 py-px text-[10.5px] tabular-nums transition-colors',
                tab.range === key
                  ? 'bg-surface-raised text-fg font-medium shadow-sm'
                  : 'text-fg-dim hover:text-fg',
              )}
            >
              {promRangeLabel(key)}
            </button>
          ))}
        </div>
        <div className="mt-0.5 shrink-0">
          <DockStripAction
            icon={<History />}
            title={i18n.t('Recent and example queries')}
            active={menu !== null}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          />
        </div>
      </div>

      <div className="text-fg-dim flex min-h-6 items-center gap-3 px-3 text-[10.5px]">
        {!st && status.error && (
          <span className="text-status-error truncate" title={status.error}>
            {status.error}
          </span>
        )}
        {service && (
          <span
            className="truncate"
            title={`${kindLabel(service.kind)} · ${serviceAddress(service)}`}
          >
            {i18n.t('Prometheus: {service}', { service: serviceLabel(service) })}
          </span>
        )}
        {matchers && (
          <span className="truncate" title={matchers}>
            {i18n.rich('Cluster selector {matchers} is not added to your own queries.', {
              matchers: <code className="text-fg-muted font-mono">{`{${matchers}}`}</code>,
            })}
          </span>
        )}
        {result && (
          <>
            <span className="tabular-nums">
              {i18n.t('step {seconds}s', { seconds: result.step_secs })}
            </span>
            <span className="tabular-nums">
              {i18n.plural('{count} series', '{count} series', result.series.length)}
            </span>
          </>
        )}
        {result && (result.truncated || result.series.length > MAX_DRAWN) && (
          <span className="text-status-starting">
            {i18n.t('Showing the first {count} series; narrow the query to see the rest.', {
              count: Math.min(result.series.length, MAX_DRAWN),
            })}
          </span>
        )}
        {result?.warnings.map((w) => (
          <span key={w} className="text-status-starting truncate" title={w}>
            {w}
          </span>
        ))}
        {loading && result && <Loader2 className="ml-auto h-3 w-3 animate-spin" />}
      </div>

      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-2">
        <div ref={chartRef} className="min-h-0 min-w-0 flex-1">
          {chartHeight > 40 && (
            <MultiSeriesChart
              series={shown}
              from={from}
              to={to}
              intervalMs={(result?.step_secs ?? 15) * 1000}
              formatValue={formatSi}
              highlight={highlight}
              height={chartHeight}
              label={draft || 'PromQL'}
              overlay={overlay}
            />
          )}
        </div>
        {series.length > 0 && (
          <div className="border-border/60 flex w-72 shrink-0 flex-col border-l pl-2">
            <div className="text-fg-dim flex h-6 items-center justify-between text-[10.5px] font-semibold tracking-[0.08em] uppercase">
              <span>{i18n.t('Series')}</span>
              {hidden.size > 0 && (
                <button
                  type="button"
                  onClick={() => setHidden(new Set())}
                  className="hover:text-fg text-[10.5px] font-normal tracking-normal normal-case"
                >
                  {i18n.t('Show all')}
                </button>
              )}
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {series.map((s, i) => {
                const off = hidden.has(s.key);
                const last = lastPoint(result!.series[i]!.points);
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => toggle(s.key)}
                      onMouseEnter={() => setHighlight(off ? null : s.key)}
                      onMouseLeave={() => setHighlight(null)}
                      title={s.label}
                      aria-pressed={!off}
                      className={cn(
                        'hover:bg-fg/5 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px]',
                        off && 'opacity-45',
                      )}
                    >
                      <span className={cn('h-2 w-2 shrink-0 rounded-sm', s.color.bg)} aria-hidden />
                      <span
                        className={cn(
                          'text-fg-muted min-w-0 flex-1 truncate font-mono text-[10.5px]',
                          off && 'line-through',
                        )}
                      >
                        {s.label}
                      </span>
                      <span className="text-fg shrink-0 tabular-nums">
                        {last !== null ? formatSi(last) : '—'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={historyItems()}
        />
      )}
    </div>
  );
}
