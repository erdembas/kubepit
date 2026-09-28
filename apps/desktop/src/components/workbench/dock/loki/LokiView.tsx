import * as i18n from '@/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpToLine,
  CalendarSearch,
  Copy,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Settings2,
  WrapText,
  X,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';
import { ipc } from '@/lib/ipc';
import { levelVisible } from '@/lib/logs/filter';
import {
  builderQuery,
  emptyBuilder,
  isMetricQuery,
  labelNamesFrom,
  volumeQuery,
  type LokiBuilder,
} from '@/lib/logs/logql';
import {
  LOKI_RANGES,
  bucketsFromSeries,
  bucketsFromTimes,
  lokiKindLabel,
  lokiRangeLabel,
  lokiRangeTitle,
  lokiServiceAddress,
  lokiServiceLabel,
  rangeBounds,
  rangeNs,
  streamLabel,
  volumeStep,
  type LokiRange,
  type VolumeBucket,
} from '@/lib/logs/loki';
import { RecordIndex, type LogRecord } from '@/lib/logs/records';
import { formatLogTime, incNs, msToNs, nsToIso, nsToMs } from '@/lib/logs/time';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ClusterId, LokiService } from '@/types';
import { ProxyForbiddenNotice } from '../../common/ProxyForbiddenNotice';
import { formatLogLine, truncateAnsi, type LogFormatOptions } from '../logs/format';
import { MAX_LOG_LINES, type LogEntry } from '../logs/logBuffer';
import { LogTerminal, type LogTerminalHandle } from '../logs/LogTerminal';
import { ToggleChip, LogModeChips } from '../logs/LogToolbar';
import { StructuredLogView, type SourceColumn } from '../logs/structured/StructuredLogView';
import { useLogFilters } from '../logs/structured/useLogFilters';
import { copyText } from '../shared/platform';
import { saveTextAs } from '../shared/saveFile';
import { isFindShortcut, useIsDark } from '../shared/xtermUtils';
import { scopeNamespace } from '../tabs';
import { podCssColor, readPodPalette } from '../workload-logs/model';
import { LokiBuilderRow } from './LokiBuilderRow';
import { redetectLoki, useLokiLabels, useLokiStatus } from './useLoki';
import { VolumeHistogram } from './VolumeHistogram';

type LokiTab = Extract<DockTab, { kind: 'loki' }>;

interface LoadedLine {
  ns: string;
  ms: number;
  stream: number;
  line: string;
}

interface LokiEntry extends LogEntry {
  source: number;
}

interface ResultMeta {
  query: string;
  bounds: { start: number; end: number };
  limitReached: boolean;
  service: LokiService;
  warnings: string[];
}

type VolumeState =
  | { state: 'ok'; buckets: VolumeBucket[]; step: number; start: number; end: number }
  | { state: 'failed'; step: number; start: number; end: number }
  | null;

const LIMITS = [500, 1_000, 2_000, 5_000];
const MAX_LABEL = 36;

function fitLabel(label: string, width: number): string {
  if (label.length <= width) return label.padEnd(width);
  const tail = Math.min(8, Math.floor(width / 3));
  return `${label.slice(0, width - tail - 1)}…${label.slice(label.length - tail)}`;
}

/**
 * Historical logs from the cluster's Loki: a query builder (namespace,
 * workload, pod, container pickers fed by Loki's label values, line filter,
 * parser) or raw LogQL, a range picker, the log-volume histogram (click or
 * drag to zoom) and the results in the same xterm / structured views as
 * live logs. Results arrive newest first up to the limit; "Load older"
 * pages further back. Read-only.
 */
