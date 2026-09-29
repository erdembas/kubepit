import * as i18n from '@/i18n';
import { Activity, Bell, Network, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { selectUnreadCount, useAlertStore } from '@/store/useAlertStore';
import { useAppStore, type RightPanel } from '@/store/useAppStore';

/**
 * VSCode-style vertical activity bar pinned to the FAR right edge of
 * the window. It's a thin, always-visible 36px rail of icons; clicking
 * an icon either opens the matching panel to its left, switches to
 * that panel if a different one was open, or collapses back to no
 * panel when the active icon is clicked again. The active icon shows
 * a left-side accent strip (mirroring VSCode's left-side strip on the
 * left activity bar — flipped here because we live on the right).
 *
 * The rail is the only handle on visibility; we deliberately do NOT
 * give individual panels their own close button. One control surface
 * = no ambiguity about which thing toggles what.
 */
interface RailItem {
  id: RightPanel;
  label: string;
  icon: typeof Activity;
  shortcut?: string;
}

const ITEMS: RailItem[] = [
  {
    id: 'assistant',
    get label() {
      return i18n.t('Assistant');
    },
    icon: Sparkles,
  },
  {
    id: 'events',
    get label() {
      return i18n.t('Warning events');
    },
    icon: Activity,
  },
  {
    id: 'forwards',
    get label() {
      return i18n.t('Port forwards');
    },
    icon: Network,
  },
  {
    id: 'alerts',
    get label() {
      return i18n.t('Notification center');
    },
    icon: Bell,
  },
];

export function RightActivityBar() {
  i18n.useLocale();
  const active = useAppStore((s) => s.rightPanel);
  const toggle = useAppStore((s) => s.toggleRightPanel);
  const assistantEnabled = useAppStore((s) => s.settings?.ai?.enabled ?? false);
  const unreadAlerts = useAlertStore(selectUnreadCount);

  return (
    <nav
      className="bg-surface border-border/60 z-30 flex w-9 shrink-0 flex-col items-center gap-1 border-l py-1.5"
      aria-label={i18n.t('Right activity bar')}
    >
      {ITEMS.filter((item) => item.id !== 'assistant' || assistantEnabled).map((item) => {
        const isActive = active === item.id;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => toggle(item.id)}
            // Tooltip carries the shortcut so users discover ⌘L
            // without us having to render a hint label.
            title={item.shortcut ? `${item.label} · ${item.shortcut}` : item.label}
            aria-label={item.label}
            aria-pressed={isActive}
            className={cn(
              'relative flex h-9 w-9 items-center justify-center rounded transition-colors',
              isActive ? 'text-fg' : 'text-fg-dim hover:text-fg hover:bg-fg/5',
            )}
          >
            {/* Active strip — sits on the LEFT edge of the icon
                button (which is the side facing the panel area), so
                the visual cue points at "this rail item is showing
                the panel to my left". */}
            {isActive && (
              <span
                aria-hidden
                className="bg-accent absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-r"
              />
            )}
            <Icon className="h-4 w-4" />
            {item.id === 'alerts' && unreadAlerts > 0 && (
              <span
                aria-hidden
                className="bg-status-error ring-surface absolute top-2 right-2 h-1.5 w-1.5 rounded-full ring-2"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
