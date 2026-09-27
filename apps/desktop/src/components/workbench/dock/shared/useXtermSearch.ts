import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { IDisposable, Terminal } from '@xterm/xterm';
import type { SearchAddon } from '@xterm/addon-search';
import { XTERM_SEARCH_DECORATIONS } from '@/lib/xtermTheme';
import type { MatchInfo } from './xtermUtils';

/**
 * Floating find-bar state shared by the terminal and the log view — the
 * search half of RunHQ's `TerminalPane` / `LogXtermView`, extracted so both
 * dock bodies behave identically (live search, Enter / Shift+Enter, Esc
 * returns focus to xterm, selection pre-fills the query).
 */
export function useXtermSearch(termRef: RefObject<Terminal | null>) {
  const searchRef = useRef<SearchAddon | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchInfo, setMatchInfo] = useState<MatchInfo | null>(null);

  /** Wire a freshly created addon; dispose the result with the terminal. */
  const attach = useCallback((search: SearchAddon): IDisposable => {
    searchRef.current = search;
    const results = search.onDidChangeResults((event) => {
      if (!event || event.resultCount === 0 || event.resultIndex < 0) setMatchInfo(null);
      else setMatchInfo({ index: event.resultIndex + 1, count: event.resultCount });
    });
    return {
      dispose: () => {
        results.dispose();
        if (searchRef.current === search) searchRef.current = null;
      },
    };
  }, []);

  const run = useCallback((value: string, direction: 'next' | 'prev') => {
    const search = searchRef.current;
    if (!search || !value) return;
    const opts = { decorations: XTERM_SEARCH_DECORATIONS };
    if (direction === 'next') search.findNext(value, opts);
    else search.findPrevious(value, opts);
  }, []);

  const openSearch = useCallback(() => {
    const selection = termRef.current?.getSelection() ?? '';
    if (selection && !selection.includes('\n')) setQuery(selection);
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [termRef]);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setMatchInfo(null);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  }, [termRef]);

  // Live search as the user types (sub-millisecond on a large buffer).
  useEffect(() => {
    if (!open) return;
    if (!query) {
      searchRef.current?.clearDecorations();
      setMatchInfo(null);
      return;
    }
    run(query, 'next');
  }, [open, query, run]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run(query, e.shiftKey ? 'prev' : 'next');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
      }
    },
    [query, run, closeSearch],
  );

  return {
    attach,
    inputRef,
    open,
    query,
    setQuery,
    matchInfo,
    openSearch,
    closeSearch,
    onKeyDown,
    next: () => run(query, 'next'),
    prev: () => run(query, 'prev'),
  };
}

export type XtermSearch = ReturnType<typeof useXtermSearch>;
