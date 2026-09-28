import * as i18n from '@/i18n';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Columns3, Copy, FileDown, X } from 'lucide-react';
import { FileContextMenu, type FileContextMenuEntry } from '@/components/ui/FileContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { useAppStore } from '@/store/useAppStore';
import { cn } from '@/lib/cn';
import {
  compileFieldFilters,
  formatFieldFilter,
  levelVisible,
  onlyLevel,
  parseFieldFilter,
  sameFilter,
  textMatcher,
  toggleLevel,
  type FieldFilter,
  type FieldOp,
} from '@/lib/logs/filter';
import { jsonLines } from '@/lib/logs/jsonLines';
import { LEVEL_KEYS, type LevelCounts } from '@/lib/logs/levels';
import {
  lineBody,
  parsedRecord,
  recordText,
  type LogRecord,
  type RecordIndex,
} from '@/lib/logs/records';
import { RowFilter } from '@/lib/logs/rowFilter';
import {
  discoverFields,
  recordDetailObject,
  recordField,
  recordsToCsv,
  recordsToJsonLines,
  type ExportContext,
} from '@/lib/logs/structured';
import { formatLogTime } from '@/lib/logs/time';
import { copyText } from '../../shared/platform';
import { saveTextAs } from '../../shared/saveFile';
import { CheckMenu } from './CheckMenu';
import { JSON_LINE_HEIGHT, JsonView } from './JsonView';
import { LEVEL_DOT, LEVEL_TEXT, LevelBadge, levelKeyLabel } from './levelStyle';
import type { LogFilters } from './useLogFilters';

const ROW_HEIGHT = 22;
const OVERSCAN = 12;
const MAX_DETAIL = 360;
/** Below this width the source column folds into the message cell. */
const NARROW = 620;

export interface SourceColumn {
  label: (record: LogRecord) => string;
  /** CSS colour of the source dot (pod palette). */
  color?: (record: LogRecord) => string | undefined;
  /** Source-level fields: `pod`, `container`, stream labels… */
  fields?: (record: LogRecord) => Record<string, string> | undefined;
}

interface Props {
  index: RecordIndex;
  /** `index.version` at the parent's last sync (re-render trigger). */
  version: number;
  counts: LevelCounts;
  filters: LogFilters;
  source?: SourceColumn;
  /** Extra visibility rule (the merged view's legend); change `hiddenKey` with it. */
  hidden?: (record: LogRecord) => boolean;
  hiddenKey?: string;
  /** Hide records newer than this (paused streams). */
  maxId?: number;
  /** Keep the newest row in view while the user is at the bottom. */
  follow: boolean;
  /** Dates in the time column (ranges beyond a day). */
  showDate?: boolean;
  /** File name stem of exports. */
  exportName: string;
  /** Shown when the index has no records yet. */
  emptyState?: ReactNode;
  /** Bumped by the parent's Find shortcut: focuses the filter input. */
  focusRequest?: number;
}

/**
 * Structured mode of the log views: level chips with counts, field filters
 * (`key=value`, `key!=value`, `key~regex`, `key!~regex`, free text), a
 * column picker over the discovered fields and export of the filtered
 * records, above a virtualized table (time, source, level, message, extra
 * fields). Clicking a row expands its pretty JSON; clicking a value there
 * or in a field column adds a filter. Rows are filtered incrementally, so
 * streams with tens of thousands of lines stay smooth.
 */
