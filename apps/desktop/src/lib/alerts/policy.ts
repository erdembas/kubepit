import type { Alert, AlertNotice, AlertReason, AlertSettings, ClusterId, Settings } from '@/types';

/**
 * Alert preferences and the notification decision, kept pure so every
 * window (and the demo backend) applies the same rules. The recording
 * filters mirror `crates/kubepit-core/src/alerts/model.rs`.
 */

export const ALERT_REASONS: readonly AlertReason[] = [
  'CrashLoopBackOff',
  'OOMKilled',
  'ImagePullBackOff',
  'Evicted',
  'JobFailed',
  'NodeNotReady',
  'NodePressure',
  'ProgressDeadlineExceeded',
  'RightsizingSaving',
];

/**
 * Whether new high-confidence savings raise alerts: the recommendations'
 * opt-in (off by default) and the reason not disabled.
 */
export function savingAlertsOn(settings: Settings | null | undefined): boolean {
  return (
    !!settings?.recommendations.alerts &&
    !alertSettingsOf(settings).disabled_reasons.includes('RightsizingSaving')
  );
}

/** Turn saving alerts on (also re-enabling the reason) or off (the opt-in only). */
export function withSavingAlerts(settings: Settings, on: boolean): Settings {
  const alerts = alertSettingsOf(settings);
  return {
    ...settings,
    recommendations: { ...settings.recommendations, alerts: on },
    alerts: on
      ? {
          ...alerts,
          disabled_reasons: alerts.disabled_reasons.filter((r) => r !== 'RightsizingSaving'),
        }
      : alerts,
  };
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: true,
  disabled_reasons: [],
  include_namespaces: [],
  exclude_namespaces: [],
  disabled_clusters: [],
  muted_clusters: {},
  snoozed_until: null,
  os_notifications: true,
  background_only: true,
};

/** `settings.alerts` with defaults filled in. */
export function alertSettingsOf(settings: Settings | null | undefined): AlertSettings {
  return { ...DEFAULT_ALERT_SETTINGS, ...(settings?.alerts ?? {}) };
}

/** Whole-string glob: `*` any run, `?` one character. */
export function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

export function namespaceAllowed(s: AlertSettings, namespace: string | null): boolean {
  if (namespace == null) return true;
  const included =
    !s.include_namespaces.length || s.include_namespaces.some((p) => globMatch(p, namespace));
  return included && !s.exclude_namespaces.some((p) => globMatch(p, namespace));
}

export function clusterMonitored(s: AlertSettings, clusterId: ClusterId): boolean {
  return s.enabled && !s.disabled_clusters.includes(clusterId);
}

/** Whether the backend records a finding (cluster switch, reason, namespace). */
export function recordsAlert(
  s: AlertSettings,
  clusterId: ClusterId,
  reason: AlertReason,
  namespace: string | null,
): boolean {
  return (
    clusterMonitored(s, clusterId) &&
    !s.disabled_reasons.includes(reason) &&
    namespaceAllowed(s, namespace)
  );
}

export function isSnoozed(s: AlertSettings, now: number): boolean {
  return s.snoozed_until != null && s.snoozed_until > now;
}

/** `null` = not muted, `Infinity` = until unmuted, otherwise the end (epoch ms). */
export function mutedUntil(s: AlertSettings, clusterId: ClusterId, now: number): number | null {
  if (!Object.hasOwn(s.muted_clusters, clusterId)) return null;
  const until = s.muted_clusters[clusterId];
  if (until == null) return Infinity;
  return until > now ? until : null;
}

export function isClusterMuted(s: AlertSettings, clusterId: ClusterId, now: number): boolean {
  return mutedUntil(s, clusterId, now) != null;
}

/** Mute `clusterId` until `until` (null = until unmuted); `undefined` unmutes. */
export function withMute(
  s: AlertSettings,
  clusterId: ClusterId,
  until: number | null | undefined,
): AlertSettings {
  const muted_clusters = { ...s.muted_clusters };
  if (until === undefined) delete muted_clusters[clusterId];
  else muted_clusters[clusterId] = until;
  return { ...s, muted_clusters };
}

export type SnoozeOption = 'hour' | 'tomorrow';

/** End of a snooze started at `now`: one hour, or tomorrow at 08:00 local time. */
export function snoozeUntil(option: SnoozeOption, now: number): number {
  if (option === 'hour') return now + 60 * 60_000;
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

/**
 * What one `alerts://new` becomes in this window:
 * - `os`: this window is the notifier and posts the OS notification,
 * - `toast`: Kubepit is in front and OS notifications wait for the
 *   background; the focused window shows an in-app toast instead,
 * - `none`: a merged repeat, muted, snoozed, disabled, or another window's job.
 */
export function notifyDecision(
  s: AlertSettings,
  notice: AlertNotice,
  windowLabel: string,
  now: number,
): 'os' | 'toast' | 'none' {
  if (!notice.fresh || !s.enabled) return 'none';
  if (isSnoozed(s, now) || isClusterMuted(s, notice.alert.cluster_id, now)) return 'none';
  const osAllowed = s.os_notifications && !(s.background_only && notice.app_focused);
  if (osAllowed) return notice.notifier === windowLabel ? 'os' : 'none';
  return notice.app_focused ? 'toast' : 'none';
}

/** Alerts of each cluster, clusters ordered by their newest alert. */
export function groupByCluster(alerts: Alert[]): Array<{ clusterId: ClusterId; alerts: Alert[] }> {
  const groups = new Map<ClusterId, Alert[]>();
  for (const alert of [...alerts].sort((a, b) => b.last_seen - a.last_seen)) {
    const list = groups.get(alert.cluster_id) ?? [];
    list.push(alert);
    groups.set(alert.cluster_id, list);
  }
  return [...groups.entries()].map(([clusterId, list]) => ({ clusterId, alerts: list }));
}
