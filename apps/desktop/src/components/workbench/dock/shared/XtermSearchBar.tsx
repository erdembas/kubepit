import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { XtermSearch } from './useXtermSearch';

/** RunHQ `LogXtermSearchBar` — floating top-right find bar over an xterm. */
export function XtermSearchBar({
  search,
  placeholder,
}: {
  search: XtermSearch;
  placeholder: string;
}) {
  i18n.useLocale();
  const { matchInfo, query } = search;
  return (
    <div
      className={cn(
        'border-border bg-surface-raised shadow-lg',
        'absolute top-2 right-3 z-20 flex items-center gap-1',
        'rounded-app-sm border px-1.5 py-1',
      )}
      // Keep clicks in the bar from reaching xterm, which would steal focus on mouseup.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        ref={search.inputRef}
        type="text"
        value={query}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={search.onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={cn(
          'border-border bg-surface-muted/70 text-fg placeholder:text-fg-dim',
          'focus:border-accent/60 focus:bg-surface',
          'rounded-app-sm h-6 w-44 border px-2 text-[12px] transition focus:outline-none',
        )}
      />
      <span
        className={cn(
          'text-fg-dim min-w-[44px] px-1 text-center font-mono text-[10.5px] tabular-nums',
          matchInfo === null && query !== '' && 'text-status-error',
        )}
      >
        {matchInfo
          ? `${matchInfo.index}/${matchInfo.count}`
          : query === ''
            ? '0/0'
            : i18n.t('no match')}
      </span>
      <SearchBarButton
        label={i18n.t('Previous match (Shift+Enter)')}
        onClick={search.prev}
        icon={<ChevronUp className="h-3 w-3" />}
      />
      <SearchBarButton
        label={i18n.t('Next match (Enter)')}
        onClick={search.next}
        icon={<ChevronDown className="h-3 w-3" />}
      />
      <SearchBarButton
        label={i18n.t('Close (Esc)')}
        onClick={search.closeSearch}
        icon={<X className="h-3 w-3" />}
      />
    </div>
  );
}

function SearchBarButton({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="text-fg-dim hover:bg-surface-overlay hover:text-fg flex h-5 w-5 items-center justify-center rounded transition"
    >
      {icon}
    </button>
  );
}
