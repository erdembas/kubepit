import * as i18n from '@/i18n';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardPaste, Copy, Eraser, RotateCcw, Search } from 'lucide-react';
import { FileContextMenu } from '@/components/ui/FileContextMenu';
import { events, ipc } from '@/lib/ipc';
import { IS_MAC, modChord } from '@/lib/platform';
import { xtermTheme } from '@/lib/xtermTheme';
import type { TerminalSpec } from '@/types';
import { copyText, openExternal, readText } from '../shared/platform';
import { useXtermSearch } from '../shared/useXtermSearch';
import { XtermSearchBar } from '../shared/XtermSearchBar';
import {
  NERD_FONT_STACK,
  decodeBase64,
  isDockToggleShortcut,
  isFindShortcut,
  useIsDark,
  writeError,
} from '../shared/xtermUtils';
import { TerminalActions, TerminalExitBanner, type TerminalEnd } from './TerminalOverlay';

interface Props {
  /** PTY id — the dock tab id, stable for the tab's lifetime. */
  id: string;
  spec: TerminalSpec;
  /** The tab is on screen (active tab, dock open, cluster tab visible). */
  active: boolean;
  fontSize: number;
  onClose: () => void;
}

/**
 * Port of RunHQ `TerminalPane`: xterm.js v6 + fit / search / unicode11 /
 * web-links, acknowledged PTY flow control, rAF-coalesced resizes that pause
 * while the pane is hidden, and a restart escape hatch. Kubernetes sessions
 * (pod exec/attach, node shells) arrive through the same `TerminalSpec` PTY.
 */
