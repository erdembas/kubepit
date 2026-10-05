import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { Loader2, SlidersHorizontal, Sparkles, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAppStore } from '@/store/useAppStore';
import { useRecommendationsStore, useShownRecommendations } from '@/store/useRecommendationsStore';
import { filterRecommendations } from '@/lib/kube/rightsizing/model';
import type { RightsizingSettings, WorkloadRecommendation } from '@/types';
import { useSelectedNamespaces } from '../data/hooks';
import { DrawerSection } from './DrawerSection';
import { ExportMenu } from './ExportMenu';
import { ListSection } from './ListSection';
import { RecommendationNotes } from './RecommendationNotes';
import { ScanHeader, ScanNowButton } from './ScanHeader';
import { SettingsCard } from './SettingsCard';
import { SummarySection } from './SummarySection';
import { UsageSection } from './UsageSection';
import { saveRecommendationSettings } from './saveSettings';
import type { SectionProps } from './sectionProps';
import { useRecommendationsView } from './viewState';

const NO_ROWS: WorkloadRecommendation[] = [];

/** Nothing stored to show yet (or only failed scans). */
function EmptyState({
  failed,
  connected,
  action,
}: {
  failed: boolean;
  connected: boolean;
  action: React.ReactNode;
}) {
  i18n.useLocale();
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="bg-fg/5 text-fg-dim mb-4 flex h-11 w-11 items-center justify-center rounded-xl">
        <Sparkles className="h-5 w-5" />
      </div>
      <h3 className="text-fg text-[13.5px] font-semibold">
        {failed ? i18n.t('No successful scan yet') : i18n.t('No scan yet')}
      </h3>
      <p className="text-fg-muted mt-1.5 max-w-md text-[12px]">
        {i18n.t(
          'A scan reads days of usage history from Prometheus (or the last hour of metrics-server), recommends requests and limits for every container and keeps the results on this machine.',
        )}
      </p>
      <div className="mt-4">
        {connected ? (
          action
        ) : (
          <p className="text-fg-dim text-[11.5px]">
            {i18n.t('Connect to the cluster to scan it.')}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The `@recommendations` view: stored, scheduled right-sizing scans. The
 * header controls the scans; the body shows the picked scan (the latest,
 * or a past run, read-only) for the workbench namespaces or the namespace
 * picked on the page, section by section (spec §9.1): `SummarySection`,
 * `UsageSection`, then `ListSection` with `DrawerSection` beside it, all
 * fed the same `SectionProps`; `ExportMenu` sits in the header. Page state
 * shared across sections lives in `useRecommendationsView`.
 */
export function RecommendationsPage({
  clusterId,
  viewKey,
  isActive,
}: {
  clusterId: string;
  viewKey: string;
  isActive: boolean;
}) {
  i18n.useLocale();
  const namespaces = useSelectedNamespaces(clusterId, viewKey);
  const shown = useShownRecommendations(clusterId, isActive);
  const connected = useAppStore((s) => s.statuses[clusterId]?.state === 'connected');
  const recSettings = useAppStore((s) => s.settings?.recommendations ?? null);
  const [view, updateView] = useRecommendationsView(clusterId);
  const [showSettings, setShowSettings] = useState(false);
  const { latest, scan, report, status } = shown;

  const strategy = report?.strategies.find((s) => s.id === report.strategy) ?? null;
  const strategySettings: RightsizingSettings | null = strategy
    ? (recSettings?.overrides[strategy.id] ?? strategy.defaults)
    : null;
  const scope = useMemo(
    () => (view.namespace ? [view.namespace] : namespaces),
    [view.namespace, namespaces],
  );
  const rows = useMemo(
    () => (report ? filterRecommendations(report.workloads, 'all', scope, '') : NO_ROWS),
    [report, scope],
  );
  const scanAction = <ScanNowButton clusterId={clusterId} status={status} variant="primary" />;

  const settingsAction = (
    <span title={strategy ? undefined : i18n.t('Settings are available after the first scan.')}>
      <Button
        size="xs"
        variant={showSettings && strategy ? 'secondary' : 'ghost'}
        aria-pressed={showSettings && !!strategy}
        aria-label={i18n.t('Settings')}
        disabled={!strategy}
        leftIcon={<SlidersHorizontal className="h-3 w-3" />}
        onClick={() => setShowSettings((v) => !v)}
      >
        <span className="hidden @md:inline">{i18n.t('Settings')}</span>
      </Button>
    </span>
  );

  let body: React.ReactNode;
  if (!latest && shown.error) {
    body = (
      <div className="border-status-error/30 bg-status-error/[0.06] rounded-app flex items-start gap-2.5 border px-4 py-3 text-[12px]">
        <TriangleAlert className="text-status-error mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-status-error font-semibold">
            {i18n.t('The stored scans could not be read')}
          </p>
          <p className="text-status-error/90 mt-1 font-mono text-[11px] break-words">
            {shown.error}
          </p>
        </div>
        <Button
          size="xs"
          variant="secondary"
          onClick={() => void useRecommendationsStore.getState().load(clusterId)}
        >
          {i18n.t('Try again')}
        </Button>
      </div>
    );
  } else if (!latest || (shown.past && !scan)) {
    body = (
      <div className="text-fg-muted flex items-center justify-center gap-2 py-16 text-[12.5px]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {i18n.t('Loading recommendations…')}
      </div>
    );
  } else if (!report) {
    body = latest.source_changed ? null : (
      <EmptyState failed={!!latest.last_failure} connected={connected} action={scanAction} />
    );
  } else {
    const section: SectionProps = {
      clusterId,
      report,
      rows,
      runId: shown.runId,
      past: shown.past,
      connected,
      namespaces: scope,
    };
    body = (
      <div className="space-y-4">
        {view.namespace && (
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="text-fg-dim">{i18n.t('Namespace')}</span>
            <button
              type="button"
              onClick={() => updateView({ namespace: null })}
              title={i18n.t('Show every namespace in scope')}
              className="bg-accent/10 text-accent hover:bg-accent/15 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium"
            >
              <span className="max-w-60 truncate">{view.namespace}</span>
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <SummarySection {...section} />
        <UsageSection {...section} />
        <div className="flex min-w-0 items-start gap-3">
          <div className="@container min-w-0 flex-1">
            <ListSection {...section} />
          </div>
          <DrawerSection {...section} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ScanHeader
        clusterId={clusterId}
        viewKey={viewKey}
        isActive={isActive}
        namespaces={scope}
        latest={latest}
        scan={scan}
        status={status}
        loading={shown.loading && !!latest}
        settingsAction={settingsAction}
        exportAction={
          <ExportMenu clusterId={clusterId} runId={shown.runId} report={report} rows={rows} />
        }
      />
      <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
        <div className="@container mx-auto max-w-6xl space-y-4 p-5">
          {showSettings && strategy && strategySettings && (
            <SettingsCard
              strategy={strategy}
              settings={strategySettings}
              strategies={report?.strategies}
              selectedStrategy={recSettings?.strategy ?? null}
              onStrategy={(id) =>
                void saveRecommendationSettings((rec) => ({ ...rec, strategy: id }))
              }
              onChange={(next) =>
                void saveRecommendationSettings((rec) => ({
                  ...rec,
                  overrides: { ...rec.overrides, [strategy.id]: next },
                }))
              }
              onReset={() =>
                void saveRecommendationSettings((rec) => {
                  const { [strategy.id]: _dropped, ...overrides } = rec.overrides;
                  return { ...rec, overrides };
                })
              }
            />
          )}
          <RecommendationNotes
            latest={latest}
            scan={scan}
            connected={connected}
            intervalMinutes={recSettings?.interval_minutes ?? 60}
            scanAction={scanAction}
          />
          {body}
        </div>
      </div>
    </div>
  );
}
