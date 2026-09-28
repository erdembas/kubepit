import * as i18n from '@/i18n';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Copy, Eraser, Eye, EyeOff, Focus, Search, TextSelect } from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { cn } from '@/lib/cn';
import { ALL_LEVELS } from '@/lib/logs/filter';
import { LEVEL_KEYS, emptyLevelCounts, type LevelCounts } from '@/lib/logs/levels';
import { LOKI_WORKLOAD_KINDS } from '@/lib/logs/logql';
import { RecordIndex, type LogRecord } from '@/lib/logs/records';
import { modChord } from '@/lib/platform';
import { usePersistentBoolean } from '@/lib/usePersistentBoolean';
import { XTERM_DARK_BG, XTERM_LIGHT_BG } from '@/lib/xtermTheme';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ClusterId, WorkloadLogBatch, WorkloadLogOptions } from '@/types';
import { openLokiForWorkload } from '../../actions/lokiActions';
import { stripAnsi, type LogFormatOptions } from '../logs/format';
import type { LogEntry } from '../logs/logBuffer';
import { LogTerminal, type LogTerminalHandle } from '../logs/LogTerminal';
import { StructuredLogView, type SourceColumn } from '../logs/structured/StructuredLogView';
import { useLogFilters } from '../logs/structured/useLogFilters';
import type { StreamStatus } from '../logs/useLogStream';
import { copyText } from '../shared/platform';
import { saveTextAs } from '../shared/saveFile';
import { isFindShortcut, useIsDark } from '../shared/xtermUtils';
import {
  MergedLogBuffer,
  SYSTEM_SOURCE,
  SourceRegistry,
  exportText,
  formatMergedEntry,
  isVisible,
  labelLayout,
  livePodCount,
  podCssColor,
  readPodPalette,
  type LabelLayout,
  type LogSource,
  type MergedEntry,
  type SourceFilter,
} from './model';
import { SourceLegend } from './SourceLegend';
import { useWorkloadLogStream } from './useWorkloadLogStream';
import { WorkloadLogToolbar } from './WorkloadLogToolbar';

type WorkloadLogsTab = Extract<DockTab, { kind: 'workload-logs' }>;

