import * as i18n from '@/i18n';
import type { LucideIcon } from 'lucide-react';
import { History, LayoutDashboard, Network, Search, Settings as SettingsIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IS_MAC, modChord } from '@/lib/platform';
import {
  ACTIVITY_TAB_KEY,
  DASHBOARD_TAB_KEY,
  PORT_FORWARDS_TAB_KEY,
  SEARCH_TAB_KEY,
  SETTINGS_TAB_KEY,
  useAppStore,
} from '@/store/useAppStore';
import { openFleetSearch } from '@/store/useFleetSearchStore';

interface FleetItem {
  tabKey: string;
  label: string;
  icon: LucideIcon;
  hint?: string;
  count?: number;
  run: () => void;
}

/** Fleet-wide destinations (every cluster at once), above the cluster tree. */
export function FleetNav({ expanded }: { expanded: boolean }) {
  i18n.useLocale();
  const forwards = useAppStore((s) => s.portForwards.length);
  const activeKey = useAppStore((s) => s.activeMainTabKey);
  const items: FleetItem[] = [
    {
      tabKey: DASHBOARD_TAB_KEY,
      label: i18n.t('Overview'),
      icon: LayoutDashboard,
      run: () => useAppStore.getState().goHome(),
    },
    {
      tabKey: SEARCH_TAB_KEY,
      label: i18n.t('Fleet search'),
      icon: Search,
      hint: modChord(IS_MAC ? '⇧F' : 'Shift+F'),
      run: () => openFleetSearch(),
    },
    {
      tabKey: PORT_FORWARDS_TAB_KEY,
      label: i18n.t('Port forwards'),
      icon: Network,
      count: forwards,
      run: () => useAppStore.getState().openMainTab({ kind: 'port-forwards' }),
    },
    {
      tabKey: ACTIVITY_TAB_KEY,
      label: i18n.t('Activity'),
      icon: History,
      run: () => useAppStore.getState().openMainTab({ kind: 'activity' }),
    },
  ];
  return (
    <nav
      aria-label={i18n.t('Fleet')}
      className={cn('flex flex-col gap-px py-1.5', expanded ? 'px-2' : 'items-center')}
    >
      {items.map((item) => (
        <FleetNavRow
          key={item.tabKey}
          item={item}
          active={activeKey === item.tabKey}
          expanded={expanded}
        />
      ))}
    </nav>
  );
}

/** Settings sits at the bottom of the rail, like an IDE's gear. */
export function SettingsNavRow({ expanded }: { expanded: boolean }) {
  i18n.useLocale();
  const active = useAppStore((s) => s.activeMainTabKey === SETTINGS_TAB_KEY);
  return (
    <div
      className={cn(
        'border-border/60 flex shrink-0 border-t py-1.5',
        expanded ? 'flex-col px-2' : 'justify-center',
      )}
    >
      <FleetNavRow
        item={{
          tabKey: SETTINGS_TAB_KEY,
          label: i18n.t('Settings'),
          icon: SettingsIcon,
          hint: modChord(','),
          run: () => useAppStore.getState().openSettings(),
        }}
        active={active}
        expanded={expanded}
      />
    </div>
  );
}

function FleetNavRow({
  item,
  active,
  expanded,
}: {
  item: FleetItem;
  active: boolean;
  expanded: boolean;
}) {
  const Icon = item.icon;
  if (!expanded)
    return (
      <button
        type="button"
        onClick={item.run}
        title={item.hint ? `${item.label} (${item.hint})` : item.label}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active ? 'bg-fg/7 text-accent' : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {!!item.count && (
          <span className="bg-accent absolute top-1 right-1 h-1.5 w-1.5 rounded-full" aria-hidden />
        )}
      </button>
    );
  return (
    <button
      type="button"
      data-explorer-item=""
      onClick={item.run}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group/fleet relative flex w-full items-center gap-2 rounded-md py-[5px] pr-2 pl-2.5 text-left text-[12.5px] transition-colors',
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
          active ? 'text-accent' : 'text-fg-dim group-hover/fleet:text-fg-muted',
        )}
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {!!item.count && (
        <span className="bg-accent/15 text-accent rounded-md px-1.5 text-[10px] font-normal tabular-nums">
          {i18n.number(item.count)}
        </span>
      )}
      {item.hint && !item.count && (
        <span className="text-fg-dim font-mono text-[10px] font-normal opacity-0 transition-opacity group-hover/fleet:opacity-100">
          {item.hint}
        </span>
      )}
    </button>
  );
}
