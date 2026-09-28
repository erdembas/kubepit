import * as i18n from '@/i18n';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Eraser, Search, TextSelect } from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { cn } from '@/lib/cn';
import { ALL_LEVELS } from '@/lib/logs/filter';
import { LEVEL_KEYS, emptyLevelCounts, type LevelCounts } from '@/lib/logs/levels';
import { RecordIndex } from '@/lib/logs/records';
import { modChord } from '@/lib/platform';
import { XTERM_DARK_BG, XTERM_LIGHT_BG } from '@/lib/xtermTheme';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ClusterId, LogOptions } from '@/types';
import { openLokiForPod } from '../../actions/lokiActions';
import { copyText } from '../shared/platform';
import { saveTextAs } from '../shared/saveFile';
import { isFindShortcut, useIsDark } from '../shared/xtermUtils';
import { stripAnsi } from './format';
import { LogBuffer, type LogEntry } from './logBuffer';
import { LogTerminal, type LogTerminalHandle } from './LogTerminal';
import { LogToolbar } from './LogToolbar';
import { StructuredLogView } from './structured/StructuredLogView';
import { useLogFilters } from './structured/useLogFilters';
import { useLogStream, type StreamStatus } from './useLogStream';

type LogsTab = Extract<DockTab, { kind: 'logs' }>;

interface Props {
  clusterId: ClusterId;
  tab: LogsTab;
  active: boolean;
}

/**
 * Pod logs tab: toolbar + xterm renderer over a bounded line buffer, or the
 * structured table over the same lines. The stream restarts whenever the
 * container or an option changes; pausing keeps the stream flowing into the
 * buffer but freezes the screen until resumed. Every line is folded into a
 * record index (levels, stack traces) as it arrives, which drives the
 * level colouring and filter of both modes.
 */
