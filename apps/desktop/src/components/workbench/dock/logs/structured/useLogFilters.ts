import { useCallback, useMemo, useRef, useState } from 'react';
import { ALL_LEVELS, levelVisible, type FieldFilter, type LevelSet } from '@/lib/logs/filter';
import type { LogLevel } from '@/lib/logs/levels';
import { usePersistentBoolean } from '@/lib/usePersistentBoolean';

export type LogMode = 'raw' | 'structured';

/**
 * Filter state shared by a log view's xterm (level filter only) and
 * structured modes: level set, field filters, free text and the extra
 * field columns. Refs mirror the state for stream callbacks. The mode is
 * a per-viewer preference (`storageKey`).
 */
export function useLogFilters(storageKey: string, structuredByDefault = false) {
  const [structured, setStructured] = usePersistentBoolean(storageKey, structuredByDefault);
  const [levels, setLevelsState] = useState<LevelSet>(ALL_LEVELS);
  const [filters, setFilters] = useState<FieldFilter[]>([]);
  const [text, setText] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const levelsRef = useRef(levels);

  const setLevels = useCallback((next: LevelSet) => {
    levelsRef.current = next;
    setLevelsState(next);
  }, []);

  /** Live check for stream callbacks (never stale). */
  const levelShown = useCallback(
    (level: LogLevel | null | undefined) => levelVisible(levelsRef.current, level),
    [],
  );

  const mode: LogMode = structured ? 'structured' : 'raw';
  return useMemo(
    () => ({
      mode,
      setMode: (next: LogMode) => setStructured(next === 'structured'),
      levels,
      setLevels,
      levelShown,
      filters,
      setFilters,
      text,
      setText,
      columns,
      setColumns,
      /** Anything narrowing the structured rows beyond levels. */
      narrowed: filters.length > 0 || text.trim() !== '',
    }),
    [mode, setStructured, levels, setLevels, levelShown, filters, text, columns],
  );
}

export type LogFilters = ReturnType<typeof useLogFilters>;