export const StructuredLogView = memo(function StructuredLogView({
  index,
  version,
  counts,
  filters,
  source,
  hidden,
  hiddenKey = '',
  maxId = Infinity,
  follow,
  showDate = false,
  exportName,
  emptyState,
  focusRequest = 0,
}: Props) {
  i18n.useLocale();
  const pushToast = useAppStore((s) => s.pushToast);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<
    | { kind: 'columns'; x: number; y: number }
    | { kind: 'export'; x: number; y: number }
    | { kind: 'row'; x: number; y: number; record: LogRecord }
    | null
  >(null);
  const atBottom = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus();
  }, [focusRequest]);
  const rowFilter = useRef(new RowFilter());
  const closeMenu = useCallback(() => setMenu(null), []);

  const { levels, setLevels, text, setText, columns, setColumns } = filters;
  const fieldFilters = filters.filters;
  const setFieldFilters = filters.setFilters;
  const ctx = useMemo<ExportContext>(
    () => ({ sourceLabel: source?.label, sourceFields: source?.fields }),
    [source],
  );

  // -- Rows ----------------------------------------------------------------
  const compiled = useMemo(() => compileFieldFilters(fieldFilters), [fieldFilters]);
  const matchText = useMemo(() => textMatcher(text), [text]);
  const filterKey = useMemo(
    () => JSON.stringify([[...levels].sort(), fieldFilters, text.trim(), hiddenKey]),
    [levels, fieldFilters, text, hiddenKey],
  );
  const test = useCallback(
    (record: LogRecord) =>
      levelVisible(levels, record.level) &&
      !hidden?.(record) &&
      compiled.test((key) => recordField(record, key, source?.fields, source?.label)) &&
      matchText(recordText(record)),
    [levels, hidden, compiled, source, matchText],
  );
  // `version` is the change signal: the index mutates in place.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => {
    rowFilter.current.update(index, filterKey, test, maxId);
    return rowFilter.current.rows;
  }, [index, version, filterKey, test, maxId]);

  // Field suggestions and the column picker (sampled from the newest records).
  const fields = useMemo(
    () => (menu?.kind === 'columns' || draft.length > 0 ? discoverFields(index.records) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, menu?.kind, draft.length > 0, version],
  );

  // -- Layout ----------------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry?.contentRect;
      if (rect) setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const narrow = size.width > 0 && size.width < NARROW;
  const showSource = !!source && !narrow;
  const timeWidth = showDate ? 170 : narrow ? 70 : 94;
  const template = [
    `${timeWidth}px`,
    showSource ? '150px' : null,
    '54px',
    'minmax(180px,1fr)',
    ...columns.map(() => '140px'),
  ]
    .filter(Boolean)
    .join(' ');
  const minWidth = timeWidth + (showSource ? 150 : 0) + 54 + 180 + columns.length * 140 + 16;

  // Expanded rows: their detail heights, in row order.
  const details = useMemo(() => {
    const out = new Map<
      number,
      { lines: ReturnType<typeof jsonLines>; extra: string[]; height: number }
    >();
    for (const id of expanded) {
      const record = index.bySeq(id);
      if (!record) continue;
      const lines = jsonLines(recordDetailObject(record, ctx), 400);
      const extra = record.lines.length > 1 ? record.lines.slice(1).map(lineBody) : [];
      const content = (lines.length + extra.length) * JSON_LINE_HEIGHT + (extra.length ? 10 : 0);
      out.set(id, { lines, extra, height: Math.min(MAX_DETAIL, content + 34) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, index, version, ctx]);

  const expandedRows = useMemo(() => {
    const out: { index: number; height: number }[] = [];
    for (const [id, detail] of details) {
      let lo = 0;
      let hi = rows.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const rid = rows[mid]!.id;
        if (rid === id) {
          out.push({ index: mid, height: detail.height });
          break;
        }
        if (rid < id) lo = mid + 1;
        else hi = mid - 1;
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }, [details, rows]);

  const extraTotal = expandedRows.reduce((n, r) => n + r.height, 0);
  const totalHeight = rows.length * ROW_HEIGHT + extraTotal;

  const topOf = useCallback(
    (i: number) => {
      let extra = 0;
      for (const r of expandedRows) {
        if (r.index >= i) break;
        extra += r.height;
      }
      return i * ROW_HEIGHT + extra;
    },
    [expandedRows],
  );
  const indexAt = useCallback(
    (y: number) => {
      let extra = 0;
      for (const r of expandedRows) {
        const top = r.index * ROW_HEIGHT + extra;
        if (y < top) break;
        if (y < top + ROW_HEIGHT + r.height) return r.index;
        extra += r.height;
      }
      return Math.floor((y - extra) / ROW_HEIGHT);
    },
    [expandedRows],
  );

  const viewport = Math.max(size.height - ROW_HEIGHT, 0);
  const start = Math.max(0, indexAt(scrollTop) - OVERSCAN);
  const end = Math.min(rows.length, indexAt(scrollTop + viewport) + OVERSCAN + 1);

  // Stick to the newest row while following and at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow || !atBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, follow, totalHeight]);

  useEffect(() => {
    // New filters start at the newest rows when following, else at the top.
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = follow ? el.scrollHeight : 0;
    atBottom.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // -- Actions ---------------------------------------------------------------
  const addFilter = useCallback(
    (filter: FieldFilter) => {
      if (fieldFilters.some((f) => sameFilter(f, filter))) return;
      // A new `key=` replaces the opposite filter on the same key and value.
      const next = fieldFilters.filter((f) => !(f.key === filter.key && f.value === filter.value));
      setFieldFilters([...next, filter]);
    },
    [fieldFilters, setFieldFilters],
  );
  const pick = useCallback(
    (key: string, op: FieldOp, value: string) => addFilter({ key, op, value }),
    [addFilter],
  );

  const commitDraft = () => {
    const value = draft.trim();
    if (!value) return;
    const parsed = parseFieldFilter(value);
    if (parsed) addFilter(parsed);
    else setText(value);
    setDraft('');
  };

  const toggleRow = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exportRows = (format: 'jsonl' | 'csv') => {
    const body =
      format === 'jsonl' ? recordsToJsonLines(rows, ctx) : recordsToCsv(rows, columns, ctx);
    const name = `${exportName}.${format === 'jsonl' ? 'jsonl' : 'csv'}`;
    const filter =
      format === 'jsonl'
        ? { name: i18n.t('JSON lines'), extensions: ['jsonl', 'json'] }
        : { name: i18n.t('CSV files'), extensions: ['csv'] };
    void saveTextAs(name, body, filter)
      .then(
        (path) =>
          path &&
          pushToast(
            'success',
            i18n.plural(
              'Exported {count} record to {path}',
              'Exported {count} records to {path}',
              rows.length,
              {
                path,
              },
            ),
          ),
      )
      .catch((err: unknown) => pushToast('error', String(err)));
  };

  const rowMenu = useCallback(
    (record: LogRecord, x: number, y: number) => setMenu({ kind: 'row', x, y, record }),
    [],
  );
  const showLevel = useCallback(
    (level: LogRecord['level']) => setLevels(onlyLevel(levels, level ?? 'none')),
    [levels, setLevels],
  );

  const rowMenuItems = (record: LogRecord): FileContextMenuEntry[] => [
    {
      id: 'copy-line',
      label: i18n.t('Copy line'),
      icon: <Copy size={12} />,
      onClick: () => void copyText(recordText(record)),
    },
    {
      id: 'copy-json',
      label: i18n.t('Copy as JSON'),
      icon: <Copy size={12} />,
      onClick: () => void copyText(JSON.stringify(recordDetailObject(record, ctx), null, 2)),
    },
    { id: 'sep', separator: true },
    {
      id: 'only-level',
      label: i18n.t('Show only this level'),
      disabled: !record.level,
      onClick: () => setLevels(onlyLevel(levels, record.level ?? 'none')),
    },
    ...(source
      ? [
          {
            id: 'only-source',
            label: i18n.t('Show only this source'),
            onClick: () => addFilter({ key: 'source', op: '=', value: source.label(record) }),
          },
        ]
      : []),
  ];

  // -- Render ----------------------------------------------------------------
  const visibleLevels = LEVEL_KEYS.filter((k) => counts[k] > 0 || !levels.has(k));
  const allLevels = levels.size === LEVEL_KEYS.length;
  const suggestions = draft && !/[=~]/.test(draft) ? fields.slice(0, 30) : [];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="border-border/60 bg-surface @container flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <div
          className="flex shrink-0 items-center gap-0.5"
          role="group"
          aria-label={i18n.t('Levels')}
        >
          {visibleLevels.map((key) => {
            const on = allLevels || levels.has(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={!allLevels && on}
                title={i18n.t('{level}: {count} (click to toggle, Alt: only this level)', {
                  level: levelKeyLabel(key),
                  count: i18n.number(counts[key]),
                })}
                onClick={(e) =>
                  setLevels(e.altKey ? onlyLevel(levels, key) : toggleLevel(levels, key))
                }
                className={cn(
                  'rounded-app-sm flex h-5.5 items-center gap-1 px-1.5 text-[10.5px] tabular-nums transition',
                  on ? 'hover:bg-fg/8' : 'opacity-40 hover:opacity-70',
                  !allLevels && on && 'bg-fg/6',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', LEVEL_DOT[key])} />
                <span
                  lang={key === 'none' ? undefined : 'en'}
                  className={cn(
                    'hidden font-semibold tracking-[0.06em] uppercase @3xl:inline',
                    LEVEL_TEXT[key],
                  )}
                >
                  {levelKeyLabel(key)}
                </span>
                <span className="text-fg-muted">{i18n.number(counts[key])}</span>
              </button>
            );
          })}
        </div>
        <span aria-hidden className="bg-border/70 h-4 w-px shrink-0" />
        <div className="main-tabbar-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {fieldFilters.map((f) => {
            const bad = compiled.invalid.includes(f);
            return (
              <span
                key={formatFieldFilter(f)}
                title={bad ? i18n.t('Invalid regular expression') : undefined}
                className={cn(
                  'rounded-app-sm flex h-5.5 shrink-0 items-center gap-1 border pr-0.5 pl-1.5 font-mono text-[10.5px]',
                  bad
                    ? 'border-status-error/50 text-status-error'
                    : f.op.startsWith('!')
                      ? 'border-border text-fg-muted decoration-fg-dim/50 line-through'
                      : 'border-accent/40 bg-accent/8 text-fg',
                )}
              >
                <span className="max-w-64 truncate">{formatFieldFilter(f)}</span>
                <button
                  type="button"
                  aria-label={i18n.t('Remove filter {filter}', { filter: formatFieldFilter(f) })}
                  onClick={() => setFieldFilters(fieldFilters.filter((g) => g !== f))}
                  className="text-fg-dim hover:text-fg hover:bg-fg/10 flex h-4 w-4 items-center justify-center rounded-sm"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            );
          })}
          {text.trim() && (
            <span className="rounded-app-sm border-accent/40 bg-accent/8 text-fg flex h-5.5 shrink-0 items-center gap-1 border pr-0.5 pl-1.5 text-[10.5px]">
              <span className="max-w-48 truncate">“{text.trim()}”</span>
              <button
                type="button"
                aria-label={i18n.t('Clear text search')}
                onClick={() => setText('')}
                className="text-fg-dim hover:text-fg hover:bg-fg/10 flex h-4 w-4 items-center justify-center rounded-sm"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          )}
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
              } else if (e.key === 'Escape') {
                setDraft('');
              } else if (e.key === 'Backspace' && !draft && fieldFilters.length) {
                setFieldFilters(fieldFilters.slice(0, -1));
              }
            }}
            list={suggestions.length ? `${exportName}-fields` : undefined}
            spellCheck={false}
            placeholder={i18n.t('Filter: key=value, key!=value, key~regex or text')}
            aria-label={i18n.t('Filter records')}
            className="text-fg placeholder:text-fg-dim h-6 min-w-28 flex-1 bg-transparent font-mono text-[11px] outline-none"
          />
          {suggestions.length > 0 && (
            <datalist id={`${exportName}-fields`}>
              {suggestions.map((f) => (
                <option key={f.key} value={`${f.key}=`} />
              ))}
            </datalist>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <span className="text-fg-dim mr-1 hidden text-[10.5px] whitespace-nowrap tabular-nums @2xl:inline">
            {i18n.plural('{count} record', '{count} records', rows.length)}
          </span>
          <IconButton
            size="xs"
            label={i18n.t('Columns')}
            icon={<Columns3 />}
            tone={columns.length ? 'accent' : 'default'}
            className={cn(columns.length > 0 && 'text-accent')}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ kind: 'columns', x: rect.right - 220, y: rect.bottom + 4 });
            }}
          />
          <IconButton
            size="xs"
            label={i18n.t('Export filtered records…')}
            icon={<FileDown />}
            disabled={rows.length === 0}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ kind: 'export', x: rect.right - 220, y: rect.bottom + 4 });
            }}
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrollTop(el.scrollTop);
          atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
        }}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        <div style={{ minWidth }}>
          <div
            role="row"
            className="border-border/60 bg-surface text-fg-dim sticky top-0 z-10 grid items-center border-b px-2 text-[10px] font-semibold tracking-[0.08em] uppercase"
            style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}
          >
            <span>{i18n.t('Time')}</span>
            {showSource && <span>{i18n.t('Source')}</span>}
            <span>{i18n.t('Level')}</span>
            <span>{i18n.t('Message')}</span>
            {columns.map((c) => (
              <span key={c} className="group flex min-w-0 items-center gap-1 pr-2">
                <span lang="en" className="truncate" title={c}>
                  {c}
                </span>
                <button
                  type="button"
                  aria-label={i18n.t('Remove column {column}', { column: c })}
                  onClick={() => setColumns(columns.filter((x) => x !== c))}
                  className="hover:text-fg opacity-0 group-hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
          <div role="rowgroup" style={{ height: totalHeight, position: 'relative' }}>
            {rows.slice(start, end).map((record, offset) => {
              const i = start + offset;
              const detail = details.get(record.id);
              return (
                <Row
                  key={record.id}
                  record={record}
                  top={topOf(i)}
                  template={template}
                  showDate={showDate}
                  narrow={narrow}
                  source={source}
                  showSource={showSource}
                  columns={columns}
                  detail={detail}
                  onToggle={toggleRow}
                  onPick={pick}
                  onLevel={showLevel}
                  onMenu={rowMenu}
                />
              );
            })}
          </div>
        </div>
        {rows.length === 0 && (
          <div className="text-fg-dim absolute inset-0 top-[22px] flex flex-col items-center justify-center gap-2 px-6 text-center text-[11.5px]">
            {index.records.length === 0 ? (
              emptyState
            ) : (
              <>
                {i18n.t('No records match the filters.')}
                <button
                  type="button"
                  onClick={() => {
                    setFieldFilters([]);
                    setText('');
                    setLevels(new Set(LEVEL_KEYS));
                  }}
                  className="btn-chrome rounded-app-sm h-6 px-2.5 text-[11px] font-medium"
                >
                  {i18n.t('Clear filters')}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {menu?.kind === 'columns' && (
        <CheckMenu
          x={menu.x}
          y={menu.y}
          title={i18n.t('Columns')}
          empty={i18n.t('No fields found in these records.')}
          onClose={closeMenu}
          items={[
            ...columns
              .filter((c) => !fields.some((f) => f.key === c))
              .map((c) => ({ key: c, count: 0 })),
            ...fields.slice(0, 40),
          ].map((f) => ({
            id: f.key,
            label: f.key,
            lang: 'en',
            checked: columns.includes(f.key),
            hint: f.count ? i18n.number(f.count) : undefined,
            onToggle: () =>
              setColumns(
                columns.includes(f.key) ? columns.filter((c) => c !== f.key) : [...columns, f.key],
              ),
          }))}
          actions={
            columns.length
              ? [{ id: 'none', label: i18n.t('Hide all columns'), onClick: () => setColumns([]) }]
              : []
          }
        />
      )}
      {menu?.kind === 'export' && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            {
              id: 'jsonl',
              label: i18n.t('Export as JSON lines…'),
              hint: '.jsonl',
              icon: <FileDown size={12} />,
              onClick: () => exportRows('jsonl'),
            },
            {
              id: 'csv',
              label: i18n.t('Export as CSV…'),
              hint: '.csv',
              icon: <FileDown size={12} />,
              onClick: () => exportRows('csv'),
            },
          ]}
        />
      )}
      {menu?.kind === 'row' && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={rowMenuItems(menu.record)}
        />
      )}
    </div>
  );
});