export function LokiView({
  clusterId,
  tab,
  active,
}: {
  clusterId: ClusterId;
  tab: LokiTab;
  active: boolean;
}) {
  i18n.useLocale();
  const status = useLokiStatus(clusterId, active);
  const available = status.data?.state === 'available';
  const cluster = useAppStore((s) => s.clusters.find((c) => c.id === clusterId));
  const fontSize = useAppStore((s) => s.settings?.terminal_font_size ?? 13);
  const pushToast = useAppStore((s) => s.pushToast);
  const updateTab = useDockStore((s) => s.updateTab);
  const isDark = useIsDark();
  const filters = useLogFilters('kp.loki.structured', true);
  const structured = filters.mode === 'structured';

  const [editor, setEditor] = useState<'builder' | 'code'>(
    tab.builder || !tab.query ? 'builder' : 'code',
  );
  const [builder, setBuilder] = useState<LokiBuilder>(
    () => tab.builder ?? emptyBuilder(scopeNamespace(clusterId)),
  );
  const [draft, setDraft] = useState(tab.query);
  const [range, setRange] = useState<LokiRange>({ kind: 'preset', key: tab.range });
  const [limit, setLimit] = useState(1_000);
  const [wrap, setWrap] = useState(true);
  const [lines, setLines] = useState<LoadedLine[]>([]);
  const [meta, setMeta] = useState<ResultMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<'query' | 'older' | null>(null);
  const [volume, setVolume] = useState<VolumeState>(null);
  const [redetecting, setRedetecting] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [runRequest, setRunRequest] = useState(0);
  const streamsRef = useRef<{ list: Record<string, string>[]; byKey: Map<string, number> }>({
    list: [],
    byKey: new Map(),
  });
  const runId = useRef(0);
  const termRef = useRef<LogTerminalHandle>(null);
  const paletteRef = useRef<string[]>([]);

  // Builder label names follow what this Loki uses (namespace vs k8s_namespace_name…).
  const rangeKey = range.kind === 'preset' ? range.key : `${range.start}-${range.end}`;
  const pickerBounds = useMemo(
    () => rangeNs(rangeBounds(range)),
    // Presets move with the clock; label values only need the window's size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rangeKey],
  );
  const labels = useLokiLabels(clusterId, pickerBounds, rangeKey, available);
  const names = useMemo(() => labelNamesFrom(labels.data ?? []), [labels.data]);
  const builderText = builderQuery(builder, names);
  const query = editor === 'builder' ? builderText : draft;

  // -- Query -----------------------------------------------------------------
  const streamId = (labelsOf: Record<string, string>) => {
    const key = JSON.stringify(Object.entries(labelsOf).sort(([a], [b]) => a.localeCompare(b)));
    const registry = streamsRef.current;
    let id = registry.byKey.get(key);
    if (id === undefined) {
      id = registry.list.length;
      registry.list.push(labelsOf);
      registry.byKey.set(key, id);
    }
    return id;
  };

  const fetchVolume = async (q: string, bounds: { start: number; end: number }, id: number) => {
    const step = volumeStep(bounds.end - bounds.start);
    const vq = volumeQuery(q, step);
    if (!vq) {
      setVolume(null);
      return;
    }
    try {
      const res = await ipc.lokiQueryRange(clusterId, {
        query: vq,
        ...rangeNs(bounds),
        limit: null,
        direction: 'backward',
        step,
      });
      if (id !== runId.current) return;
      setVolume({
        state: 'ok',
        buckets: bucketsFromSeries(res.series, bounds.start, bounds.end, step),
        step,
        ...bounds,
      });
    } catch {
      if (id === runId.current) setVolume({ state: 'failed', step, ...bounds });
    }
  };

  const run = async (mode: 'new' | 'older') => {
    const q = (mode === 'older' ? (meta?.query ?? '') : query).trim();
    if (!q || !available) return;
    if (isMetricQuery(q)) {
      setError(
        i18n.t(
          'This is a metric query. The Loki tab shows log lines: enter a stream selector with optional filters, e.g. {example}.',
          { example: '{namespace="default"} |= "error"' },
        ),
      );
      return;
    }
    const oldest = lines[0];
    if (mode === 'older' && (!meta || !oldest)) return;
    const id = ++runId.current;
    const bounds = mode === 'older' ? meta!.bounds : rangeBounds(range);
    setLoading(mode === 'older' ? 'older' : 'query');
    setError(null);
    if (mode === 'new') {
      updateTab(clusterId, tab.id, {
        query: q,
        builder: editor === 'builder' ? builder : null,
        ...(range.kind === 'preset' ? { range: range.key } : {}),
      });
      setVolume(null);
      void fetchVolume(q, bounds, id);
    }
    try {
      const res = await ipc.lokiQueryRange(clusterId, {
        query: q,
        start: msToNs(bounds.start),
        // Loki's end is exclusive: one nanosecond past the oldest line, whose
        // duplicates are dropped below.
        end: mode === 'older' ? incNs(oldest!.ns) : msToNs(bounds.end),
        limit,
        direction: 'backward',
        step: null,
      });
      if (id !== runId.current) return;
      if (mode === 'new') streamsRef.current = { list: [], byKey: new Map() };
      const incoming: LoadedLine[] = [];
      for (let i = res.lines.length - 1; i >= 0; i--) {
        const l = res.lines[i]!;
        incoming.push({
          ns: l.ts,
          ms: nsToMs(l.ts),
          stream: streamId(res.streams[l.stream] ?? {}),
          line: l.line,
        });
      }
      if (mode === 'older') {
        const boundary = oldest!.ns;
        const seen = new Set(
          lines.filter((l) => l.ns === boundary).map((l) => `${l.stream}\u0000${l.line}`),
        );
        const fresh = incoming.filter(
          (l) => l.ns !== boundary || !seen.has(`${l.stream}\u0000${l.line}`),
        );
        setLines((prev) => fresh.concat(prev));
      } else {
        setLines(incoming);
      }
      setMeta({
        query: q,
        bounds,
        limitReached: res.limit_reached,
        service: res.service,
        warnings: res.warnings,
      });
    } catch (e) {
      if (id !== runId.current) return;
      if (mode === 'new') {
        setLines([]);
        setMeta(null);
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === runId.current) setLoading(null);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  // Runs requested by range changes and zooms happen after the state lands.
  useEffect(() => {
    if (runRequest > 0) void runRef.current('new');
  }, [runRequest]);

  // A tab opened with a query or builder runs it once Loki (and its label names) answer.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !available || !(tab.query.trim() || tab.builder)) return;
    // Builder tabs wait for the label names (or their failure) so the selector fits this Loki.
    if (tab.builder && !labels.data && !labels.error) return;
    autoRan.current = true;
    void runRef.current('new');
  }, [available, tab.query, tab.builder, labels.data, labels.error]);

  const changeRange = (next: LokiRange) => {
    setRange(next);
    if (meta || query.trim()) setRunRequest((n) => n + 1);
  };

  // -- Display ---------------------------------------------------------------
  const view = useMemo(() => {
    const index = new RecordIndex();
    const entries: LokiEntry[] = lines.map((l, i) => ({
      seq: i,
      text: `${nsToIso(l.ns)} ${l.line}`,
      source: l.stream,
    }));
    index.ingest(entries);
    return { index, entries };
  }, [lines]);
  const streams = streamsRef.current.list;
  const multiStream = streams.length > 1;
  const labelWidth = useMemo(
    () => Math.min(MAX_LABEL, Math.max(8, ...streams.map((s) => streamLabel(s).length))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view],
  );

  const { levels, levelShown } = filters;
  const visibleEntries = useCallback(
    () => view.entries.filter((e) => levelShown(e.level)),
    [view, levelShown],
  );
  const visibleRef = useRef(visibleEntries);
  visibleRef.current = visibleEntries;
  const getEntries = useCallback(() => visibleRef.current(), []);

  useEffect(() => {
    paletteRef.current = readPodPalette();
    termRef.current?.reset(visibleRef.current());
  }, [view, levels, isDark]);

  const formatEntry = useCallback(
    (entry: LogEntry, opts: LogFormatOptions) => {
      const source = (entry as LokiEntry).source;
      if (!multiStream) return formatLogLine(entry.text, opts, entry.level);
      const palette = paletteRef.current;
      const rgb = palette.length ? palette[source % palette.length] : '128;128;128';
      const label = fitLabel(streamLabel(streamsRef.current.list[source] ?? {}), labelWidth);
      const prefix = `\x1b[38;2;${rgb}m${label}\x1b[39m `;
      const cols = opts.cols > 0 ? Math.max(8, opts.cols - labelWidth - 1) : opts.cols;
      const body = formatLogLine(entry.text, { wrap: opts.wrap, cols }, entry.level);
      return opts.wrap || opts.cols <= 8 ? prefix + body : truncateAnsi(prefix, opts.cols) + body;
    },
    [multiStream, labelWidth],
  );

  const source = useMemo<SourceColumn | undefined>(
    () =>
      multiStream
        ? {
            label: (r: LogRecord) => streamLabel(streamsRef.current.list[r.source] ?? {}),
            color: (r: LogRecord) => podCssColor(r.source),
            fields: (r: LogRecord) => streamsRef.current.list[r.source],
          }
        : {
            label: (r: LogRecord) => streamLabel(streamsRef.current.list[r.source] ?? {}),
            fields: (r: LogRecord) => streamsRef.current.list[r.source],
          },
    [multiStream],
  );

  const bounds = meta?.bounds ?? rangeBounds(range);
  const showDate = bounds.end - bounds.start > 24 * 3_600_000;
  const volumeBuckets = useMemo(() => {
    if (!volume) return null;
    if (volume.state === 'ok') return volume.buckets;
    return bucketsFromTimes(
      lines.map((l) => l.ms),
      volume.start,
      volume.end,
      volume.step,
    );
  }, [volume, lines]);

  const plainText = () =>
    lines
      .map((l) =>
        multiStream
          ? `${nsToIso(l.ns)} ${streamLabel(streams[l.stream] ?? {})} ${l.line}`
          : `${nsToIso(l.ns)} ${l.line}`,
      )
      .join('\n');
  const copyAll = () =>
    void copyText(plainText())
      .then(() =>
        pushToast(
          'success',
          i18n.plural('Copied {count} line', 'Copied {count} lines', lines.length),
        ),
      )
      .catch((err: unknown) => pushToast('error', String(err)));
  const save = () =>
    void saveTextAs('loki.log', `${plainText()}\n`)
      .then((path) => path && pushToast('success', i18n.t('Saved logs to {path}', { path })))
      .catch((err: unknown) => pushToast('error', String(err)));

  const settings = () =>
    cluster && useAppStore.getState().openClusterEditor({ mode: 'edit', cluster });
  const redetect = () => {
    setRedetecting(true);
    void redetectLoki(clusterId)
      .catch(() => undefined)
      .finally(() => setRedetecting(false));
  };

  // -- Render ----------------------------------------------------------------
  const st = status.data;
  if (!st)
    return (
      <div className="text-fg-dim flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-[11.5px]">
        {status.error ? (
          <span className="text-status-error max-w-xl break-words">{status.error}</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            {i18n.t('Looking for Loki…')}
          </span>
        )}
      </div>
    );
  if (!available)
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
        <CalendarSearch className="text-fg-dim h-5 w-5" />
        {st.state === 'forbidden' ? (
          <ProxyForbiddenNotice
            what="Loki"
            namespace={st.service?.namespace ?? '—'}
            message={st.error}
          />
        ) : (
          <>
            <p className="text-fg text-[12.5px] font-medium">
              {st.state === 'off'
                ? i18n.t('Loki is turned off for this cluster.')
                : st.state === 'unreachable'
                  ? i18n.t('Loki does not answer')
                  : i18n.t('No Loki found on this cluster')}
            </p>
            <p className="text-fg-dim max-w-lg text-[11.5px]">
              {st.state === 'unreachable' && st.error
                ? st.error
                : i18n.t(
                    'Kubepit looks for the Loki gateway, query frontend, read path or single binary (grafana/loki, loki-distributed, loki-stack) and queries it through the API server. You can also set the service in the cluster settings.',
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
              {i18n.t('Loki settings')}
            </button>
          )}
        </div>
      </div>
    );

  const service = meta?.service ?? st.service;
  let overlay: React.ReactNode = null;
  if (loading === 'query' && lines.length === 0)
    overlay = (
      <span className="flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" />
        {i18n.t('Running query…')}
      </span>
    );
  else if (error && lines.length === 0)
    overlay = (
      <span className="text-status-error max-w-2xl font-mono text-[11px] break-words whitespace-pre-wrap">
        {error}
      </span>
    );
  else if (!meta)
    overlay = i18n.t('Pick a namespace, workload or pod, or write LogQL, then press Run.');
  else if (lines.length === 0) overlay = i18n.t('No log lines in this range.');

  const canLoadOlder = !!meta?.limitReached && lines.length > 0 && lines.length < MAX_LOG_LINES;

  return (
    <div
      className="bg-surface-muted flex h-full w-full min-w-0 flex-col"
      onKeyDown={(event) => {
        if (isFindShortcut(event) && lines.length) {
          event.preventDefault();
          if (structured) setFocusRequest((n) => n + 1);
          else termRef.current?.openSearch();
        }
      }}
    >
      <div className="border-border/60 bg-surface main-tabbar-scroll @container flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b px-2">
        <div className="bg-fg/4 inline-flex shrink-0 gap-0.5 rounded-md p-0.5" role="group">
          {(['builder', 'code'] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={editor === key}
              onClick={() => {
                if (key === 'code' && editor === 'builder') setDraft(builderText);
                setEditor(key);
              }}
              className={cn(
                'rounded px-1.5 py-px text-[10.5px] transition-colors',
                editor === key
                  ? 'bg-surface-raised text-fg font-medium shadow-sm'
                  : 'text-fg-dim hover:text-fg',
              )}
            >
              {key === 'builder' ? i18n.t('Builder') : 'LogQL'}
            </button>
          ))}
        </div>
        <div className="bg-fg/4 inline-flex shrink-0 gap-0.5 rounded-md p-0.5" role="group">
          {LOKI_RANGES.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={range.kind === 'preset' && range.key === key}
              onClick={() => changeRange({ kind: 'preset', key })}
              title={lokiRangeTitle(key)}
              className={cn(
                'rounded px-1.5 py-px text-[10.5px] tabular-nums transition-colors',
                range.kind === 'preset' && range.key === key
                  ? 'bg-surface-raised text-fg font-medium shadow-sm'
                  : 'text-fg-dim hover:text-fg',
              )}
            >
              {lokiRangeLabel(key)}
            </button>
          ))}
        </div>
        {range.kind === 'absolute' && (
          <span className="border-accent/50 bg-accent/10 text-accent rounded-app-sm flex h-6.5 shrink-0 items-center gap-1 border pr-0.5 pl-2 text-[11px] tabular-nums">
            {formatLogTime(range.start, showDate).slice(0, showDate ? 16 : 8)}–
            {formatLogTime(range.end, showDate).slice(0, showDate ? 16 : 8)}
            <button
              type="button"
              aria-label={i18n.t('Back to the preset range')}
              onClick={() => changeRange({ kind: 'preset', key: tab.range })}
              className="hover:bg-accent/15 flex h-5 w-5 items-center justify-center rounded-sm"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
        <Select
          value={String(limit)}
          onChange={(v) => setLimit(Number(v))}
          options={LIMITS.map((n) => ({
            value: String(n),
            label: i18n.t('{count} lines', { count: i18n.number(n) }),
          }))}
          ariaLabel={i18n.t('Line limit')}
          className="h-6.5 shrink-0"
        />
        <button
          type="button"
          onClick={() => void run('new')}
          disabled={!query.trim() || loading !== null}
          title={i18n.t('Run query (Enter)')}
          className="bg-accent text-accent-fg hover:bg-accent-hover rounded-app-sm flex h-6.5 shrink-0 items-center gap-1.5 px-2.5 text-[11.5px] font-medium transition disabled:opacity-50"
        >
          {loading === 'query' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          {i18n.t('Run')}
        </button>
        <span aria-hidden className="bg-border/70 mx-0.5 h-4 w-px shrink-0" />
        <LogModeChips
          mode={filters.mode}
          onMode={filters.setMode}
          levels={filters.levels}
          counts={view.index.counts}
          onLevels={filters.setLevels}
        />
        {!structured && (
          <ToggleChip
            active={wrap}
            onClick={() => setWrap(!wrap)}
            icon={<WrapText />}
            label={i18n.t('Wrap')}
            title={i18n.t('Wrap long lines')}
          />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
          <button
            type="button"
            onClick={() => void run('older')}
            disabled={!canLoadOlder || loading !== null}
            title={
              lines.length >= MAX_LOG_LINES
                ? i18n.t('The view holds at most {count} lines.', {
                    count: i18n.number(MAX_LOG_LINES),
                  })
                : i18n.t('Load the lines before the oldest one shown')
            }
            className="text-fg-muted hover:text-fg hover:bg-fg/10 rounded-app-sm flex h-6 shrink-0 items-center gap-1 px-1.5 text-[11px] font-medium transition disabled:opacity-40 [&>svg]:h-3 [&>svg]:w-3"
          >
            {loading === 'older' ? <Loader2 className="animate-spin" /> : <ArrowUpToLine />}
            <span className="hidden @4xl:inline">{i18n.t('Load older')}</span>
          </button>
          <IconButton
            size="xs"
            label={i18n.t('Copy all')}
            icon={<Copy />}
            disabled={!lines.length}
            onClick={copyAll}
          />
          <IconButton
            size="xs"
            label={i18n.t('Save logs…')}
            icon={<Download />}
            disabled={!lines.length}
            onClick={save}
          />
        </div>
      </div>

      {editor === 'builder' ? (
        <div className="border-border/60 bg-surface shrink-0 border-b">
          <LokiBuilderRow
            clusterId={clusterId}
            builder={builder}
            names={names}
            bounds={pickerBounds}
            rangeKey={rangeKey}
            enabled={available && active}
            onChange={setBuilder}
          />
          <div className="flex items-center gap-2 px-3 pb-1.5">
            <code
              className="text-fg-dim min-w-0 flex-1 truncate font-mono text-[10.5px]"
              title={builderText}
            >
              {builderText}
            </code>
            <button
              type="button"
              onClick={() => {
                setDraft(builderText);
                setEditor('code');
              }}
              className="text-fg-dim hover:text-fg shrink-0 text-[10.5px]"
            >
              {i18n.t('Edit as LogQL')}
            </button>
          </div>
        </div>
      ) : (
        <div className="border-border/60 bg-surface flex shrink-0 items-start gap-2 border-b px-3 py-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void run('new');
              }
            }}
            rows={Math.min(4, Math.max(1, draft.split('\n').length))}
            spellCheck={false}
            autoFocus={active && !draft}
            placeholder={'{namespace="default", pod=~"web-.+"} |= "error" | json'}
            aria-label={i18n.t('LogQL query')}
            className="border-border bg-surface-raised text-fg placeholder:text-fg-dim focus:border-accent rounded-app-sm min-w-0 flex-1 resize-none border px-2 py-1 font-mono text-[12px] leading-[18px] outline-none"
          />
        </div>
      )}

      <div className="border-border/60 shrink-0 border-b pt-1 pb-1">
        <div className="text-fg-dim flex min-h-5 min-w-0 items-center gap-3 overflow-hidden px-3 text-[10.5px] whitespace-nowrap">
          {service && (
            <span
              className="truncate"
              title={`${lokiKindLabel(service.kind)} · ${lokiServiceAddress(service)}`}
            >
              {i18n.t('Loki: {service}', { service: lokiServiceLabel(service) })}
            </span>
          )}
          {meta && (
            <span className="tabular-nums">
              {i18n.plural('{count} line', '{count} lines', lines.length)}
            </span>
          )}
          {meta?.limitReached && (
            <span className="text-status-starting min-w-0 truncate">
              {i18n.t('Limit reached: newer lines shown first, load older ones as needed.')}
            </span>
          )}
          {volume?.state === 'failed' && lines.length > 0 && (
            <span>{i18n.t('Volume of the loaded lines only')}</span>
          )}
          {error && lines.length > 0 && (
            <span className="text-status-error truncate" title={error}>
              {error}
            </span>
          )}
          {meta?.warnings.map((w) => (
            <span key={w} className="text-status-starting truncate" title={w}>
              {w}
            </span>
          ))}
        </div>
        {volumeBuckets && volume && (
          <VolumeHistogram
            buckets={volumeBuckets}
            stepSecs={volume.step}
            start={volume.start}
            end={volume.end}
            loadedFrom={lines[0]?.ms ?? null}
            onZoom={(start, end) => changeRange({ kind: 'absolute', start, end })}
          />
        )}
      </div>

      {structured && (
        <div className="bg-surface min-h-0 flex-1">
          <StructuredLogView
            index={view.index}
            version={view.index.version}
            counts={view.index.counts}
            filters={filters}
            source={source}
            follow={false}
            showDate={showDate}
            exportName="loki"
            emptyState={overlay}
            focusRequest={focusRequest}
          />
        </div>
      )}
      <div
        className={cn('relative min-h-0 flex-1 overflow-hidden pt-1 pl-2', structured && 'hidden')}
      >
        <LogTerminal
          ref={termRef}
          active={active && !structured}
          isDark={isDark}
          fontSize={fontSize}
          wrap={wrap}
          getEntries={getEntries}
          formatEntry={formatEntry}
          onContextMenu={() => undefined}
        />
        {(overlay ||
          (lines.length > 0 && !view.entries.some((e) => levelVisible(levels, e.level)))) && (
          <div className="bg-surface-muted text-fg-dim pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[11px]">
            {overlay ?? i18n.t('No lines at the selected levels.')}
          </div>
        )}
      </div>
    </div>
  );
}
