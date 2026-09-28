import * as i18n from '@/i18n/core';
import type {
  AuditAction,
  AuditEntry,
  AuditFilter,
  AuditTarget,
  ClusterId,
  HistorySettings,
  Settings,
} from '@/types';

/**
 * Pure helpers of the Activity view (the own-action audit log): labels,
 * day grouping, request summaries and the filter model. No React.
 */

export const DEFAULT_HISTORY_SETTINGS: HistorySettings = {
  audit: true,
  audit_retention_days: 90,
  persist_clusters: [],
  retention_days: 7,
  max_size_mb: 512,
};

/** `settings.history`, tolerating settings saved before it existed. */
export function historySettings(settings: Settings | null | undefined): HistorySettings {
  return { ...DEFAULT_HISTORY_SETTINGS, ...(settings?.history ?? {}) };
}

/** Whether events and changes of `clusterId` are kept on disk. */
export function persistsHistory(settings: Settings | null | undefined, clusterId: ClusterId) {
  return historySettings(settings).persist_clusters.includes(clusterId);
}

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'apply',
  'create',
  'replace',
  'patch',
  'delete',
  'scale',
  'restart',
  'set-image',
  'rollout-undo',
  'cronjob-trigger',
  'cordon',
  'uncordon',
  'drain',
  'helm-install',
  'helm-upgrade',
  'helm-rollback',
  'helm-uninstall',
  'manifests-apply',
  'pod-debug',
  'file-upload',
  'node-shell',
  'rightsize',
];

export function actionLabel(action: AuditAction): string {
  switch (action) {
    case 'apply':
      return i18n.t('Apply');
    case 'create':
      return i18n.t('Create');
    case 'replace':
      return i18n.t('Save YAML');
    case 'patch':
      return i18n.t('Patch');
    case 'delete':
      return i18n.t('Delete');
    case 'scale':
      return i18n.t('Scale');
    case 'restart':
      return i18n.t('Restart');
    case 'set-image':
      return i18n.t('Set image');
    case 'rollout-undo':
      return i18n.t('Roll back');
    case 'cronjob-trigger':
      return i18n.t('Trigger CronJob');
    case 'cordon':
      return i18n.t('Cordon');
    case 'uncordon':
      return i18n.t('Uncordon');
    case 'drain':
      return i18n.t('Drain');
    case 'helm-install':
      return i18n.t('Helm install');
    case 'helm-upgrade':
      return i18n.t('Helm upgrade');
    case 'helm-rollback':
      return i18n.t('Helm rollback');
    case 'helm-uninstall':
      return i18n.t('Helm uninstall');
    case 'manifests-apply':
      return i18n.t('Apply manifests');
    case 'pod-debug':
      return i18n.t('Debug container');
    case 'file-upload':
      return i18n.t('Upload file');
    case 'node-shell':
      return i18n.t('Node shell');
    case 'rightsize':
      return i18n.t('Right-size');
  }
}

/** Visual weight of an action: destructive ones stand out. */
export type ActionTone = 'danger' | 'change' | 'neutral';

export function actionTone(action: AuditAction): ActionTone {
  if (
    action === 'delete' ||
    action === 'drain' ||
    action === 'helm-uninstall' ||
    action === 'node-shell'
  )
    return 'danger';
  if (action === 'restart' || action === 'cordon' || action === 'uncordon') return 'neutral';
  return 'change';
}

export const HELM_RELEASE_API_VERSION = 'helm.sh/v3';

export function isHelmTarget(target: AuditTarget): boolean {
  return target.api_version === HELM_RELEASE_API_VERSION;
}

/** `shop/web` or `web` (kinds are shown separately). */
export function targetName(target: AuditTarget): string {
  return target.namespace ? `${target.namespace}/${target.name}` : target.name;
}

