import * as i18n from '@/i18n';
import { Bell, BellOff } from 'lucide-react';
import { alertSettingsOf, isSnoozed } from '@/lib/alerts/policy';
import { cn } from '@/lib/cn';
import { selectUnreadCount, useAlertStore } from '@/store/useAlertStore';
import { useAppStore } from '@/store/useAppStore';

/** Status bar bell: unread badge, toggles the notification center panel. */
export function AlertBell() {
  i18n.useLocale();
  const unread = useAlertStore(selectUnreadCount);
  const active = useAppStore((s) => s.rightPanel === 'alerts');
  const toggle = useAppStore((s) => s.toggleRightPanel);
  const settings = useAppStore((s) => s.settings);
  const alerts = alertSettingsOf(settings);
  const quiet = !alerts.enabled || isSnoozed(alerts, Date.now());
  const Icon = quiet ? BellOff : Bell;

  return (
    <button
      type="button"
      onClick={() => toggle('alerts')}
      className={cn(
        'hover:bg-surface-overlay hover:text-fg rounded-app-sm flex items-center gap-1.5 px-1.5 py-1 transition',
        active && 'text-fg',
      )}
      title={
        unread
          ? i18n.plural('{count} unread alert', '{count} unread alerts', unread)
          : i18n.t('Notification center')
      }
      aria-label={i18n.t('Notification center')}
    >
      <span className="relative">
        <Icon className={cn('h-3 w-3', unread > 0 && !quiet && 'text-accent')} />
        {unread > 0 && (
          <span className="bg-status-error ring-surface-raised absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1" />
        )}
      </span>
      {unread > 0 && <span className="text-fg tabular-nums">{unread > 99 ? '99+' : unread}</span>}
      <span className="text-fg-dim">{i18n.t('Alerts')}</span>
    </button>
  );
}