export const LogView = memo(function LogView({ clusterId, tab, active }: Props) {
  i18n.useLocale();
  const fontSize = useAppStore((s) => s.settings?.terminal_font_size ?? 13);
  const defaultTail = useAppStore((s) => s.settings?.log_tail_lines ?? 1000);
  const pushToast = useAppStore((s) => s.pushToast);
  const updateTab = useDockStore((s) => s.updateTab);
  const isDark = useIsDark();
  const filters = useLogFilters('kp.logs.structured');
  const structured = filters.mode === 'structured';

  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  const [tail, setTail] = useState<number | null>(defaultTail);
  const [wrap, setWrap] = useState(true);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(0);
  const [lineCount, setLineCount] = useState(0);
  const [recordsVersion, setRecordsVersion] = useState(0);
  const [counts, setCounts] = useState<LevelCounts>(emptyLevelCounts);
  const [focusRequest, setFocusRequest] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: FileContextMenuEntry[] } | null>(
    null,
  );

  const bufferRef = useRef(new LogBuffer());
  const indexRef = useRef(new RecordIndex());
  const termRef = useRef<LogTerminalHandle>(null);
  const pausedRef = useRef(false);
  const pendingRef = useRef<LogEntry[]>([]);
  const shownSeqRef = useRef(-1);
  const countTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { levelShown } = filters;

  const shownCountRef = useRef(0);
  // Chunks can arrive very fast; refresh counters at most ~4x per second —
  // except the first lines, which must lift the empty state right away.
  const scheduleCounts = useCallback(() => {
    const sync = () => {
      countTimer.current = undefined;
      shownCountRef.current = bufferRef.current.length;
      setLineCount(shownCountRef.current);
      setPending(pendingRef.current.length);
      setRecordsVersion(indexRef.current.version);
      setCounts({ ...indexRef.current.counts });
    };
    if ((shownCountRef.current === 0) !== (bufferRef.current.length === 0)) {
      clearTimeout(countTimer.current);
      sync();
      return;
    }
    if (countTimer.current === undefined) countTimer.current = setTimeout(sync, 250);
  }, []);

  useEffect(() => () => clearTimeout(countTimer.current), []);

  /** New lines: fold them into records (levels) and keep the index bounded with the buffer. */
  const ingest = useCallback((entries: LogEntry[]) => {
    if (entries.length === 0) return entries;
    indexRef.current.ingest(entries);
    const first = bufferRef.current.entries[0];
    if (first) indexRef.current.trimBefore(first.seq);
    return entries;
  }, []);

  const deliver = useCallback(
    (entries: LogEntry[]) => {
      if (entries.length === 0) return;
      if (pausedRef.current) {
        for (const entry of entries) pendingRef.current.push(entry);
      } else {
        const shown = entries.filter((e) => levelShown(e.level));
        if (shown.length) termRef.current?.append(shown);
        shownSeqRef.current = entries[entries.length - 1]!.seq;
      }
      scheduleCounts();
    },
    [scheduleCounts, levelShown],
  );

  const resetView = useCallback(() => {
    bufferRef.current.clear();
    indexRef.current.clear();
    pendingRef.current = [];
    shownSeqRef.current = -1;
    termRef.current?.reset([]);
    scheduleCounts();
  }, [scheduleCounts]);

  const options = useMemo<LogOptions>(
    () => ({
      follow: follow && !tab.previous,
      tail_lines: tail,
      since_seconds: since,
      timestamps,
      previous: tab.previous,
    }),
    [follow, tail, since, timestamps, tab.previous],
  );

  const { status, restart } = useLogStream({
    clusterId,
    namespace: tab.namespace,
    pod: tab.pod,
    container: tab.container,
    options,
    onReset: resetView,
    onData: (data) => deliver(ingest(bufferRef.current.push(data))),
    onEnd: () => deliver(ingest(bufferRef.current.flush())),
  });

  const getEntries = useCallback(() => {
    const entries = bufferRef.current.entries;
    const limit = pausedRef.current ? shownSeqRef.current : Infinity;
    return entries.filter((e) => e.seq <= limit && levelShown(e.level));
  }, [levelShown]);

  // A new level filter repaints the terminal from the buffer.
  const levelsMounted = useRef(false);
  useEffect(() => {
    if (!levelsMounted.current) {
      levelsMounted.current = true;
      return;
    }
    termRef.current?.reset(getEntries());
  }, [filters.levels, getEntries]);

  const togglePause = useCallback(() => {
    if (!pausedRef.current) {
      pausedRef.current = true;
      setPaused(true);
      return;
    }
    pausedRef.current = false;
    setPaused(false);
    const backlog = pendingRef.current;
    pendingRef.current = [];
    setPending(0);
    if (backlog.length > 0) {
      const shown = backlog.filter((e) => levelShown(e.level));
      if (shown.length) termRef.current?.append(shown);
      shownSeqRef.current = backlog[backlog.length - 1]!.seq;
    }
    termRef.current?.scrollToBottom();
  }, [levelShown]);

  const clear = useCallback(() => {
    bufferRef.current.clear();
    indexRef.current.clear();
    pendingRef.current = [];
    termRef.current?.reset([]);
    scheduleCounts();
  }, [scheduleCounts]);

  const copyAll = useCallback(() => {
    const count = bufferRef.current.length;
    void copyText(bufferRef.current.text())
      .then(() =>
        pushToast('success', i18n.plural('Copied {count} line', 'Copied {count} lines', count)),
      )
      .catch((err: unknown) => pushToast('error', String(err)));
  }, [pushToast]);

  const baseName = `${tab.pod}${tab.container ? `-${tab.container}` : ''}${tab.previous ? '-previous' : ''}`;
  const save = useCallback(() => {
    void saveTextAs(`${baseName}.log`, `${bufferRef.current.text()}\n`)
      .then((path) => path && pushToast('success', i18n.t('Saved logs to {path}', { path })))
      .catch((err: unknown) => pushToast('error', String(err)));
  }, [baseName, pushToast]);

  const openSearch = useCallback(() => {
    if (structured) setFocusRequest((n) => n + 1);
    else termRef.current?.openSearch();
  }, [structured]);

  const onLineMenu = useCallback(
    (seq: number | null, x: number, y: number, selection: string) => {
      const line = seq === null ? undefined : bufferRef.current.bySeq(seq);
      const items: FileContextMenuEntry[] = [
        {
          id: 'copy-line',
          label: i18n.t('Copy line'),
          icon: <Copy size={12} />,
          disabled: !line,
          onClick: () => line && void copyText(stripAnsi(line.text)),
        },
        {
          id: 'copy-selection',
          label: i18n.t('Copy selection'),
          icon: <TextSelect size={12} />,
          disabled: !selection,
          onClick: () => void copyText(selection),
        },
        { id: 'copy-all', label: i18n.t('Copy all'), icon: <Copy size={12} />, onClick: copyAll },
        { id: 'sep', separator: true },
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
    },
    [copyAll, clear],
  );

  // Every buffered line is filtered out by level (checked only while narrowed).
  const hiddenByLevel =
    lineCount > 0 &&
    filters.levels.size < LEVEL_KEYS.length &&
    !bufferRef.current.entries.some((e) => levelShown(e.level));

  const emptyMessage = (
    <LogEmptyMessage status={status} previous={tab.previous} onRetry={restart} />
  );

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
      <LogToolbar
        status={status}
        paused={paused}
        pending={pending}
        lineCount={lineCount}
        containers={tab.containers}
        container={tab.container}
        follow={follow && !tab.previous}
        timestamps={timestamps}
        previous={tab.previous}
        wrap={wrap}
        since={since}
        tail={tail}
        defaultTail={defaultTail}
        onContainer={(container) => updateTab(clusterId, tab.id, { container })}
        onFollow={setFollow}
        onTimestamps={setTimestamps}
        onPrevious={(previous) => updateTab(clusterId, tab.id, { previous })}
        onWrap={setWrap}
        onSince={setSince}
        onTail={setTail}
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
        onLoki={() => openLokiForPod(clusterId, tab.namespace, tab.pod, tab.container)}
      />
      {structured && (
        <div className="bg-surface min-h-0 flex-1">
          <StructuredLogView
            index={indexRef.current}
            version={recordsVersion}
            counts={counts}
            filters={filters}
            maxId={paused ? shownSeqRef.current : Infinity}
            follow={follow && !paused}
            exportName={baseName}
            emptyState={emptyMessage}
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
          onContextMenu={onLineMenu}
        />
        {(lineCount === 0 || hiddenByLevel) && (
          <div
            className="text-fg-dim pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[11px]"
            style={{ backgroundColor: isDark ? XTERM_DARK_BG : XTERM_LIGHT_BG }}
          >
            {lineCount === 0 ? (
              emptyMessage
            ) : (
              <>
                {i18n.t('No lines at the selected levels.')}
                <button
                  type="button"
                  onClick={() => filters.setLevels(ALL_LEVELS)}
                  className="btn-chrome rounded-app-sm pointer-events-auto h-6 px-2.5 text-[11px] font-medium"
                >
                  {i18n.t('Show all levels')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {menu && <FileContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
});

function LogEmptyMessage({
  status,
  previous,
  onRetry,
}: {
  status: StreamStatus;
  previous: boolean;
  onRetry: () => void;
}) {
  i18n.useLocale();
  if (status.state === 'error')
    return (
      <>
        <span className="text-status-error max-w-xl text-[12px] break-words">{status.message}</span>
        <button
          type="button"
          onClick={onRetry}
          className="btn-chrome rounded-app-sm pointer-events-auto h-6 px-2.5 text-[11px] font-medium"
        >
          {i18n.t('Retry')}
        </button>
      </>
    );
  return (
    <>
      {status.state === 'connecting'
        ? i18n.t('Loading logs…')
        : status.state === 'streaming'
          ? i18n.t('Waiting for log output…')
          : status.state === 'ended'
            ? previous
              ? i18n.t('No logs from a previous container instance.')
              : i18n.t('No log lines.')
            : null}
    </>
  );
}
