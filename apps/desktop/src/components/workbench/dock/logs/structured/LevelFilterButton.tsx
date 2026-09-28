import * as i18n from '@/i18n';
import { useCallback, useState } from 'react';
import { ListFilter } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  ALL_LEVELS,
  levelsAtLeast,
  onlyLevel,
  toggleLevel,
  type LevelSet,
} from '@/lib/logs/filter';
import { LEVEL_KEYS, type LevelCounts } from '@/lib/logs/levels';
import { CheckMenu } from './CheckMenu';
import { LEVEL_DOT, levelKeyLabel } from './levelStyle';

/**
 * Toolbar button of the level filter (both log modes): a toggle per level
 * with its record count; Alt/Option-click shows only that level.
 */
export function LevelFilterButton({
  levels,
  counts,
  onChange,
}: {
  levels: LevelSet;
  counts: LevelCounts;
  onChange: (next: LevelSet) => void;
}) {
  i18n.useLocale();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const filtered = levels.size < LEVEL_KEYS.length;
  const label = filtered
    ? i18n.t('Levels: {levels}', {
        levels: LEVEL_KEYS.filter((k) => levels.has(k))
          .map(levelKeyLabel)
          .join(', '),
      })
    : i18n.t('Filter by level');
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={filtered}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: rect.left, y: rect.bottom + 4 });
        }}
        className={cn(
          'rounded-app-sm flex h-6.5 shrink-0 items-center gap-1.5 border px-2 text-[11.5px] font-medium whitespace-nowrap transition [&>svg]:h-3 [&>svg]:w-3',
          filtered
            ? 'border-accent/50 bg-accent/10 text-accent'
            : 'border-border bg-surface-muted/70 text-fg-muted hover:text-fg hover:bg-surface-overlay',
        )}
      >
        <ListFilter />
        <span className="hidden @5xl:inline">{i18n.t('Levels')}</span>
        {filtered && (
          <span className="flex items-center gap-0.5" aria-hidden>
            {LEVEL_KEYS.filter((k) => levels.has(k)).map((k) => (
              <span key={k} className={cn('h-1.5 w-1.5 rounded-full', LEVEL_DOT[k])} />
            ))}
          </span>
        )}
      </button>
      {menu && (
        <CheckMenu
          x={menu.x}
          y={menu.y}
          title={i18n.t('Levels')}
          onClose={close}
          items={LEVEL_KEYS.map((key) => ({
            id: key,
            label: levelKeyLabel(key),
            lang: key === 'none' ? undefined : 'en',
            checked: !filtered || levels.has(key),
            leading: <span className={cn('h-2 w-2 shrink-0 rounded-full', LEVEL_DOT[key])} />,
            hint: i18n.number(counts[key]),
            onToggle: (e) => onChange(e.altKey ? onlyLevel(levels, key) : toggleLevel(levels, key)),
          }))}
          actions={[
            { id: 'all', label: i18n.t('Show all levels'), onClick: () => onChange(ALL_LEVELS) },
            {
              id: 'warn',
              label: i18n.t('Warnings and errors only'),
              onClick: () => onChange(levelsAtLeast('warn')),
            },
          ]}
        />
      )}
    </>
  );
}
