import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { Database, History, Trash2 } from 'lucide-react';
import {
  RECOMMENDATIONS_FLEET_KEY,
  RECOMMENDATIONS_FLEET_REFRESH_MS,
} from '@/components/dashboard/recommendationsFleet';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { refreshPolled, usePolled } from '@/components/workbench/data/polled';
import { useNow } from '@/components/workbench/util';
import { clusterColor } from '@/lib/clusterMeta';
import { formatAge, formatBytes } from '@/lib/format';
import { alertSettingsOf, savingAlertsOn, withSavingAlerts } from '@/lib/alerts/policy';
import { historySettings } from '@/lib/history/audit';
import { SCAN_INTERVALS, intervalLabel, runTime } from '@/lib/kube/recommendations/model';
import { ipc, isTauri } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import { useRecommendationsStore } from '@/store/useRecommendationsStore';
import type {
  ClusterId,
  ClusterRecommendationSummary,
  HistoryKind,
  HistorySettings,
  HistoryStatus,
  HistoryTableStatus,
  RecommendationSettings,
} from '@/types';
import { useSettingsDraft } from './categories';
import { REC_RETENTION_DAYS, clampDays, withScanCluster } from './recommendationHistory';
import { SettingsPageShell, SettingsSection } from './SettingsView';

const STATUS_KEY = 'history|status';

