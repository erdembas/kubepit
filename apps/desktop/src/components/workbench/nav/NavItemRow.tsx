import * as i18n from '@/i18n';
import { memo } from 'react';
import { Star } from 'lucide-react';
import type { NavItem } from '@/lib/kube/nav';
import { cn } from '@/lib/cn';

export const NavItemRow = memo(function NavItemRow({
  item,
  active,
  pinned,
  indent = false,
  onSelect,
  onTogglePin,
}: {
  item: NavItem;
  active: boolean;
  pinned: boolean;
  indent?: boolean;
  onSelect: (key: string) => void;
  onTogglePin: (key: string) => void;
}) {
  i18n.useLocale();
  const Icon = item.icon;
  return (
    <div className="group relative">
      <button
        type="button"
        data-nav-item={item.key}
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelect(item.key)}
        title={
          item.gvk ? `${item.gvk.kind}${item.gvk.group ? ` · ${item.gvk.group}` : ''}` : undefined
        }
        className={cn(
          'relative flex w-full items-center gap-2 rounded-md py-[5px] pr-7 text-left text-[12.5px] transition-colors',
          indent ? 'pl-7' : 'pl-2.5',
          active ? 'bg-fg/7 text-fg font-medium' : 'text-fg-muted hover:bg-fg/4 hover:text-fg',
        )}
      >
        {active && (
          <span
            className="bg-accent absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full"
            aria-hidden
          />
        )}
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            active ? 'text-accent' : 'text-fg-dim group-hover:text-fg-muted',
          )}
        />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </button>
      {item.key !== '' && (
        <button
          type="button"
          aria-label={
            pinned
              ? i18n.t('Unpin {kind}', { kind: item.label })
              : i18n.t('Pin {kind}', { kind: item.label })
          }
          title={pinned ? i18n.t('Unpin') : i18n.t('Pin to top')}
          aria-pressed={pinned}
          onClick={() => onTogglePin(item.key)}
          className={cn(
            'absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded transition',
            pinned
              ? 'text-accent opacity-70 hover:opacity-100'
              : 'text-fg-dim hover:text-fg opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        >
          <Star className={cn('h-3 w-3', pinned && 'fill-current')} />
        </button>
      )}
    </div>
  );
});