/** Stable key of an entry's target for React lists. */
export function targetKey(target: AuditTarget, index: number): string {
  return `${index}|${target.api_version}|${target.kind}|${targetName(target)}`;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One line describing the parameters of an action (`2 → 5 replicas`,
 * `web=nginx:1.28`, `revision 3`); `null` when there is nothing to add.
 * Values are Kubernetes data and stay verbatim.
 */
export function requestSummary(entry: AuditEntry): string | null {
  const r = entry.request ?? {};
  switch (entry.action) {
    case 'scale': {
      const to = asNumber(r.replicas);
      const from = asNumber(r.previous);
      if (to === null) return null;
      return from === null
        ? i18n.plural('{count} replica', '{count} replicas', to)
        : i18n.t('{from} → {to} replicas', { from, to });
    }
    case 'set-image': {
      const images = Array.isArray(r.images) ? (r.images as Record<string, unknown>[]) : [];
      return images.map((i) => `${String(i.container)}=${String(i.image)}`).join(', ') || null;
    }
    case 'rollout-undo': {
      const revision = asNumber(r.revision);
      return revision
        ? i18n.t('to revision {revision}', { revision })
        : i18n.t('to the previous revision');
    }
    case 'helm-rollback': {
      const revision = asNumber(r.revision);
      return revision
        ? i18n.t('to revision {revision}', { revision })
        : i18n.t('to the previous revision');
    }
    case 'helm-install':
    case 'helm-upgrade': {
      const chart = typeof r.chart_ref === 'string' ? r.chart_ref : null;
      const version = typeof r.version === 'string' && r.version ? `@${r.version}` : '';
      return chart ? `${chart}${version}` : null;
    }
    case 'drain':
      return r.force ? i18n.t('forced') : null;
    case 'pod-debug':
      return typeof r.image === 'string' ? r.image : null;
    case 'file-upload': {
      const file = typeof r.file === 'string' ? r.file : '';
      const dir = typeof r.remote_dir === 'string' ? r.remote_dir : '';
      return file ? `${file} → ${dir || '.'}` : null;
    }
    case 'patch':
      return typeof r.patch_type === 'string' ? r.patch_type : null;
    case 'rightsize': {
      const changes = Array.isArray(r.changes) ? (r.changes as Record<string, unknown>[]) : [];
      return changes.map((c) => String(c.container)).join(', ') || null;
    }
    default:
      return null;
  }
}

export type AuditRange = '24h' | '7d' | '30d' | 'all';

export const AUDIT_RANGES: Record<AuditRange, number | null> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
  all: null,
};

export function rangeLabel(range: AuditRange): string {
  switch (range) {
    case '24h':
      return i18n.t('{hours}h', { hours: 24 });
    case '7d':
      return i18n.t('{days}d', { days: 7 });
    case '30d':
      return i18n.t('{days}d', { days: 30 });
    default:
      return i18n.t('All');
  }
}

export interface AuditQuery {
  clusterId: ClusterId | null;
  action: AuditAction | null;
  outcome: 'ok' | 'error' | null;
  text: string;
  range: AuditRange;
}

export const EMPTY_QUERY: AuditQuery = {
  clusterId: null,
  action: null,
  outcome: null,
  text: '',
  range: '7d',
};

/** The backend filter for `query`; `now` anchors the time range. */
export function toFilter(query: AuditQuery, now: number, limit: number): AuditFilter {
  const span = AUDIT_RANGES[query.range];
  return {
    cluster_ids: query.clusterId ? [query.clusterId] : [],
    actions: query.action ? [query.action] : [],
    outcome: query.outcome,
    text: query.text.trim() || null,
    since: span === null ? null : now - span,
    until: null,
    limit,
    cursor: null,
  };
}

export function isFiltered(query: AuditQuery): boolean {
  return (
    query.clusterId !== null ||
    query.action !== null ||
    query.outcome !== null ||
    query.text.trim() !== ''
  );
}

export interface DayGroup {
  key: string;
  label: string;
  entries: AuditEntry[];
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Entries (newest first) grouped by local calendar day. */
export function groupByDay(entries: readonly AuditEntry[], now: number): DayGroup[] {
  const today = dayKey(now);
  const yesterday = dayKey(now - 86_400_000);
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.ts);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const label =
        key === today
          ? i18n.t('Today')
          : key === yesterday
            ? i18n.t('Yesterday')
            : i18n.date(entry.ts, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year:
                  new Date(entry.ts).getFullYear() === new Date(now).getFullYear()
                    ? undefined
                    : 'numeric',
              });
      group = { key, label, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/** `1.2 s`, `340 ms`, `2 min 5 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return i18n.t('{ms} ms', { ms: Math.max(0, Math.round(ms)) });
  if (ms < 60_000)
    return i18n.t('{seconds} s', {
      seconds: i18n.number(ms / 1000, { maximumFractionDigits: 1 }),
    });
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return i18n.t('{minutes} min {seconds} s', { minutes, seconds });
}

/** File name of an export (`kubepit-activity-2026-09-28.jsonl`). */
export function exportFileName(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `kubepit-activity-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
}