function Rows({ label, table }: { label: string; table: HistoryTableStatus | undefined }) {
  i18n.useLocale();
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="text-fg-muted">{label}</span>
      <span className="text-fg tabular-nums">
        {table ? i18n.number(table.rows) : '—'}
        {table?.oldest_ts ? (
          <span className="text-fg-dim ml-2 text-[11px]">
            {i18n.t('since {date}', { date: i18n.date(table.oldest_ts, { dateStyle: 'medium' }) })}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Settings → History: the own-action audit log, persistent events and
 * changes per cluster, stored recommendation scans, retention, the size
 * cap and the database itself.
 */
export function HistoryCategory({ description }: { description: string }) {
  i18n.useLocale();
  const { draft, update, footer } = useSettingsDraft();
  const clusters = useAppStore((s) => s.clusters);
  const status = usePolled<HistoryStatus>(STATUS_KEY, () => ipc.historyStatus(), 10_000, true);
  if (!draft) return <p className="text-fg-dim text-[12px]">{i18n.t('Loading settings…')}</p>;
  const history = historySettings(draft);
  const set = (patch: Partial<HistorySettings>) => update('history', { ...history, ...patch });
  const togglePersist = (id: string, on: boolean) =>
    set({
      persist_clusters: on
        ? [...new Set([...history.persist_clusters, id])]
        : history.persist_clusters.filter((c) => c !== id),
    });
  const s = status.data;

  const clear = (kind: HistoryKind, title: string, message: string) =>
    useAppStore.getState().requestConfirm({
      title,
      message,
      confirmLabel: i18n.t('Clear'),
      tone: 'danger',
      onConfirm: async () => {
        try {
          await ipc.historyClear(kind, null);
          refreshPolled(STATUS_KEY);
          useAppStore.getState().pushToast('success', i18n.t('History cleared'));
        } catch (e) {
          useAppStore.getState().pushToast('error', e instanceof Error ? e.message : String(e));
        }
      },
    });

  return (
    <SettingsPageShell description={description} footer={footer}>
      <SettingsSection
        title={i18n.t('Audit log')}
        trailing={
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<History className="h-3 w-3" />}
            onClick={() => useAppStore.getState().openMainTab({ kind: 'activity' })}
          >
            {i18n.t('Open Activity')}
          </Button>
        }
      >
        <Switch
          checked={history.audit}
          onChange={(v) => set({ audit: v })}
          label={i18n.t('Record every change Kubepit makes')}
          description={i18n.t(
            'Apply, edit, scale, delete, restart, rollbacks, Helm, manifests, node and debug operations on every cluster: who, when, the outcome and redacted before/after objects. Secret values are never stored.',
          )}
        />
        <label className="mt-3 flex items-center gap-2 text-[12px]">
          <span className="text-fg-muted">{i18n.t('Keep actions for')}</span>
          <Input
            type="number"
            min={1}
            max={3650}
            value={history.audit_retention_days}
            onChange={(e) =>
              set({ audit_retention_days: clampDays(e.target.value, history.audit_retention_days) })
            }
            className="w-24"
            aria-label={i18n.t('Audit log retention in days')}
          />
          <span className="text-fg-muted">{i18n.t('days')}</span>
        </label>
      </SettingsSection>

      <SettingsSection
        title={i18n.t('Persistent events and changes')}
        description={i18n.t(
          'Keep Kubernetes Events and the change timeline of selected clusters on disk, so they survive restarts and the one-hour event TTL. Recorded while the cluster is connected; changes need the change timeline to be on.',
        )}
      >
        <div className="border-border/70 divide-border/60 divide-y rounded-md border">
          {clusters.length === 0 && (
            <p className="text-fg-dim px-3 py-2 text-[12px]">{i18n.t('No clusters yet.')}</p>
          )}
          {clusters.map((c) => {
            const on = history.persist_clusters.includes(c.id);
            const recording = s?.persisting.includes(c.id) ?? false;
            return (
              <div key={c.id} className="flex items-center gap-2.5 px-3 py-1.5">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: clusterColor(c) }}
                />
                <span className="text-fg min-w-0 flex-1 truncate text-[12px]">{c.name}</span>
                {recording && (
                  <span className="text-status-running flex items-center gap-1 text-[11px]">
                    <span className="bg-status-running h-1.5 w-1.5 animate-pulse rounded-full" />
                    {i18n.t('Recording')}
                  </span>
                )}
                <Switch
                  checked={on}
                  onChange={(v) => togglePersist(c.id, v)}
                  className="shrink-0 items-center gap-0"
                  label={
                    <span className="sr-only">
                      {i18n.t('Keep events and changes of {name}', { name: c.name })}
                    </span>
                  }
                />
              </div>
            );
          })}
        </div>
        <label className="mt-3 flex items-center gap-2 text-[12px]">
          <span className="text-fg-muted">{i18n.t('Keep events and changes for')}</span>
          <Input
            type="number"
            min={1}
            max={3650}
            value={history.retention_days}
            onChange={(e) =>
              set({ retention_days: clampDays(e.target.value, history.retention_days) })
            }
            className="w-24"
            aria-label={i18n.t('Events and changes retention in days')}
          />
          <span className="text-fg-muted">{i18n.t('days')}</span>
        </label>
      </SettingsSection>

      <RecommendationHistory
        settings={draft.recommendations}
        onChange={(rec) => update('recommendations', rec)}
        savingAlerts={savingAlertsOn(draft)}
        alertsEnabled={alertSettingsOf(draft).enabled}
        onSavingAlertsChange={(on) => {
          const next = withSavingAlerts(draft, on);
          update('recommendations', next.recommendations);
          update('alerts', next.alerts);
        }}
        table={s?.recommendations}
        onCleared={() => refreshPolled(STATUS_KEY)}
      />

      <SettingsSection
        title={i18n.t('Storage')}
        description={i18n.t(
          'One SQLite database on this machine. When it grows past the limit, the oldest events and changes are removed first.',
        )}
      >
        <div className="border-border/70 bg-surface-raised/50 flex items-center gap-2 rounded-md border px-3 py-2">
          <Database className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <span className="text-fg min-w-0 flex-1 truncate font-mono text-[11.5px]" title={s?.path}>
            {s?.path ?? '…'}
          </span>
          <span className="text-fg-muted shrink-0 text-[11.5px] tabular-nums">
            {s ? formatBytes(s.size_bytes) : '—'}
          </span>
          {isTauri && s?.path && (
            <Button variant="secondary" size="xs" onClick={() => void ipc.revealPath(s.path)}>
              {i18n.t('Reveal')}
            </Button>
          )}
        </div>
        {s?.error && <p className="text-status-error mt-2 text-[11.5px] break-words">{s.error}</p>}
        <div className="mt-3 space-y-1">
          <Rows label={i18n.t('Actions')} table={s?.audit} />
          <Rows label={i18n.t('Events')} table={s?.events} />
          <Rows label={i18n.t('Changes')} table={s?.changes} />
          <Rows label={i18n.t('Assistant requests')} table={s?.ai} />
          {!!s?.dropped && (
            <p className="text-status-starting text-[11px]">
              {i18n.plural(
                '{count} write was dropped because the database was busy.',
                '{count} writes were dropped because the database was busy.',
                s.dropped,
              )}
            </p>
          )}
        </div>
        <label className="mt-3 flex items-center gap-2 text-[12px]">
          <span className="text-fg-muted">{i18n.t('Maximum size')}</span>
          <Input
            type="number"
            min={16}
            max={65536}
            value={history.max_size_mb}
            onChange={(e) =>
              set({
                max_size_mb: Math.min(
                  65536,
                  Math.max(16, Math.round(Number(e.target.value)) || history.max_size_mb),
                ),
              })
            }
            className="w-28"
            aria-label={i18n.t('Maximum size in MB')}
          />
          <span className="text-fg-muted">{i18n.t('MB')}</span>
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="danger"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            disabled={!s?.audit.rows}
            onClick={() =>
              clear(
                'audit',
                i18n.t('Clear the audit log?'),
                i18n.t('Every recorded action on every cluster is deleted from this machine.'),
              )
            }
          >
            {i18n.t('Clear audit log')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            disabled={!s?.events.rows}
            onClick={() =>
              clear(
                'events',
                i18n.t('Clear persisted events?'),
                i18n.t('Events kept on disk for every cluster are deleted from this machine.'),
              )
            }
          >
            {i18n.t('Clear events')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            disabled={!s?.changes.rows}
            onClick={() =>
              clear(
                'changes',
                i18n.t('Clear persisted changes?'),
                i18n.t('Changes kept on disk for every cluster are deleted from this machine.'),
              )
            }
          >
            {i18n.t('Clear changes')}
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageShell>
  );
}

/**
 * The Recommendations block: stored scans (rows, oldest scan), how long
 * they are kept, the background-scan interval and the opt-in per cluster
 * and the alert on new high-confidence savings (part of the page's draft,
 * saved with it), and clearing one cluster's or every cluster's scans
 * right away. After a clear, open views read the cluster again (`forget`)
 * and the dashboard's fleet card re-reads the fleet.
 */
function RecommendationHistory({
  settings,
  onChange,
  savingAlerts,
  alertsEnabled,
  onSavingAlertsChange,
  table,
  onCleared,
}: {
  settings: RecommendationSettings;
  onChange: (next: RecommendationSettings) => void;
  savingAlerts: boolean;
  /** Settings → Notifications' master switch. */
  alertsEnabled: boolean;
  onSavingAlertsChange: (on: boolean) => void;
  table: HistoryTableStatus | undefined;
  onCleared: () => void;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const fleet = usePolled<ClusterRecommendationSummary[]>(
    RECOMMENDATIONS_FLEET_KEY,
    () => ipc.recommendationsFleet(),
    RECOMMENDATIONS_FLEET_REFRESH_MS,
  );
  const now = useNow(60_000, true);
  const stored = useMemo(
    () => new Map((fleet.data ?? []).map((f) => [f.cluster_id, f])),
    [fleet.data],
  );
  const intervalOptions = useMemo<SelectOption[]>(
    () =>
      [...new Set([...SCAN_INTERVALS, settings.interval_minutes])]
        .sort((a, b) => a - b)
        .map((m) => ({ value: String(m), label: intervalLabel(m) })),
    [settings.interval_minutes],
  );

  const clear = (clusterId: ClusterId | null, name: string | null) =>
    useAppStore.getState().requestConfirm({
      title:
        name == null
          ? i18n.t('Clear the recommendation history?')
          : i18n.t('Clear the recommendation history of {name}?', { name }),
      message:
        name == null
          ? i18n.t(
              'Every stored recommendation scan of every cluster is deleted from this machine. Later scans store new ones.',
            )
          : i18n.t(
              'Every stored recommendation scan of {name} is deleted from this machine. Later scans store new ones.',
              { name },
            ),
      confirmLabel: i18n.t('Clear'),
      tone: 'danger',
      onConfirm: async () => {
        try {
          await ipc.historyClear('recommendations', clusterId);
          const recs = useRecommendationsStore.getState();
          for (const id of clusterId ? [clusterId] : clusters.map((c) => c.id)) recs.forget(id);
          onCleared();
          refreshPolled(RECOMMENDATIONS_FLEET_KEY);
          useAppStore.getState().pushToast('success', i18n.t('History cleared'));
        } catch (e) {
          useAppStore.getState().pushToast('error', e instanceof Error ? e.message : String(e));
        }
      },
    });

  return (
    <SettingsSection
      title={i18n.t('Recommendations')}
      description={i18n.t(
        'Right-sizing scans are stored on this machine, so their results stay available while a cluster is disconnected. Background scans run only for the clusters turned on here, while they are connected.',
      )}
    >
      <Rows label={i18n.t('Stored recommendations')} table={table} />
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
        <label className="flex items-center gap-2">
          <span className="text-fg-muted">{i18n.t('Keep scans for')}</span>
          <Input
            type="number"
            min={REC_RETENTION_DAYS.min}
            max={REC_RETENTION_DAYS.max}
            value={settings.retention_days}
            onChange={(e) =>
              onChange({
                ...settings,
                retention_days: clampDays(
                  e.target.value,
                  settings.retention_days,
                  REC_RETENTION_DAYS.min,
                  REC_RETENTION_DAYS.max,
                ),
              })
            }
            className="w-20"
            aria-label={i18n.t('Recommendation scan retention in days')}
          />
          <span className="text-fg-muted">{i18n.t('days')}</span>
        </label>
        <span
          className="flex items-center gap-2"
          title={i18n.t('The interval applies to every cluster.')}
        >
          <span className="text-fg-muted">{i18n.t('Background scans')}</span>
          <Select
            value={String(settings.interval_minutes)}
            onChange={(v) => onChange({ ...settings, interval_minutes: Number(v) })}
            options={intervalOptions}
            ariaLabel={i18n.t('Scan interval')}
          />
        </span>
      </div>
      <div className="border-border/70 divide-border/60 @container mt-3 divide-y rounded-md border">
        {clusters.length === 0 && (
          <p className="text-fg-dim px-3 py-2 text-[12px]">{i18n.t('No clusters yet.')}</p>
        )}
        {clusters.map((c) => {
          const entry = stored.get(c.id);
          const run = entry?.run ?? null;
          // Until the fleet is read, Clear stays available.
          const hasScans = !fleet.data || !!run || !!entry?.last_failure;
          return (
            <div key={c.id} className="flex items-center gap-2.5 px-3 py-1.5">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: clusterColor(c) }}
              />
              <span className="text-fg min-w-0 flex-1 truncate text-[12px]">{c.name}</span>
              <span className="text-fg-dim hidden shrink-0 text-[11px] tabular-nums @xs:inline">
                {run
                  ? i18n.t('Scanned {age} ago', { age: formatAge(runTime(run), now) })
                  : fleet.data && !entry?.last_failure
                    ? i18n.t('No scan yet')
                    : null}
              </span>
              <Switch
                checked={settings.scan_clusters.includes(c.id)}
                onChange={(on) => onChange(withScanCluster(settings, c.id, on))}
                className="shrink-0 items-center gap-0"
                label={
                  <span className="sr-only">
                    {i18n.t('Scan {name} in the background', { name: c.name })}
                  </span>
                }
              />
              <IconButton
                size="xs"
                tone="danger"
                disabled={!hasScans}
                label={i18n.t('Clear the recommendation history of {name}', { name: c.name })}
                icon={<Trash2 />}
                onClick={() => clear(c.id, c.name)}
              />
            </div>
          );
        })}
      </div>
      <Switch
        className="mt-4"
        checked={savingAlerts}
        disabled={!alertsEnabled}
        onChange={onSavingAlertsChange}
        label={i18n.t('Alert on new high-confidence savings')}
        description={
          alertsEnabled
            ? i18n.t(
                'When a scan finds a workload whose requests could shrink by half or more with high confidence, and the previous scan did not, an alert is raised. The filters and mutes of Settings → Notifications apply.',
              )
            : i18n.t('Alerts are turned off in Settings → Notifications.')
        }
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="danger"
          leftIcon={<Trash2 className="h-3.5 w-3.5" />}
          disabled={table?.oldest_ts == null}
          onClick={() => clear(null, null)}
        >
          {i18n.t('Clear recommendation history')}
        </Button>
      </div>
    </SettingsSection>
  );
}
