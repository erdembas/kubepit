import * as i18n from '@/i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bell,
  BellOff,
  CheckCheck,
  Clock,
  OctagonAlert,
  Settings as SettingsIcon,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { openAlert, updateAlertSettings } from '@/lib/alerts/actions';
import {
  alertSettingsOf,
  groupByCluster,
  isSnoozed,
  mutedUntil,
  snoozeUntil,
  withMute,
  type SnoozeOption,
} from '@/lib/alerts/policy';
import { alertGroupNames, alertObjectPath, alertTitle } from '@/lib/alerts/text';
import { clusterColor } from '@/lib/clusterMeta';
import { cn } from '@/lib/cn';
import { formatAge } from '@/lib/format';
import { useAlertStore } from '@/store/useAlertStore';
import { useAppStore } from '@/store/useAppStore';
import type { Alert, ClusterDef } from '@/types';

function untilLabel(until: number): string {
  const sameDay = new Date(until).toDateString() === new Date().toDateString();
  return i18n.date(
    until,
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', hour: '2-digit', minute: '2-digit' },
  );
}

/**
 * Right-rail notification center: alerts of every cluster grouped by
 * cluster, newest first, with unread/cluster filters, mark read, clear,
 * snooze and per-cluster mute. Clicking an alert opens its object.
 */
