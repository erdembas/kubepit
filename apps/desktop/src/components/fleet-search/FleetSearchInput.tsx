import * as i18n from '@/i18n';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, CornerDownLeft, Loader2, ScanSearch, Square, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { scanSearchInput, splitSearchDraft, type SearchToken } from '@/lib/fleet/searchQuery';
import {
  suggestSearchInput,
  type SearchSuggestion,
  type SearchSuggestionContext,
} from '@/lib/fleet/searchSuggestions';

type Editor = { filters: SearchToken[]; draft: string };

function serialize(editor: Editor) {
  return [...editor.filters.map((filter) => filter.raw), editor.draft].filter(Boolean).join(' ');
}

function filterKey(token: SearchToken) {
  if (token.type === 'label') return token.key ?? 'label';
  switch (token.field) {
    case 'kind':
      return 'kind';
    case 'namespace':
      return 'ns';
    case 'cluster':
      return 'cluster';
    case 'environment':
      return 'env';
    default:
      return token.key ?? 'label';
  }
}

function filterValue(token: SearchToken) {
  if (token.operator === 'exists') return i18n.t('Exists');
  if (token.operator === 'not-exists') return i18n.t('Does not exist');
  if (token.operator === '!=')
    return i18n.t('Not {value}', { value: token.value || i18n.t('(empty)') });
  return token.value || i18n.t('(empty)');
}

function suggestionGroup(category: SearchSuggestion['category']) {
  switch (category) {
    case 'field':
      return i18n.t('Search filters');
    case 'kind':
      return i18n.t('Resource kinds');
    case 'namespace':
      return i18n.t('Known namespaces');
    case 'cluster':
      return i18n.t('Clusters');
    case 'environment':
      return i18n.t('Environments');
    case 'label-key':
      return i18n.t('Label keys');
    case 'label-value':
      return i18n.t('Known label values');
  }
}

function fieldDescription(value: string) {
  switch (value) {
    case 'kind:':
      return i18n.t('Filter by resource kind');
    case 'ns:':
      return i18n.t('Filter by namespace');
    case 'cluster:':
      return i18n.t('Filter by cluster name');
    case 'env:':
      return i18n.t('Filter by environment');
    case 'label:':
      return i18n.t('Resources with a label key');
    default:
      return '';
  }
}

