import * as i18n from '@/i18n';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { xtermTheme } from '@/lib/xtermTheme';
import { copyText, openExternal } from '../shared/platform';
import { useXtermSearch } from '../shared/useXtermSearch';
import { XtermSearchBar } from '../shared/XtermSearchBar';
import { NERD_FONT_STACK, isDockToggleShortcut, isFindShortcut } from '../shared/xtermUtils';
import { formatLogLine } from './format';
import { MAX_LOG_LINES, type LogEntry } from './logBuffer';
import {
  appendLineWithMarker,
  disposeMarkers,
  pruneMarkers,
  seqAtPointer,
  type LineMarker,
} from './markers';
import { queueTerminalWrites } from './writeQueue';

export interface LogTerminalHandle {
  append: (entries: LogEntry[]) => void;
  /** Clear the screen and replay `entries` (new stream, wrap change, …). */
  reset: (entries: LogEntry[]) => void;
  scrollToBottom: () => void;
  openSearch: () => void;
}

interface Props {
  /** On screen; writes are deferred (and replayed in bounded batches) while hidden. */
  active: boolean;
  isDark: boolean;
  fontSize: number;
  wrap: boolean;
  /** Lines that should be on screen, for re-rendering after wrap / width changes. */
  getEntries: () => LogEntry[];
  onContextMenu: (seq: number | null, x: number, y: number, selection: string) => void;
}

interface Engine {
  append: (entries: LogEntry[]) => void;
  reset: (entries: LogEntry[]) => void;
  pump: () => void;
  scheduleResize: () => void;
}

/**
 * Read-only xterm log renderer — RunHQ `LogXtermView`, adapted to an
 * append-only pod log stream: ANSI colours render natively, the search
 * addon powers the find bar, and every entry carries a marker so a
 * right-click resolves to its source line.
 */
