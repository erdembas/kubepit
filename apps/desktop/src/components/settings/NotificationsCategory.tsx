import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import {
  notificationPermission,
  postNotification,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '@/lib/alerts/notify';
import {
  ALERT_REASONS,
  alertSettingsOf,
  isSnoozed,
  mutedUntil,
  snoozeUntil,
  withMute,
} from '@/lib/alerts/policy';
import { reasonDescription } from '@/lib/alerts/text';
import { clusterColor } from '@/lib/clusterMeta';
import { useAppStore } from '@/store/useAppStore';
import type { AlertSettings } from '@/types';
import { useSettingsDraft } from './categories';
import { SettingsPageShell, SettingsSection } from './SettingsView';

const parsePatterns = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);

/** Comma-separated globs, committed on blur / Enter so typing stays free. */
function PatternInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  label: string;
}) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value]);
  const commit = () => onChange(parsePatterns(text));
  return (
    <Input
      mono
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

function untilText(until: number) {
  return i18n.date(until, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Settings → Notifications: alert monitor, OS notifications, filters, clusters. */
export function NotificationsCategory({ description }: { description: string }) {
  i18n.useLocale();
  const { draft, update, footer } = useSettingsDraft();
  const clusters = useAppStore((s) => s.clusters);
  const [permission, setPermission] = useState<NotificationPermissionState | null>(null);

  useEffect(() => {
    void notificationPermission()
      .then(setPermission)
      .catch(() => setPermission('unsupported'));
  }, []);

  if (!draft) {
    return <p className="text-fg-dim text-[12px]">{i18n.t('Loading settings…')}</p>;
  }
  const alerts = alertSettingsOf(draft);
  const set = (patch: Partial<AlertSettings>) => update('alerts', { ...alerts, ...patch });
  const now = Date.now();

  const test = async () => {
    const state = await requestNotificationPermission().catch(
      () => 'unsupported' as NotificationPermissionState,
    );
    setPermission(state);
    if (state !== 'granted') return;
    await postNotification({
      title: i18n.t('Kubepit notifications are on'),
      body: i18n.t('New alerts from your clusters will appear like this.'),
    }).catch((e) =>
      useAppStore.getState().pushToast('error', e instanceof Error ? e.message : String(e)),
    );
  };

  const permissionText: Record<NotificationPermissionState, string> = {
    granted: i18n.t('Notifications are allowed.'),
    default: i18n.t('Kubepit has not asked for permission yet.'),
    denied: i18n.t('Notifications are blocked. Allow them for Kubepit in your system settings.'),
    unsupported: i18n.t('This environment cannot show notifications.'),
  };

  return (
    <SettingsPageShell description={description} footer={footer}>
      <SettingsSection title={i18n.t('Alerts')}>
        <Switch
          checked={alerts.enabled}
          onChange={(v) => set({ enabled: v })}
          label={i18n.t('Watch connected clusters for alerts')}
          description={i18n.t(
            'Kubepit watches pods, Jobs, nodes and Deployments while a cluster is connected and reports changes for the worse. Problems that already exist when you connect are not reported. Read-only clusters are watched too.',
          )}
        />
      </SettingsSection>

      <SettingsSection
        title={i18n.t('Desktop notifications')}
        description={i18n.t(
          'Alerts always appear in the notification center (the bell in the status bar); these options control system notifications.',
        )}
      >
        <div className="space-y-3">
          <Switch
            checked={alerts.os_notifications}
            disabled={!alerts.enabled}
            onChange={(v) => set({ os_notifications: v })}
            label={i18n.t('Show a system notification for new alerts')}
            description={i18n.t(
              'Clicking a desktop notification brings Kubepit to the front and opens the alert (within 10 seconds).',
            )}
          />
          <Switch
            checked={alerts.background_only}
            disabled={!alerts.enabled || !alerts.os_notifications}
            onChange={(v) => set({ background_only: v })}
            label={i18n.t('Only when Kubepit is in the background')}
            description={i18n.t(
              'While a Kubepit window is focused, new alerts show a toast instead.',
            )}
          />
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<BellRing className="h-3.5 w-3.5" />}
              onClick={() => void test()}
            >
              {i18n.t('Send a test notification')}
            </Button>
            {permission && (
              <span className="text-fg-dim text-[11.5px]">{permissionText[permission]}</span>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={i18n.t('Snooze')}
        description={
          isSnoozed(alerts, now)
            ? i18n.t('System notifications are paused until {time}.', {
                time: untilText(alerts.snoozed_until ?? now),
              })
            : i18n.t('Pause system notifications for a while. Alerts are still collected.')
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => set({ snoozed_until: snoozeUntil('hour', Date.now()) })}
          >
            {i18n.t('For 1 hour')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => set({ snoozed_until: snoozeUntil('tomorrow', Date.now()) })}
          >
            {i18n.t('Until tomorrow')}
          </Button>
          {isSnoozed(alerts, now) && (
            <Button variant="ghost" size="sm" onClick={() => set({ snoozed_until: null })}>
              {i18n.t('Resume notifications')}
            </Button>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={i18n.t('Reasons')}
        description={i18n.t('Which changes raise an alert.')}
      >
        <div className="border-border/70 divide-border/60 divide-y rounded-md border">
          {ALERT_REASONS.map((reason) => (
            <div key={reason} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-fg font-mono text-[11.5px]">{reason}</div>
                <div className="text-fg-dim text-[11px]">{reasonDescription(reason)}</div>
              </div>
              <Switch
                bare
                checked={!alerts.disabled_reasons.includes(reason)}
                disabled={!alerts.enabled}
                onChange={(on) =>
                  set({
                    disabled_reasons: on
                      ? alerts.disabled_reasons.filter((r) => r !== reason)
                      : [...alerts.disabled_reasons, reason],
                  })
                }
              />
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title={i18n.t('Namespaces')}
        description={i18n.t(
          'Globs separated by commas (* matches any run, ? one character). Nodes are cluster-wide and always included.',
        )}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-fg-muted text-[11px] font-medium">
              {i18n.t('Only these namespaces')}
            </span>
            <PatternInput
              label={i18n.t('Only these namespaces')}
              value={alerts.include_namespaces}
              onChange={(v) => set({ include_namespaces: v })}
              placeholder={i18n.t('All namespaces')}
            />
          </label>
          <label className="space-y-1">
            <span className="text-fg-muted text-[11px] font-medium">
              {i18n.t('Never these namespaces')}
            </span>
            <PatternInput
              label={i18n.t('Never these namespaces')}
              value={alerts.exclude_namespaces}
              onChange={(v) => set({ exclude_namespaces: v })}
              placeholder="kube-*, *-sandbox"
            />
          </label>
        </div>
      </SettingsSection>

      <SettingsSection
        title={i18n.t('Clusters')}
        description={i18n.t(
          'Turn alerts off to stop watching a cluster. Muting keeps collecting alerts without system notifications.',
        )}
      >
        {clusters.length ? (
          <div className="border-border/70 divide-border/60 divide-y rounded-md border">
            <div className="text-fg-dim flex items-center gap-3 px-3 py-1.5 text-[10px] font-semibold tracking-wider uppercase">
              <span className="flex-1">{i18n.t('Cluster')}</span>
              <span className="w-16 text-center">{i18n.t('Alerts')}</span>
              <span className="w-16 text-center">{i18n.t('Notify')}</span>
            </div>
            {clusters.map((cluster) => {
              const watched = !alerts.disabled_clusters.includes(cluster.id);
              const muted = mutedUntil(alerts, cluster.id, now);
              return (
                <div key={cluster.id} className="flex items-center gap-3 px-3 py-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: clusterColor(cluster) }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-fg truncate text-[12px] font-medium">{cluster.name}</div>
                    {muted != null && muted !== Infinity && (
                      <div className="text-fg-dim text-[10.5px]">
                        {i18n.t('Muted until {time}', { time: untilText(muted) })}
                      </div>
                    )}
                  </div>
                  <span className="flex w-16 justify-center">
                    <Switch
                      bare
                      checked={watched}
                      disabled={!alerts.enabled}
                      onChange={(on) =>
                        set({
                          disabled_clusters: on
                            ? alerts.disabled_clusters.filter((id) => id !== cluster.id)
                            : [...alerts.disabled_clusters, cluster.id],
                        })
                      }
                    />
                  </span>
                  <span className="flex w-16 justify-center">
                    <Switch
                      bare
                      checked={muted == null}
                      disabled={!alerts.enabled || !watched}
                      onChange={(on) =>
                        update('alerts', withMute(alerts, cluster.id, on ? undefined : null))
                      }
                    />
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-fg-dim text-[12px]">{i18n.t('No clusters registered yet.')}</p>
        )}
      </SettingsSection>
    </SettingsPageShell>
  );
}