/** The store keeps the original query syntax; this editor turns committed filters into chips. */
export function FleetSearchInput({
  value,
  onChange,
  context,
  running,
  onCancel,
  inputRef,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  context: SearchSuggestionContext;
  running: boolean;
  onCancel: () => void;
  inputRef: RefObject<HTMLInputElement>;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  i18n.useLocale();
  const id = useId();
  const [editor, setEditor] = useState<Editor>(() =>
    splitSearchDraft(value, true, context.apiResources),
  );
  const emitted = useRef(value);
  const [caret, setCaret] = useState(editor.draft.length);
  const nextCaret = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const choseWithArrows = useRef(false);
  const shell = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const suggestions = suggestSearchInput(editor.draft, caret, context, 12);
  const current = suggestions[Math.min(active, suggestions.length - 1)];
  const typedFilter = scanSearchInput(editor.draft, context.apiResources).some(
    (token) => token.type !== 'text',
  );
  const expanded = open && (suggestions.length > 0 || typedFilter);

  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    const next = splitSearchDraft(value, true, context.apiResources);
    setEditor(next);
    setCaret(next.draft.length);
    nextCaret.current = next.draft.length;
    setActive(0);
    setOpen(Boolean(next.draft) && document.activeElement === inputRef.current);
  }, [value, context.apiResources, inputRef]);

  useLayoutEffect(() => {
    if (nextCaret.current === null) return;
    inputRef.current?.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [editor, inputRef]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const rect = shell.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const flip = below < 220 && above > below;
    const width = Math.min(rect.width, window.innerWidth - 24);
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      width,
      maxHeight: Math.max(120, Math.min(380, flip ? above : below)),
      ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
  }, [expanded, editor]);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: Event) => {
      if (
        !shell.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', resize);
    };
  }, [expanded]);

  useEffect(() => {
    if (expanded)
      panel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [expanded, active, editor.draft]);

  const publish = (next: Editor, selection = next.draft.length) => {
    if (!next.draft.trim()) next = { ...next, draft: '' };
    selection = Math.min(selection, next.draft.length);
    const raw = serialize(next);
    emitted.current = raw;
    setEditor(next);
    setCaret(selection);
    nextCaret.current = selection;
    onChange(raw);
  };

  const commit = (draft = editor.draft) => {
    const split = splitSearchDraft(draft, true, context.apiResources);
    if (!split.filters.length) return false;
    publish({ filters: [...editor.filters, ...split.filters], draft: split.draft });
    setOpen(false);
    return true;
  };

  const choose = (suggestion: SearchSuggestion) => {
    const draft =
      editor.draft.slice(0, suggestion.start) +
      suggestion.value +
      editor.draft.slice(suggestion.end);
    const isKey =
      suggestion.category === 'field' ||
      (suggestion.category === 'label-key' && /[=:]$/.test(suggestion.value));
    if (isKey) {
      publish({ ...editor, draft }, suggestion.start + suggestion.value.length);
      setOpen(true);
    } else {
      const split = splitSearchDraft(draft, true, context.apiResources);
      publish({ filters: [...editor.filters, ...split.filters], draft: split.draft });
      setOpen(false);
    }
    setActive(0);
    choseWithArrows.current = false;
    inputRef.current?.focus();
  };

  const remove = (index: number) => {
    publish({ ...editor, filters: editor.filters.filter((_, i) => i !== index) });
    inputRef.current?.focus();
    setOpen(false);
  };

  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && expanded && suggestions.length) {
      event.preventDefault();
      event.stopPropagation();
      choseWithArrows.current = true;
      setActive(
        (index) =>
          (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length,
      );
      return;
    }
    // Enter preserves a valid manually typed filter (e.g. cluster:prod is
    // intentionally a substring). Arrow keys or Tab opt into completion.
    const activeToken = scanSearchInput(editor.draft, context.apiResources).find(
      (token) => token.start <= caret && caret <= token.end,
    );
    if (
      event.key === 'Enter' &&
      !choseWithArrows.current &&
      activeToken?.type !== 'text' &&
      activeToken?.complete &&
      activeToken.valid &&
      commit()
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey && editor.draft.trim())) &&
      expanded &&
      current
    ) {
      event.preventDefault();
      event.stopPropagation();
      choose(current);
      return;
    }
    if (event.key === 'Enter' && commit()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Backspace' && !editor.draft.trim() && editor.filters.length) {
      event.preventDefault();
      const last = editor.filters[editor.filters.length - 1]!;
      publish({ filters: editor.filters.slice(0, -1), draft: last.raw });
      setActive(0);
      setOpen(true);
      return;
    }
    if (event.key === 'Tab') setOpen(false);
    onKeyDown(event);
  };

  return (
    <>
      <div
        ref={shell}
        className="border-border/80 bg-surface-raised/70 focus-within:border-accent/45 flex min-h-12 items-start gap-2.5 rounded-xl border px-3 py-2 transition"
      >
        {running ? (
          <Loader2 className="text-accent mt-1.5 h-4 w-4 shrink-0 animate-spin" />
        ) : (
          <ScanSearch className="text-fg-dim mt-1.5 h-4 w-4 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {editor.filters.map((filter, index) => (
            <span
              key={`${index}:${filter.raw}`}
              title={filter.raw}
              className="border-accent/20 bg-accent/8 inline-flex max-w-full items-center overflow-hidden rounded-md border text-[11px]"
            >
              <span className="text-accent/80 shrink-0 px-2 py-1 font-mono">
                {filterKey(filter)}
              </span>
              <span className="border-accent/15 text-fg min-w-0 truncate border-l px-2 py-1 font-mono">
                {filterValue(filter)}
              </span>
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label={i18n.t('Remove filter {filter}', { filter: filter.raw })}
                className="text-fg-dim hover:bg-fg/6 hover:text-fg focus-visible:text-accent flex h-6 w-6 shrink-0 items-center justify-center outline-none"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={editor.draft}
            onChange={(event) => {
              const raw = event.target.value;
              const split = (event.nativeEvent as InputEvent).isComposing
                ? { filters: [], draft: raw }
                : splitSearchDraft(raw, false, context.apiResources);
              const selection = event.target.selectionStart ?? raw.length;
              const removedBefore = split.filters.reduce(
                (n, token) => n + (token.end <= selection ? token.end - token.start : 0),
                0,
              );
              publish(
                { filters: [...editor.filters, ...split.filters], draft: split.draft },
                Math.min(split.draft.length, Math.max(0, selection - removedBefore)),
              );
              setActive(0);
              choseWithArrows.current = false;
              setOpen(true);
            }}
            onSelect={(event) =>
              setCaret(event.currentTarget.selectionStart ?? editor.draft.length)
            }
            onFocus={() => {
              setActive(0);
              choseWithArrows.current = false;
              setOpen(true);
            }}
            onBlur={() => {
              setOpen(false);
              commit();
            }}
            onKeyDown={handleKey}
            role="combobox"
            aria-expanded={expanded}
            aria-controls={expanded ? `${id}-suggestions` : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              expanded && current
                ? `${id}-option-${Math.min(active, suggestions.length - 1)}`
                : undefined
            }
            aria-label={i18n.t('Fleet search')}
            placeholder={
              editor.filters.length
                ? i18n.t('Add a filter or search by name…')
                : i18n.t('Search by name or add a filter…')
            }
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            className="text-fg placeholder:text-fg-dim/80 h-7 min-w-[130px] flex-1 bg-transparent font-mono text-[13px] outline-none"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {running && (
            <button
              type="button"
              onClick={onCancel}
              aria-label={i18n.t('Stop search')}
              className="text-fg-dim hover:text-fg hover:bg-fg/6 flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              <span className="hidden sm:inline">{i18n.t('Stop')}</span>
            </button>
          )}
          {value && (
            <button
              type="button"
              aria-label={i18n.t('Clear search')}
              onClick={() => {
                publish({ filters: [], draft: '' });
                inputRef.current?.focus();
                setOpen(false);
              }}
              className="text-fg-dim hover:text-fg hover:bg-fg/6 flex h-6 w-6 items-center justify-center rounded-md"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {expanded &&
        position &&
        createPortal(
          <div
            ref={panel}
            style={position}
            className="border-border/80 bg-surface-raised fixed z-[200] flex flex-col overflow-hidden rounded-xl border shadow-[0_12px_36px_rgb(0_0_0/0.22)]"
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="border-border/50 text-fg-dim flex items-center justify-between gap-3 border-b px-3 py-2 text-[10px] tracking-[0.1em] uppercase">
              <span>
                {current ? suggestionGroup(current.category) : i18n.t('Filter suggestions')}
              </span>
              <span className="tracking-normal normal-case">
                {i18n.t('Choose a value or keep typing')}
              </span>
            </div>
            <div
              id={`${id}-suggestions`}
              role="listbox"
              aria-label={i18n.t('Filter suggestions')}
              className="overlay-scroll min-h-0 overflow-y-auto p-1"
            >
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.id}
                  id={`${id}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={current?.id === suggestion.id}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(suggestion)}
                  className={cn(
                    'relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[12px] transition-colors',
                    current?.id === suggestion.id
                      ? 'bg-fg/6 text-fg shadow-[inset_2px_0_0_rgb(var(--accent))]'
                      : 'text-fg-muted hover:bg-fg/4',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{suggestion.label}</span>
                  <span className="text-fg-dim max-w-[55%] truncate text-[11px]">
                    {suggestion.category === 'field'
                      ? fieldDescription(suggestion.value)
                      : suggestion.category === 'label-key'
                        ? i18n.t('Label')
                        : suggestion.detail}
                  </span>
                  {current?.id === suggestion.id && (
                    <CornerDownLeft className="text-fg-dim h-3 w-3 shrink-0" />
                  )}
                </button>
              ))}
              {!suggestions.length && (
                <p className="text-fg-dim px-3 py-4 text-[12px]">
                  {i18n.t('No known values match. You can type your own filter.')}
                </p>
              )}
            </div>
            <div className="border-border/50 text-fg-dim flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-[10px]">
              <span className="inline-flex items-center gap-1">
                <ArrowDown className="h-3 w-3" />
                {i18n.t('↑↓ navigate')}
              </span>
              <span>{i18n.t('Enter or Tab to select')}</span>
              <span>{i18n.t('Esc to dismiss')}</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