export const TerminalView = memo(function TerminalView({
  id,
  spec,
  active,
  fontSize,
  onClose,
}: Props) {
  i18n.useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const scheduleResizeRef = useRef<() => void>(() => undefined);
  const isDark = useIsDark();
  const search = useXtermSearch(termRef);
  const openSearchRef = useRef(search.openSearch);
  openSearchRef.current = search.openSearch;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  const [ended, setEnded] = useState<TerminalEnd | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  // Bumping the nonce tears down the xterm + PTY and spawns a fresh pair
  // for the same id — the escape hatch for exited or wedged sessions.
  const [restartNonce, setRestartNonce] = useState(0);
  const restart = useCallback(() => setRestartNonce((n) => n + 1), []);
  const specKey = JSON.stringify(spec);
  const specRef = useRef(spec);
  specRef.current = spec;

  const copySelection = useCallback(() => {
    const selection = termRef.current?.getSelection() ?? '';
    if (selection) void copyText(selection).catch(() => undefined);
    termRef.current?.focus();
  }, []);

  const paste = useCallback(() => {
    void readText()
      .then((text) => {
        if (text) termRef.current?.paste(text);
        termRef.current?.focus();
      })
      .catch((err: unknown) => console.warn('clipboard read failed', err));
  }, []);

  const clear = useCallback(() => {
    termRef.current?.clear();
    termRef.current?.focus();
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
    scheduleResizeRef.current();
  }, [fontSize]);

  useEffect(() => {
    if (!active) return;
    scheduleResizeRef.current();
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      if (!term) return;
      // Rows changed while the pane was display:none (theme, output) are
      // repainted only on demand; the size may not change on re-show.
      term.refresh(0, term.rows - 1);
      term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setEnded(null);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSizeRef.current,
      fontFamily: NERD_FONT_STACK,
      letterSpacing: 0,
      lineHeight: 1.25,
      scrollback: 10_000,
      allowProposedApi: true,
      allowTransparency: false,
      macOptionIsMeta: true,
      theme: xtermTheme(isDark),
    });
    termRef.current = term;

    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = '11';

    // The default link handler would navigate the app webview itself; route
    // through the OS opener so links land in the user's browser.
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

    // Handle app shortcuts before xterm turns them into shell input.
    term.attachCustomKeyEventHandler((event) => {
      if (isDockToggleShortcut(event)) return false;
      if (isFindShortcut(event)) {
        if (event.type === 'keydown') openSearchRef.current();
        return false;
      }
      const copyChord = IS_MAC
        ? event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'c'
        : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c';
      if (copyChord && term.hasSelection()) {
        if (event.type === 'keydown') void copyText(term.getSelection()).catch(() => undefined);
        return false;
      }
      if (!IS_MAC && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
        if (event.type === 'keydown') {
          void readText()
            .then((text) => text && term.paste(text))
            .catch(() => undefined);
        }
        return false;
      }
      return true;
    });

    let alive = true;
    let ready = false;
    let lastSize = '';
    const isVisible = () => container.clientWidth > 0 && container.clientHeight > 0;

    let unlistenExit: (() => void) | null = null;
    void events
      .onTerminalExit(({ id: exitedId, code }) => {
        if (!alive || exitedId !== id) return;
        setEnded({ kind: 'exited', code });
      })
      .then((unlisten) => {
        if (alive) unlistenExit = unlisten;
        else unlisten();
      });

    requestAnimationFrame(() => {
      if (!alive) return;
      if (isVisible()) {
        try {
          fit.fit();
        } catch {
          // Zero-sized container; the next resize recomputes.
        }
      }
      const { cols, rows } = term;
      lastSize = `${cols}x${rows}`;
      ipc
        .terminalCreate(id, specRef.current, cols, rows, (chunk) => {
          if (!alive) return;
          const bytes = decodeBase64(chunk.data);
          term.write(bytes, () => {
            if (!alive) return;
            void ipc.terminalAcknowledge(id, chunk.stream_id, bytes.length).catch((err) => {
              if (alive) console.warn('terminalAcknowledge failed', err);
            });
          });
        })
        .then(() => {
          ready = true;
          if (alive) scheduleResize();
        })
        .catch((err: unknown) => {
          if (!alive) return;
          const message = err instanceof Error ? err.message : String(err);
          writeError(term, i18n.t('Failed to start terminal: {message}', { message }));
          setEnded({ kind: 'failed', message });
        });
      if (isVisible()) term.focus();
    });

    const dataBinding = term.onData((data) => {
      const encoded = new TextEncoder().encode(data);
      void ipc.terminalWrite(id, Array.from(encoded)).catch((err: unknown) => {
        if (alive) console.warn('terminalWrite failed', err);
      });
    });

    let resizeRaf = 0;
    const flushResize = () => {
      resizeRaf = 0;
      if (!alive || !isVisible()) return;
      try {
        fit.fit();
        if (!ready) return;
        const { cols: c, rows: r } = term;
        const size = `${c}x${r}`;
        if (lastSize === size) return;
        lastSize = size;
        void ipc.terminalResize(id, c, r).catch((err: unknown) => {
          lastSize = '';
          console.warn('terminalResize failed', err);
        });
      } catch {
        // `fit.fit()` throws on zero dimensions (parent collapsed mid-teardown).
      }
    };
    const scheduleResize = () => {
      if (!alive || resizeRaf !== 0) return;
      resizeRaf = requestAnimationFrame(flushResize);
    };
    scheduleResizeRef.current = scheduleResize;
    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(container);
    const visibilityObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) scheduleResize();
    });
    visibilityObserver.observe(container);

    return () => {
      alive = false;
      termRef.current = null;
      scheduleResizeRef.current = () => undefined;
      searchBinding.dispose();
      dataBinding.dispose();
      unlistenExit?.();
      if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      void ipc.terminalDestroy(id).catch(() => undefined);
      term.dispose();
    };
    // `isDark` seeds the theme once (the theme effect mutates it in place);
    // `search.attach` is stable. `specKey` restarts the PTY when the target
    // changes and `restartNonce` is the user's explicit restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, specKey, restartNonce]);

  return (
    <div
      className="group/term bg-surface-muted relative h-full w-full overflow-hidden"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          hasSelection: termRef.current?.hasSelection() ?? false,
        });
      }}
    >
      {/* Padding lives on this wrapper: FitAddon measures the container itself. */}
      <div className="absolute inset-0 pt-1 pl-2">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {!search.open && (
        <TerminalActions
          onCopy={copySelection}
          onPaste={paste}
          onClear={clear}
          onFind={search.openSearch}
          onRestart={restart}
        />
      )}
      {search.open && <XtermSearchBar search={search} placeholder={i18n.t('Find…')} />}
      {ended && <TerminalExitBanner end={ended} onRestart={restart} onClose={onClose} />}
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              id: 'copy',
              label: i18n.t('Copy'),
              icon: <Copy size={12} />,
              hint: IS_MAC ? '⌘C' : 'Ctrl+Shift+C',
              disabled: !menu.hasSelection,
              onClick: copySelection,
            },
            {
              id: 'paste',
              label: i18n.t('Paste'),
              icon: <ClipboardPaste size={12} />,
              hint: IS_MAC ? '⌘V' : 'Ctrl+Shift+V',
              onClick: paste,
            },
            { id: 'sep1', separator: true },
            {
              id: 'find',
              label: i18n.t('Find…'),
              icon: <Search size={12} />,
              hint: modChord('F'),
              onClick: search.openSearch,
            },
            { id: 'clear', label: i18n.t('Clear'), icon: <Eraser size={12} />, onClick: clear },
            { id: 'sep2', separator: true },
            {
              id: 'restart',
              label: i18n.t('Restart terminal'),
              icon: <RotateCcw size={12} />,
              onClick: restart,
            },
          ]}
        />
      )}
    </div>
  );
});