interface RowProps {
  record: LogRecord;
  top: number;
  template: string;
  showDate: boolean;
  narrow: boolean;
  source?: SourceColumn;
  showSource: boolean;
  columns: string[];
  detail?: { lines: ReturnType<typeof jsonLines>; extra: string[]; height: number };
  onToggle: (id: number) => void;
  onPick: (key: string, op: FieldOp, value: string) => void;
  onLevel: (level: LogRecord['level']) => void;
  onMenu: (record: LogRecord, x: number, y: number) => void;
}

const Row = memo(function Row({
  record,
  top,
  template,
  showDate,
  narrow,
  source,
  showSource,
  columns,
  detail,
  onToggle,
  onPick,
  onLevel,
  onMenu,
}: RowProps) {
  const parsed = parsedRecord(record);
  const firstLine = parsed.message || lineBody(record.lines[0]!);
  const message = firstLine.includes('\n')
    ? firstLine.slice(0, firstLine.indexOf('\n'))
    : firstLine;
  const more = record.lines.length - 1;
  const label = source?.label(record);
  const color = source?.color?.(record);
  const time =
    parsed.time === null
      ? '—'
      : formatLogTime(parsed.time, showDate).slice(0, narrow && !showDate ? 8 : undefined);
  return (
    <div style={{ position: 'absolute', top, left: 0, right: 0 }}>
      <div
        role="row"
        aria-expanded={!!detail}
        onClick={() => onToggle(record.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(record, e.clientX, e.clientY);
        }}
        className={cn(
          'hover:bg-fg/4 relative grid cursor-default items-center px-2 text-[11.5px]',
          detail && 'bg-fg/4',
        )}
        style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}
      >
        {detail && (
          <span aria-hidden className="bg-accent absolute top-0 bottom-0 left-0 w-[2px]" />
        )}
        <span className="text-fg-dim truncate font-mono text-[10.5px] tabular-nums">{time}</span>
        {showSource && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (label) onPick('source', e.altKey ? '!=' : '=', label);
            }}
            title={label}
            className="text-fg-muted hover:text-fg flex min-w-0 items-center gap-1.5 pr-2 text-left font-mono text-[10.5px]"
          >
            {color && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
            )}
            <span className="truncate">{label}</span>
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onLevel(record.level);
          }}
          className="flex text-left"
        >
          <LevelBadge level={record.level} />
        </button>
        <span className="flex min-w-0 items-center gap-1.5 pr-2">
          {!showSource && label && (
            <span className="text-fg-dim shrink-0 font-mono text-[10.5px]" title={label}>
              {color && (
                <span
                  className="mr-1 inline-block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: color }}
                />
              )}
              {label.length > 18 ? `${label.slice(0, 17)}…` : label}
            </span>
          )}
          <span
            className={cn(
              'text-fg truncate font-mono',
              !parsed.message && parsed.format === 'json' && 'text-fg-muted',
            )}
          >
            {message}
          </span>
          {more > 0 && (
            <span className="bg-fg/8 text-fg-muted shrink-0 rounded px-1 text-[10px] tabular-nums">
              +{more}
            </span>
          )}
        </span>
        {columns.map((c) => {
          const value = parsed.fields[c] ?? source?.fields?.(record)?.[c];
          return value === undefined ? (
            <span key={c} className="text-fg-dim/60">
              —
            </span>
          ) : (
            <button
              key={c}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPick(c, e.altKey ? '!=' : '=', value);
              }}
              title={value}
              className="text-fg-muted hover:text-fg truncate pr-2 text-left font-mono text-[10.5px]"
            >
              {value}
            </button>
          );
        })}
      </div>
      {detail && (
        <div
          className="border-border/50 bg-surface-muted/60 overflow-auto border-y px-4 py-2"
          style={{ height: detail.height }}
          onClick={(e) => e.stopPropagation()}
        >
          <JsonView lines={detail.lines} onPick={onPick} />
          {detail.extra.length > 0 && (
            <pre
              className="text-fg-muted mt-2.5 font-mono text-[11px]"
              style={{ lineHeight: `${JSON_LINE_HEIGHT}px` }}
            >
              {detail.extra.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