export function AlertsPanel({ visible }: { visible: boolean }) {
  i18n.useLocale();
  const alerts = useAlertStore((s) => s.alerts);
  const clusters = useAppStore((s) => s.clusters);
  const settings = useAppStore((s) => s.settings);
  const openSettings = useAppStore((s) => s.openSettings);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [clusterFilter, setClusterFilter] = useState<string | null>(null);
  const [, setTick] = useState(0);

  // Re-render relative times every 30s while visible.
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  const now = Date.now();
  const alertSettings = alertSettingsOf(settings);
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const unread = alerts.filter((a) => !a.read).length;
  const filtered = alerts.filter(
    (a) => (!unreadOnly || !a.read) && (!clusterFilter || a.cluster_id === clusterFilter),
  );
  const groups = groupByCluster(filtered);
  const clusterIds = [...new Set(alerts.map((a) => a.cluster_id))];
  const filterActive = unreadOnly || clusterFilter != null;
  const scopeIds = filterActive ? filtered.map((a) => a.id) : null;
  const snoozed = isSnoozed(alertSettings, now);

  const markRead = () => {
    const ids = scopeIds ?? null;
    if (ids && !ids.length) return;
    void useAlertStore.getState().markRead(ids).catch(console.error);
  };
  const clear = () => {
    if (scopeIds && !scopeIds.length) return;
    void useAlertStore.getState().clear(scopeIds).catch(console.error);
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Bell className="text-accent h-3.5 w-3.5" />
        <h2 className="text-fg text-[12px] font-semibold">{i18n.t('Notifications')}</h2>
        {unread > 0 && (
          <span className="bg-accent/15 text-accent rounded-app-sm px-1.5 text-[10px] font-semibold tabular-nums">
            {unread}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <SnoozeMenu snoozed={snoozed} />
          <HeaderButton
            label={filterActive ? i18n.t('Mark shown as read') : i18n.t('Mark all as read')}
            onClick={markRead}
            disabled={!filtered.some((a) => !a.read)}
          >
            <CheckCheck className="h-3.5 w-3.5" />
          </HeaderButton>
          <HeaderButton
            label={filterActive ? i18n.t('Clear shown') : i18n.t('Clear all')}
            onClick={clear}
            disabled={!filtered.length}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </HeaderButton>
          <HeaderButton
            label={i18n.t('Notification settings')}
            onClick={() => openSettings('notifications')}
          >
            <SettingsIcon className="h-3.5 w-3.5" />
          </HeaderButton>
        </div>
      </header>

      {(snoozed || !alertSettings.enabled) && (
        <div className="border-border/60 bg-status-starting/8 text-fg-muted flex items-center gap-2 border-b px-3 py-2 text-[11px]">
          <BellOff className="text-status-starting h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {!alertSettings.enabled
              ? i18n.t('Alerts are turned off.')
              : i18n.t('Notifications snoozed until {time}.', {
                  time: untilLabel(alertSettings.snoozed_until ?? now),
                })}
          </span>
          <button
            type="button"
            onClick={() =>
              alertSettings.enabled
                ? void updateAlertSettings((s) => ({ ...s, snoozed_until: null }))
                : openSettings('notifications')
            }
            className="text-accent hover:bg-fg/5 rounded px-1.5 py-0.5 font-medium"
          >
            {alertSettings.enabled ? i18n.t('Resume') : i18n.t('Settings')}
          </button>
        </div>
      )}

      <div className="border-border/60 flex flex-wrap gap-1 border-b p-3">
        <FilterChip active={!unreadOnly} onClick={() => setUnreadOnly(false)}>
          {i18n.t('All')}
        </FilterChip>
        <FilterChip active={unreadOnly} onClick={() => setUnreadOnly(true)}>
          {i18n.t('Unread')}
        </FilterChip>
        {clusterIds.length > 1 && (
          <>
            <span className="bg-border/70 mx-1 my-0.5 w-px" aria-hidden />
            <FilterChip active={clusterFilter == null} onClick={() => setClusterFilter(null)}>
              {i18n.t('All clusters')}
            </FilterChip>
            {clusterIds.map((id) => {
              const cluster = byId.get(id);
              return (
                <FilterChip
                  key={id}
                  active={clusterFilter === id}
                  onClick={() => setClusterFilter(clusterFilter === id ? null : id)}
                >
                  <ClusterDot cluster={cluster} id={id} />
                  {cluster?.name ?? id}
                </FilterChip>
              );
            })}
          </>
        )}
      </div>

      <div className="overlay-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map(({ clusterId, alerts: items }) => {
          const cluster = byId.get(clusterId);
          const muted = mutedUntil(alertSettings, clusterId, now);
          return (
            <section key={clusterId}>
              <div className="flex items-center gap-2 px-2 pt-3 pb-1">
                <ClusterDot cluster={cluster} id={clusterId} />
                {/* Cluster names are usually context names: English casing. */}
                <span
                  lang="en"
                  className="text-fg-dim min-w-0 truncate text-[10px] font-semibold tracking-wider uppercase"
                >
                  {cluster?.name ?? clusterId}
                </span>
                <span className="text-fg-dim text-[10px] tabular-nums">{items.length}</span>
                {muted != null && (
                  <span className="text-fg-dim inline-flex items-center gap-1 text-[10px]">
                    <BellOff className="h-3 w-3" />
                    {muted === Infinity
                      ? i18n.t('Muted')
                      : i18n.t('Muted until {time}', { time: untilLabel(muted) })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void updateAlertSettings((s) =>
                      withMute(s, clusterId, muted != null ? undefined : null),
                    )
                  }
                  title={
                    muted != null
                      ? i18n.t('Unmute notifications from this cluster')
                      : i18n.t('Mute notifications from this cluster')
                  }
                  aria-label={
                    muted != null
                      ? i18n.t('Unmute notifications from this cluster')
                      : i18n.t('Mute notifications from this cluster')
                  }
                  className="text-fg-dim hover:bg-fg/5 hover:text-fg ml-auto rounded p-1"
                >
                  {muted != null ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
                </button>
              </div>
              {items.map((alert) => (
                <AlertRow key={alert.id} alert={alert} now={now} />
              ))}
            </section>
          );
        })}
        {!groups.length && (
          <div className="text-fg-dim px-4 py-10 text-center text-[12px] leading-relaxed">
            {alerts.length ? (
              i18n.t('No alerts match this filter.')
            ) : (
              <>
                <Bell className="text-fg-dim/60 mx-auto mb-2 h-5 w-5" />
                <p className="text-fg-muted font-medium">{i18n.t('No alerts')}</p>
                <p className="mt-1 text-[11px]">
                  {i18n.t(
                    'Kubepit watches connected clusters for crash loops, OOM kills, image pull errors, evictions, failed Jobs, unhealthy nodes and stuck rollouts.',
                  )}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AlertRow({ alert, now }: { alert: Alert; now: number }) {
  i18n.useLocale();
  const critical = alert.severity === 'critical';
  const Icon = critical ? OctagonAlert : TriangleAlert;
  const detail = alert.group ? alertGroupNames(alert) : alert.message;
  return (
    <button
      type="button"
      onClick={() => openAlert(alert)}
      title={i18n.t('Open in cluster')}
      className="hover:bg-fg/4 relative mb-0.5 w-full space-y-1 rounded-md py-2 pr-2.5 pl-3 text-left transition-colors"
    >
      {!alert.read && (
        <span aria-hidden className="bg-accent absolute top-2 bottom-2 left-0 w-[2px] rounded-r" />
      )}
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            critical ? 'text-status-error' : 'text-status-starting',
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12px]',
            alert.read ? 'text-fg-muted' : 'text-fg font-semibold',
          )}
        >
          {alertTitle(alert)}
        </span>
        {alert.count > 1 && (
          <span
            className={cn(
              'rounded px-1 text-[9.5px] tabular-nums',
              critical
                ? 'bg-status-error/12 text-status-error'
                : 'bg-status-starting/12 text-status-starting',
            )}
            title={i18n.plural('Seen {count} time', 'Seen {count} times', alert.count)}
          >
            ×{alert.count}
          </span>
        )}
        <span
          className="text-fg-dim shrink-0 text-[10px] tabular-nums"
          title={i18n.date(alert.last_seen, { dateStyle: 'medium', timeStyle: 'medium' })}
        >
          {formatAge(alert.last_seen, now)}
        </span>
      </div>
      {detail && (
        <p className="text-fg-muted line-clamp-2 pl-5.5 text-[11.5px] leading-snug">{detail}</p>
      )}
      <p className="text-fg-dim truncate pl-5.5 font-mono text-[10px]">
        <span className={critical ? 'text-status-error' : 'text-status-starting'}>
          {alert.reason}
        </span>
        {' · '}
        {alertObjectPath(alert)}
        {alert.container ? ` · ${alert.container}` : ''}
      </p>
    </button>
  );
}

function SnoozeMenu({ snoozed }: { snoozed: boolean }) {
  i18n.useLocale();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as HTMLElement)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const snooze = (option: SnoozeOption | null) => {
    setOpen(false);
    void updateAlertSettings((s) => ({
      ...s,
      snoozed_until: option ? snoozeUntil(option, Date.now()) : null,
    }));
  };
  const item =
    'text-fg-muted hover:bg-surface-overlay hover:text-fg flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] transition';

  return (
    <div ref={wrapRef} className="relative">
      <HeaderButton
        label={i18n.t('Snooze notifications')}
        onClick={() => setOpen((v) => !v)}
        active={open || snoozed}
      >
        <Clock className="h-3.5 w-3.5" />
      </HeaderButton>
      {open && (
        <div
          role="menu"
          aria-label={i18n.t('Snooze notifications')}
          className="border-border bg-surface-raised rounded-app-sm animate-fade-in absolute top-full right-0 z-50 mt-1.5 w-[190px] overflow-hidden border shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
        >
          <div className="text-fg-dim px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider uppercase">
            {i18n.t('Snooze notifications')}
          </div>
          <button type="button" role="menuitem" className={item} onClick={() => snooze('hour')}>
            {i18n.t('For 1 hour')}
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => snooze('tomorrow')}>
            {i18n.t('Until tomorrow')}
          </button>
          {snoozed && (
            <button
              type="button"
              role="menuitem"
              className={cn(item, 'border-border/60 border-t')}
              onClick={() => snooze(null)}
            >
              {i18n.t('Resume notifications')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'hover:bg-fg/5 hover:text-fg rounded-md p-1.5 transition disabled:pointer-events-none disabled:opacity-40',
        active ? 'text-accent' : 'text-fg-dim',
      )}
    >
      {children}
    </button>
  );
}

function ClusterDot({ cluster, id }: { cluster: ClusterDef | undefined; id: string }) {
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: clusterColor(cluster ?? { id, color: null }) }}
    />
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] transition',
        active ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-fg/5 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}