interface Props {
  clusterId: ClusterId;
  tab: WorkloadLogsTab;
  active: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Merged logs of every pod of a workload (stern-style): one xterm with a
 * coloured `pod/container` prefix per line, a legend to toggle pods and
 * containers, and the pod log view's pause / search / export. Pods that
 * appear later (rollouts, scale-ups, restarts) join on their own; toggling
 * sources only re-renders, it never restarts the stream. Lines are folded
 * into records per source (levels, stack traces) for the level filter and
 * the structured table.
 */
export const WorkloadLogView = memo(function WorkloadLogView({ clusterId, tab, active }: Props) {
  i18n.useLocale();
  const fontSize = useAppStore((s) => s.settings?.terminal_font_size ?? 13);
  const defaultTail = useAppStore((s) => s.settings?.log_tail_lines ?? 1000);
  const pushToast = useAppStore((s) => s.pushToast);
  const updateTab = useDockStore((s) => s.updateTab);
  const isDark = useIsDark();
  const filters = useLogFilters('kp.workload-logs.structured');
  const structured = filters.mode === 'structured';
  const { levelShown } = filters;

  const [container, setContainer] = useState<string | null>(null);
  const [initContainers, setInitContainers] = useState(false);
  const [timestamps, setTimestamps] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  // Per container, so a big workload does not start with 1 000 lines × pods.
  const [tail, setTail] = useState<number | null>(Math.min(defaultTail, 500));
  const [wrap, setWrap] = useState(true);
  const [legend, setLegend] = usePersistentBoolean('kp.workload-logs.legend', true);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(0);
  const [lineCount, setLineCount] = useState(0);
  const [sources, setSources] = useState<LogSource[]>([]);
  const [recordsVersion, setRecordsVersion] = useState(0);
  const [counts, setCounts] = useState<LevelCounts>(emptyLevelCounts);
  const [focusRequest, setFocusRequest] = useState(0);
  const [filter, setFilter] = useState<SourceFilter>({
    hiddenPods: EMPTY_SET,
    hiddenContainers: EMPTY_SET,
  });
  const [menu, setMenu] = useState<{ x: number; y: number; items: FileContextMenuEntry[] } | null>(
    null,
  );

  const bufferRef = useRef(new MergedLogBuffer());
  const registryRef = useRef(new SourceRegistry());
  const indexRef = useRef(new RecordIndex());
  const termRef = useRef<LogTerminalHandle>(null);
  const pausedRef = useRef(false);
  const pendingRef = useRef<MergedEntry[]>([]);
  const shownSeqRef = useRef(-1);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const paletteRef = useRef<string[]>([]);
  const layoutRef = useRef<LabelLayout>({ width: 8, strip: 0 });
  const countTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shownCountRef = useRef(0);

  const visible = useCallback(
    (entry: MergedEntry) =>
      isVisible(entry, registryRef.current, filterRef.current) &&
      (entry.source === SYSTEM_SOURCE || levelShown(entry.level)),
    [levelShown],
  );

  const visibleEntries = useCallback((): MergedEntry[] => {
    const all = bufferRef.current.entries;
    const limit = pausedRef.current ? shownSeqRef.current : Infinity;
    return all.filter((e) => e.seq <= limit && visible(e));
  }, [visible]);

  const rerender = useCallback(() => termRef.current?.reset(visibleEntries()), [visibleEntries]);

  /** Recompute the prefix column; true when it changed (written lines need a repaint). */
  const updateLayout = useCallback((list: LogSource[]) => {
    const next = labelLayout(list);
    const prev = layoutRef.current;
    if (next.width === prev.width && next.strip === prev.strip) return false;
    layoutRef.current = next;
    return true;
  }, []);

  // Counters, legend and tab title refresh at most ~4x per second, except
  // the first lines, which must lift the empty state right away.
  const scheduleSync = useCallback(() => {
    const sync = () => {
      countTimer.current = undefined;
      const registry = registryRef.current;
      const list = registry.list();
      shownCountRef.current = bufferRef.current.length;
      setLineCount(visibleEntries().length);
      setPending(pendingRef.current.length);
      setSources(list);
      setRecordsVersion(indexRef.current.version);
      setCounts({ ...indexRef.current.counts });
      const pods = livePodCount(list);
      const current = useDockStore
        .getState()
        .docks[clusterId]?.tabs.find((t) => t.id === tab.id) as WorkloadLogsTab | undefined;
      // Keep the last count while a restarted stream has not reported pods yet.
      if (current && list.length > 0 && current.pods !== pods)
        updateTab(clusterId, tab.id, { pods });
      if (updateLayout(list)) rerender();
    };
    if ((shownCountRef.current === 0) !== (bufferRef.current.length === 0)) {
      clearTimeout(countTimer.current);
      sync();
      return;
    }
    if (countTimer.current === undefined) countTimer.current = setTimeout(sync, 250);
  }, [clusterId, tab.id, updateTab, visibleEntries, rerender, updateLayout]);

  useEffect(() => () => clearTimeout(countTimer.current), []);

  // Pod colours come from the theme tokens; a theme switch repaints.
  const paletteMounted = useRef(false);
  useEffect(() => {
    paletteRef.current = readPodPalette();
    if (paletteMounted.current) rerender();
    paletteMounted.current = true;
  }, [isDark, rerender]);

  const deliver = useCallback(
    (entries: MergedEntry[]) => {
      if (entries.length === 0) return;
      if (pausedRef.current) {
        for (const entry of entries) pendingRef.current.push(entry);
      } else {
        const shown = entries.filter(visible);
        if (shown.length) termRef.current?.append(shown);
        shownSeqRef.current = entries[entries.length - 1]!.seq;
      }
      scheduleSync();
    },
    [scheduleSync, visible],
  );

  const onBatch = useCallback(
    (batch: WorkloadLogBatch) => {
      const buffer = bufferRef.current;
      const registry = registryRef.current;
      const added: MergedEntry[] = [];
      for (const event of batch.events) {
        const { source, marker } = registry.apply(event);
        if (event.kind === 'lines' && source) {
          const lines = buffer.add(source.id, event.lines);
          indexRef.current.ingest(lines);
          for (const entry of lines) added.push(entry);
        }
        if (marker && marker.text) {
          for (const entry of buffer.add(SYSTEM_SOURCE, [marker.text], marker.tone))
            added.push(entry);
        }
      }
      const first = buffer.entries[0];
      if (first) indexRef.current.trimBefore(first.seq);
      // New sources can change the prefix column; then everything is re-rendered.
      if (updateLayout(registry.list())) {
        deliver(added);
        rerender();
        return;
      }
      if (added.length) deliver(added);
      else scheduleSync();
    },
    [deliver, rerender, scheduleSync, updateLayout],
  );

  const resetView = useCallback(() => {
    bufferRef.current.clear();
    registryRef.current.reset();
    indexRef.current.clear();
    pendingRef.current = [];
    shownSeqRef.current = -1;
    layoutRef.current = { width: 8, strip: 0 };
    termRef.current?.reset([]);
    scheduleSync();
  }, [scheduleSync]);

  const options = useMemo<WorkloadLogOptions>(
    () => ({
      containers: container ? [container] : [],
      init_containers: initContainers,
      tail_lines: tail,
      since_seconds: since,
      timestamps,
    }),
    [container, initContainers, tail, since, timestamps],
  );

  const { status, restart } = useWorkloadLogStream({
    clusterId,
    namespace: tab.namespace,
    selector: tab.selector,
    options,
    onReset: resetView,
    onBatch,
  });

  const formatEntry = useCallback(
    (entry: LogEntry, opts: LogFormatOptions) =>
      formatMergedEntry(
        entry as MergedEntry,
        { registry: registryRef.current, palette: paletteRef.current, layout: layoutRef.current },
        opts,
      ),
    [],
  );

  const setFilterAndRender = useCallback(
    (next: SourceFilter) => {
      filterRef.current = next;
      setFilter(next);
      rerender();
      scheduleSync();
    },
    [rerender, scheduleSync],
  );

  const toggle = (key: 'hiddenPods' | 'hiddenContainers', value: string) => {
    const set = new Set(filterRef.current[key]);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    setFilterAndRender({ ...filterRef.current, [key]: set });
  };
  const allPods = () => new Set(registryRef.current.list().map((s) => s.pod));
  const allContainers = () => new Set(registryRef.current.list().map((s) => s.container));
  const only = (key: 'hiddenPods' | 'hiddenContainers', value: string) => {
    const everything = key === 'hiddenPods' ? allPods() : allContainers();
    everything.delete(value);
    setFilterAndRender({ ...filterRef.current, [key]: everything });
  };
  const showAll = () => setFilterAndRender({ hiddenPods: EMPTY_SET, hiddenContainers: EMPTY_SET });
  const hideAll = () => setFilterAndRender({ hiddenPods: allPods(), hiddenContainers: EMPTY_SET });

  // A new level filter repaints the terminal from the buffer.
  const levelsMounted = useRef(false);
  useEffect(() => {
    if (!levelsMounted.current) {
      levelsMounted.current = true;
      return;
    }
    rerender();
    scheduleSync();
  }, [filters.levels, rerender, scheduleSync]);

  const sourceColumn = useMemo<SourceColumn>(
    () => ({
      label: (r: LogRecord) => {
        const s = registryRef.current.get(r.source);
        return s ? `${s.pod}/${s.container}` : '?';
      },
      color: (r: LogRecord) => {
        const s = registryRef.current.get(r.source);
        return s ? podCssColor(registryRef.current.colorIndex(s.pod)) : undefined;
      },
      fields: (r: LogRecord) => {
        const s = registryRef.current.get(r.source);
        return s ? { pod: s.pod, container: s.container } : undefined;
      },
    }),
    [],
  );
  const hiddenBySource = useCallback(
    (r: LogRecord) => {
      const s = registryRef.current.get(r.source);
      return !!s && (filter.hiddenPods.has(s.pod) || filter.hiddenContainers.has(s.container));
    },
    [filter],
  );
  const hiddenKey = `${[...filter.hiddenPods].join(',')}|${[...filter.hiddenContainers].join(',')}`;

  const openSearch = useCallback(() => {
    if (structured) setFocusRequest((n) => n + 1);
    else termRef.current?.openSearch();
  }, [structured]);

  const togglePause = useCallback(() => {
    if (!pausedRef.current) {
      pausedRef.current = true;
      setPaused(true);
      return;
    }
    pausedRef.current = false;
    setPaused(false);
    const backlog = pendingRef.current.filter(visible);
    const last = pendingRef.current[pendingRef.current.length - 1];
    pendingRef.current = [];
    setPending(0);
    if (backlog.length > 0) termRef.current?.append(backlog);
    if (last) shownSeqRef.current = last.seq;
    termRef.current?.scrollToBottom();
  }, [visible]);

  const clear = useCallback(() => {
    bufferRef.current.clear();
    registryRef.current.resetCounts();
    indexRef.current.clear();
    pendingRef.current = [];
    termRef.current?.reset([]);
    scheduleSync();
  }, [scheduleSync]);

  const plainText = useCallback(
    () => exportText(visibleEntries(), registryRef.current),
    [visibleEntries],
  );

  const copyAll = useCallback(() => {
    const count = visibleEntries().filter((e) => e.source !== SYSTEM_SOURCE).length;
    void copyText(plainText())
      .then(() =>
        pushToast('success', i18n.plural('Copied {count} line', 'Copied {count} lines', count)),
      )
      .catch((err: unknown) => pushToast('error', String(err)));
  }, [plainText, pushToast, visibleEntries]);

  const save = useCallback(() => {
    void saveTextAs(`${tab.workload.name}-${tab.namespace}.log`, `${plainText()}\n`)
      .then((path) => path && pushToast('success', i18n.t('Saved logs to {path}', { path })))
      .catch((err: unknown) => pushToast('error', String(err)));
  }, [plainText, pushToast, tab.workload.name, tab.namespace]);

  const onLineMenu = (seq: number | null, x: number, y: number, selection: string) => {
    const entry = seq === null ? undefined : bufferRef.current.bySeq(seq);
    const source = entry ? registryRef.current.get(entry.source) : undefined;
    const items: FileContextMenuEntry[] = [
      {
        id: 'copy-line',
        label: i18n.t('Copy line'),
        icon: <Copy size={12} />,
        disabled: !entry,
        onClick: () => entry && void copyText(stripAnsi(entry.text)),
      },
      {
        id: 'copy-selection',
        label: i18n.t('Copy selection'),
        icon: <TextSelect size={12} />,
        disabled: !selection,
        onClick: () => void copyText(selection),
      },
      { id: 'copy-all', label: i18n.t('Copy all'), icon: <Copy size={12} />, onClick: copyAll },
      { id: 'sep-1', separator: true },
      {
        id: 'only-pod',
        label: source
          ? i18n.t('Show only {pod}', { pod: source.pod })
          : i18n.t('Show only this pod'),
        icon: <Focus size={12} />,
        disabled: !source,
        onClick: () => source && only('hiddenPods', source.pod),
      },
      {
        id: 'hide-pod',
        label: source ? i18n.t('Hide {pod}', { pod: source.pod }) : i18n.t('Hide this pod'),
        icon: <EyeOff size={12} />,
        disabled: !source,
        onClick: () => source && toggle('hiddenPods', source.pod),
      },
      {
        id: 'show-all',
        label: i18n.t('Show all sources'),
        icon: <Eye size={12} />,
        disabled: filter.hiddenPods.size === 0 && filter.hiddenContainers.size === 0,
        onClick: showAll,
      },
      { id: 'sep-2', separator: true },
      {
        id: 'find',
        label: i18n.t('Find…'),
        icon: <Search size={12} />,
        hint: modChord('F'),
        onClick: () => termRef.current?.openSearch(),
      },
      { id: 'clear', label: i18n.t('Clear'), icon: <Eraser size={12} />, onClick: clear },
    ];
    setMenu({ x, y, items });
  };

  const skipped = sources.filter((s) => s.state === 'skipped').length;
  const hiddenEverything =
    lineCount === 0 &&
    bufferRef.current.length > 0 &&
    (filter.hiddenPods.size > 0 || filter.hiddenContainers.size > 0);
  const hiddenByLevel =
    lineCount === 0 && bufferRef.current.length > 0 && filters.levels.size < LEVEL_KEYS.length;

  return (
    <div
      className="bg-surface-muted flex h-full w-full min-w-0 flex-col"
      onKeyDown={(event) => {
        if (isFindShortcut(event)) {
          event.preventDefault();
          openSearch();
        }
      }}
    >
      <WorkloadLogToolbar
        status={status}
        paused={paused}
        pending={pending}
        lineCount={lineCount}
        containers={tab.containers}
        container={container}
        hasInit={tab.initContainers.length > 0}
        initContainers={initContainers}
        timestamps={timestamps}
        wrap={wrap}
        since={since}
        tail={tail}
        defaultTail={defaultTail}
        legend={legend}
        onContainer={setContainer}
        onInitContainers={setInitContainers}
        onTimestamps={setTimestamps}
        onWrap={setWrap}
        onSince={setSince}
        onTail={setTail}
        onLegend={setLegend}
        onSearch={openSearch}
        onPauseToggle={togglePause}
        onClear={clear}
        onCopy={copyAll}
        onSave={save}
        onRetry={restart}
        mode={filters.mode}
        onMode={filters.setMode}
        levels={filters.levels}
        counts={counts}
        onLevels={filters.setLevels}
        onLoki={
          LOKI_WORKLOAD_KINDS.has(tab.workload.kind)
            ? () =>
                openLokiForWorkload(clusterId, tab.namespace, tab.workload.kind, tab.workload.name)
            : undefined
        }
      />
      {skipped > 0 && (
        <div className="border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[11.5px]">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {i18n.plural(
            '{count} more container is not followed (limit of 64 streams). Pick a container to narrow it down.',
            '{count} more containers are not followed (limit of 64 streams). Pick a container to narrow it down.',
            skipped,
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {structured && (
          <div className="bg-surface min-h-0 min-w-0 flex-1">
            <StructuredLogView
              index={indexRef.current}
              version={recordsVersion}
              counts={counts}
              filters={filters}
              source={sourceColumn}
              hidden={hiddenBySource}
              hiddenKey={hiddenKey}
              maxId={paused ? shownSeqRef.current : Infinity}
              follow={!paused}
              exportName={`${tab.workload.name}-${tab.namespace}`}
              emptyState={
                <MergedEmptyMessage
                  status={status}
                  selector={tab.selector}
                  hasSources={sources.length > 0}
                  hiddenEverything={false}
                  onRetry={restart}
                  onShowAll={showAll}
                />
              }
              focusRequest={focusRequest}
            />
          </div>
        )}
        <div
          className={cn(
            'relative min-h-0 min-w-0 flex-1 overflow-hidden pt-1 pl-2',
            structured && 'hidden',
          )}
        >
          <LogTerminal
            ref={termRef}
            active={active && !structured}
            isDark={isDark}
            fontSize={fontSize}
            wrap={wrap}
            getEntries={visibleEntries}
            formatEntry={formatEntry}
            onContextMenu={onLineMenu}
          />
          {lineCount === 0 && (
            <MergedEmptyState
              status={status}
              selector={tab.selector}
              hasSources={sources.length > 0}
              hiddenEverything={hiddenEverything}
              hiddenByLevel={hiddenByLevel}
              onShowAllLevels={() => filters.setLevels(ALL_LEVELS)}
              isDark={isDark}
              onRetry={restart}
              onShowAll={showAll}
            />
          )}
        </div>
        {legend && (
          <SourceLegend
            sources={sources}
            strip={layoutRef.current.strip}
            colorIndex={(pod) => registryRef.current.colorIndex(pod)}
            filter={filter}
            onTogglePod={(pod) => toggle('hiddenPods', pod)}
            onToggleContainer={(c) => toggle('hiddenContainers', c)}
            onOnlyPod={(pod) => only('hiddenPods', pod)}
            onOnlyContainer={(c) => only('hiddenContainers', c)}
            onShowAll={showAll}
            onHideAll={hideAll}
          />
        )}
      </div>
      {menu && <FileContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
});

function MergedEmptyState({
  isDark,
  ...props
}: Parameters<typeof MergedEmptyMessage>[0] & { isDark: boolean }) {
  return (
    <div
      className="text-fg-dim pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[11px]"
      style={{ backgroundColor: isDark ? XTERM_DARK_BG : XTERM_LIGHT_BG }}
    >
      <MergedEmptyMessage {...props} />
    </div>
  );
}

function MergedEmptyMessage({
  status,
  selector,
  hasSources,
  hiddenEverything,
  hiddenByLevel = false,
  onRetry,
  onShowAll,
  onShowAllLevels,
}: {
  status: StreamStatus;
  selector: string;
  hasSources: boolean;
  hiddenEverything: boolean;
  hiddenByLevel?: boolean;
  onRetry: () => void;
  onShowAll: () => void;
  onShowAllLevels?: () => void;
}) {
  i18n.useLocale();
  const button = 'btn-chrome rounded-app-sm pointer-events-auto h-6 px-2.5 text-[11px] font-medium';
  let body;
  if (status.state === 'error') {
    body = (
      <>
        <span className="text-status-error max-w-xl text-[12px] break-words">{status.message}</span>
        <button type="button" onClick={onRetry} className={button}>
          {i18n.t('Retry')}
        </button>
      </>
    );
  } else if (hiddenEverything) {
    body = (
      <>
        {i18n.t('Every source is hidden.')}
        <button type="button" onClick={onShowAll} className={button}>
          {i18n.t('Show all sources')}
        </button>
      </>
    );
  } else if (hiddenByLevel) {
    body = (
      <>
        {i18n.t('No lines at the selected levels.')}
        <button type="button" onClick={onShowAllLevels} className={button}>
          {i18n.t('Show all levels')}
        </button>
      </>
    );
  } else if (status.state === 'connecting') {
    body = i18n.t('Loading logs…');
  } else if (!hasSources) {
    body = (
      <span>
        {i18n.rich('Waiting for pods matching {selector}…', {
          selector: <code className="text-fg-muted font-mono">{selector}</code>,
        })}
      </span>
    );
  } else {
    body = status.state === 'ended' ? i18n.t('No log lines.') : i18n.t('Waiting for log output…');
  }
  return <>{body}</>;
}
