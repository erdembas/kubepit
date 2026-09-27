import * as i18n from '@/i18n';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Eraser, Search, TextSelect } from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { modChord } from '@/lib/platform';
import { XTERM_DARK_BG, XTERM_LIGHT_BG } from '@/lib/xtermTheme';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type DockTab } from '@/store/useDockStore';
import type { ClusterId, LogOptions } from '@/types';
import { copyText } from '../shared/platform';
import { saveTextAs } from '../shared/saveFile';
import { isFindShortcut, useIsDark } from '../shared/xtermUtils';
import { stripAnsi } from './format';
import { LogBuffer, type LogEntry } from './logBuffer';
import { LogTerminal, type LogTerminalHandle } from './LogTerminal';
import { LogToolbar } from './LogToolbar';
import { useLogStream, type StreamStatus } from './useLogStream';

type LogsTab = Extract<DockTab, { kind: 'logs' }>;

interface Props {
  clusterId: ClusterId;
  tab: LogsTab;
  active: boolean;
}

/**
 * Pod logs tab: toolbar + xterm renderer over a bounded line buffer. The
 * stream restarts whenever the container or an option changes; pausing keeps
 * the stream flowing into the buffer but freezes the screen until resumed.
 */
export const LogView = memo(function LogView({ clusterId, tab, active }: Props) {
  i18n.useLocale();
  const fontSize = useAppStore((s) => s.settings?.terminal_font_size ?? 13);
  const defaultTail = useAppStore((s) => s.settings?.log_tail_lines ?? 1000);
  const pushToast = useAppStore((s) => s.pushToast);
  const updateTab = useDockStore((s) => s.updateTab);
  const isDark = useIsDark();

  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  const [tail, setTail] = useState<number | null>(defaultTail);
  const [wrap, setWrap] = useState(true);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(0);
  const [lineCount, setLineCount] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: FileContextMenuEntry[] } | null>(
    null,
  );

  const bufferRef = useRef(new LogBuffer());
  const termRef = useRef<LogTerminalHandle>(null);
  const pausedRef = useRef(false);
  const pendingRef = useRef<LogEntry[]>([]);
  const shownSeqRef = useRef(-1);
  const countTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const shownCountRef = useRef(0);
  // Chunks can arrive very fast; refresh counters at most ~4x per second —
  // except the first lines, which must lift the empty state right away.
  const scheduleCounts = useCallback(() => {
    const sync = () => {
      countTimer.current = undefined;
      shownCountRef.current = bufferRef.current.length;
      setLineCount(shownCountRef.current);
      setPending(pendingRef.current.length);
    };
    if ((shownCountRef.current === 0) !== (bufferRef.current.length === 0)) {
      clearTimeout(countTimer.current);
      sync();
      return;
    }
    if (countTimer.current === undefined) countTimer.current = setTimeout(sync, 250);
  }, []);

  useEffect(() => () => clearTimeout(countTimer.current), []);

  const deliver = useCallback(
    (entries: LogEntry[]) => {
      if (entries.length === 0) return;
      if (pausedRef.current) {
        for (const entry of entries) pendingRef.current.push(entry);
      } else {
        termRef.current?.append(entries);
        shownSeqRef.current = entries[entries.length - 1]!.seq;
      }
      scheduleCounts();
    },
    [scheduleCounts],
  );

  const resetView = useCallback(() => {
    bufferRef.current.clear();
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
    onData: (data) => deliver(bufferRef.current.push(data)),
    onEnd: () => deliver(bufferRef.current.flush()),
  });

  const getEntries = useCallback(() => {
    const entries = bufferRef.current.entries;
    return pausedRef.current ? entries.filter((e) => e.seq <= shownSeqRef.current) : entries;
  }, []);

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
      termRef.current?.append(backlog);
      shownSeqRef.current = backlog[backlog.length - 1]!.seq;
    }
    termRef.current?.scrollToBottom();
  }, []);

  const clear = useCallback(() => {
    bufferRef.current.clear();
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

  const save = useCallback(() => {
    const name = `${tab.pod}${tab.container ? `-${tab.container}` : ''}${tab.previous ? '-previous' : ''}.log`;
    void saveTextAs(name, `${bufferRef.current.text()}\n`)
      .then((path) => path && pushToast('success', i18n.t('Saved logs to {path}', { path })))
      .catch((err: unknown) => pushToast('error', String(err)));
  }, [tab.pod, tab.container, tab.previous, pushToast]);

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

  return (
    <div
      className="bg-surface-muted flex h-full w-full min-w-0 flex-col"
      onKeyDown={(event) => {
        if (isFindShortcut(event)) {
          event.preventDefault();
          termRef.current?.openSearch();
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
        onSearch={() => termRef.current?.openSearch()}
        onPauseToggle={togglePause}
        onClear={clear}
        onCopy={copyAll}
        onSave={save}
        onRetry={restart}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden pt-1 pl-2">
        <LogTerminal
          ref={termRef}
          active={active}
          isDark={isDark}
          fontSize={fontSize}
          wrap={wrap}
          getEntries={getEntries}
          onContextMenu={onLineMenu}
        />
        {lineCount === 0 && (
          <LogEmptyState
            status={status}
            previous={tab.previous}
            isDark={isDark}
            onRetry={restart}
          />
        )}
      </div>
      {menu && <FileContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
});

function LogEmptyState({
  status,
  previous,
  isDark,
  onRetry,
}: {
  status: StreamStatus;
  previous: boolean;
  isDark: boolean;
  onRetry: () => void;
}) {
  i18n.useLocale();
  const message =
    status.state === 'connecting'
      ? i18n.t('Loading logs…')
      : status.state === 'streaming'
        ? i18n.t('Waiting for log output…')
        : status.state === 'ended'
          ? previous
            ? i18n.t('No logs from a previous container instance.')
            : i18n.t('No log lines.')
          : null;
  return (
    <div
      className="text-fg-dim pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[11px]"
      style={{ backgroundColor: isDark ? XTERM_DARK_BG : XTERM_LIGHT_BG }}
    >
      {status.state === 'error' ? (
        <>
          <span className="text-status-error max-w-xl text-[12px] break-words">
            {status.message}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="btn-chrome rounded-app-sm pointer-events-auto h-6 px-2.5 text-[11px] font-medium"
          >
            {i18n.t('Retry')}
          </button>
        </>
      ) : (
        message
      )}
    </div>
  );
}