export const LogTerminal = forwardRef<LogTerminalHandle, Props>(function LogTerminal(
  { active, isDark, fontSize, wrap, getEntries, onContextMenu },
  ref,
) {
  i18n.useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const search = useXtermSearch(termRef);
  const openSearchRef = useRef(search.openSearch);
  openSearchRef.current = search.openSearch;
  const activeRef = useRef(active);
  activeRef.current = active;
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const getEntriesRef = useRef(getEntries);
  getEntriesRef.current = getEntries;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const initial = useRef({ isDark, fontSize });

  useImperativeHandle(
    ref,
    () => ({
      append: (entries) => engineRef.current?.append(entries),
      reset: (entries) => engineRef.current?.reset(entries),
      scrollToBottom: () => termRef.current?.scrollToBottom(),
      openSearch: () => openSearchRef.current(),
    }),
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'underline',
      cursorInactiveStyle: 'none',
      disableStdin: true,
      fontSize: initial.current.fontSize,
      fontFamily: NERD_FONT_STACK,
      letterSpacing: 0,
      lineHeight: 1.25,
      scrollback: MAX_LOG_LINES,
      allowProposedApi: true,
      allowTransparency: false,
      theme: xtermTheme(initial.current.isDark),
    });
    termRef.current = term;
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = '11';
    term.loadAddon(
      new WebLinksAddon((event, url) => {
        event.preventDefault();
        openExternal(url);
      }),
    );
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    const searchBinding = search.attach(searchAddon);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    term.attachCustomKeyEventHandler((event) => {
      if (isDockToggleShortcut(event)) return false;
      if (isFindShortcut(event)) {
        if (event.type === 'keydown') openSearchRef.current();
        return false;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'c' &&
        term.hasSelection()
      ) {
        if (event.type === 'keydown') void copyText(term.getSelection()).catch(() => undefined);
        return false;
      }
      return true;
    });

    let alive = true;
    let writing = false;
    let cancelWrites: (() => void) | null = null;
    let queue: LogEntry[] = [];
    let generation = 0;
    let lastCols = 0;
    const markers: LineMarker[] = [];
    const isVisible = () => container.clientWidth > 0 && container.clientHeight > 0;

    const pump = () => {
      if (!alive || writing || queue.length === 0 || !activeRef.current) return;
      writing = true;
      const batch = queue;
      queue = [];
      const opts = { wrap: wrapRef.current, cols: term.cols };
      cancelWrites = queueTerminalWrites({
        from: 0,
        to: batch.length,
        append: (index) => {
          const entry = batch[index]!;
          appendLineWithMarker(term, entry.seq, formatLogLine(entry.text, opts), markers);
          return entry.text.length + 16;
        },
        drain: (done) => term.write('', done),
        onDone: () => {
          writing = false;
          cancelWrites = null;
          if (markers.length > MAX_LOG_LINES * 1.2) pruneMarkers(markers);
          pump();
        },
      });
    };

    const append = (entries: LogEntry[]) => {
      if (entries.length === 0) return;
      for (const entry of entries) queue.push(entry);
      if (queue.length > MAX_LOG_LINES * 1.1) queue = queue.slice(-MAX_LOG_LINES);
      pump();
    };

    const reset = (entries: LogEntry[]) => {
      cancelWrites?.();
      cancelWrites = null;
      writing = true;
      queue = entries.length > MAX_LOG_LINES ? entries.slice(-MAX_LOG_LINES) : entries.slice();
      const gen = ++generation;
      // Let already-submitted writes drain first, otherwise they would land
      // after the reset (xterm keeps its own write buffer).
      term.write('', () => {
        if (!alive || gen !== generation) return;
        disposeMarkers(markers);
        term.reset();
        writing = false;
        pump();
      });
    };

    let rerenderTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRerender = () => {
      clearTimeout(rerenderTimer);
      rerenderTimer = setTimeout(() => reset(getEntriesRef.current()), 120);
    };

    let resizeRaf = 0;
    const flushResize = () => {
      resizeRaf = 0;
      if (!alive || !isVisible()) return;
      try {
        fit.fit();
      } catch {
        return; // Zero-sized while hidden; the next resize recomputes.
      }
      if (term.cols !== lastCols) {
        const hadWidth = lastCols > 0;
        lastCols = term.cols;
        // Truncated (no-wrap) lines depend on the width; wrapped ones reflow.
        if (!wrapRef.current && hadWidth) scheduleRerender();
      }
      pump();
    };
    const scheduleResize = () => {
      if (!alive || resizeRaf !== 0) return;
      resizeRaf = requestAnimationFrame(flushResize);
    };
    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(container);
    scheduleResize();

    const onContextMenuEvent = (event: MouseEvent) => {
      event.preventDefault();
      const screen = container.querySelector<HTMLElement>('.xterm-screen') ?? container;
      const seq = seqAtPointer(term, markers, screen, event.clientX, event.clientY);
      onContextMenuRef.current(seq, event.clientX, event.clientY, term.getSelection());
    };
    container.addEventListener('contextmenu', onContextMenuEvent);

    engineRef.current = { append, reset, pump, scheduleResize };

    return () => {
      alive = false;
      engineRef.current = null;
      termRef.current = null;
      cancelWrites?.();
      clearTimeout(rerenderTimer);
      if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf);
      resizeObserver.disconnect();
      container.removeEventListener('contextmenu', onContextMenuEvent);
      searchBinding.dispose();
      disposeMarkers(markers);
      term.dispose();
    };
    // Mount once; theme, font size, wrap and visibility are applied in place below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(isDark);
    term.refresh(0, term.rows - 1);
  }, [isDark]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    engineRef.current?.scheduleResize();
  }, [fontSize]);

  const wrapMounted = useRef(false);
  useEffect(() => {
    if (!wrapMounted.current) {
      wrapMounted.current = true;
      return;
    }
    engineRef.current?.reset(getEntriesRef.current());
  }, [wrap]);

  useEffect(() => {
    if (!active) return;
    engineRef.current?.scheduleResize();
    engineRef.current?.pump();
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      if (term) term.refresh(0, term.rows - 1);
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {search.open && <XtermSearchBar search={search} placeholder={i18n.t('Find in logs…')} />}
    </div>
  );
});
