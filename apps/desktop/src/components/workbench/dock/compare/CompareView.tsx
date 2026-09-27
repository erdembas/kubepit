import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { ArrowLeftRight, ArrowRightLeft, GitCompareArrows, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore, type CompareSide, type DockTab } from '@/store/useDockStore';
import type { ClusterDef, ClusterId } from '@/types';
import { DiffView } from '../../common/DiffView';
import { fetchSide, type FetchedSide } from './compareData';
import { DriftPane } from './DriftPane';
import { SidePicker } from './SidePicker';
import { SyncPanel, type SyncRequest } from './SyncPanel';

type CompareTab = Extract<DockTab, { kind: 'compare' }>;

/**
 * Cross-cluster compare dock tab. *Compare* diffs one object on two
 * clusters (any cluster / namespace / name on either side); *Drift* looks
 * the same object up on every connected cluster against a baseline.
 * Both sides are normalised in `compare` mode, so cluster-assigned values
 * (uids, cluster IPs, revision counters) never show up as drift.
 */
export function CompareView({
  clusterId,
  tab,
  active,
}: {
  clusterId: ClusterId;
  tab: CompareTab;
  active: boolean;
}) {
  i18n.useLocale();
  const update = (patch: Partial<CompareTab>) =>
    useDockStore.getState().updateTab(clusterId, tab.id, patch);
  const [refresh, setRefresh] = useState(0);
  // "Sync to…" replaces the panes until closed; closing refreshes both sides.
  const [sync, setSync] = useState<SyncRequest | null>(null);
  const closeSync = () => {
    setSync(null);
    setRefresh((n) => n + 1);
  };
  const object = `${tab.namespace ? `${tab.namespace}/` : ''}${tab.name}`;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="border-border/60 flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <div className="bg-fg/4 inline-flex gap-0.5 rounded-md p-0.5" role="tablist">
          {(
            [
              ['compare', i18n.t('Compare')],
              ['drift', i18n.t('Drift')],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={tab.mode === mode}
              onClick={() => update({ mode })}
              className={cn(
                'rounded px-2 py-0.5 text-[11.5px] transition-colors',
                tab.mode === mode
                  ? 'bg-surface-raised text-fg font-medium shadow-sm'
                  : 'text-fg-dim hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-fg-muted flex min-w-0 items-center gap-1.5 text-[11.5px]">
          <GitCompareArrows className="text-fg-dim h-3.5 w-3.5 shrink-0" />
          <span className="text-fg-dim shrink-0">{tab.gvk.kind}</span>
          <span className="text-fg truncate font-mono">{object}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <Switch
            checked={tab.includeStatus}
            onChange={(includeStatus) => update({ includeStatus })}
            label={<span className="text-fg-muted text-[11.5px]">{i18n.t('Include status')}</span>}
            className="gap-2"
          />
          <IconButton
            size="xs"
            label={i18n.t('Refresh')}
            icon={<RefreshCw />}
            onClick={() => setRefresh((n) => n + 1)}
          />
        </div>
      </div>
      {sync ? (
        <SyncPanel gvk={tab.gvk} request={sync} onClose={closeSync} />
      ) : tab.mode === 'compare' ? (
        <ComparePane
          clusterId={clusterId}
          tab={tab}
          active={active}
          refresh={refresh}
          onChange={update}
          onSync={setSync}
        />
      ) : (
        <DriftPane
          clusterId={clusterId}
          tab={tab}
          active={active}
          refresh={refresh}
          onBaseline={(baseline) => update({ baseline })}
          onOpenDiff={(left, right) => update({ mode: 'compare', left, right })}
          onSync={setSync}
        />
      )}
    </div>
  );
}

/** A second cluster to start with: prefer another environment ("prod vs staging"). */
function defaultTarget(
  source: CompareSide,
  clusters: ClusterDef[],
  connected: (id: ClusterId) => boolean,
): CompareSide | null {
  const own = clusters.find((c) => c.id === source.clusterId);
  const others = clusters.filter((c) => c.id !== source.clusterId && connected(c.id));
  const pick =
    others.find((c) => c.environment && own?.environment && c.environment !== own.environment) ??
    others[0];
  return pick ? { ...source, clusterId: pick.id } : null;
}

function useSide(side: CompareSide | null, tab: CompareTab, enabled: boolean, refresh: number) {
  const [state, setState] = useState<{ key: string; data: FetchedSide | null }>({
    key: '',
    data: null,
  });
  const key = side
    ? `${side.clusterId}|${side.namespace ?? ''}|${side.name}|${tab.includeStatus}|${refresh}`
    : '';
  useEffect(() => {
    if (!side || !enabled) return;
    let cancelled = false;
    setState((s) => (s.key === key ? s : { key, data: null }));
    void fetchSide(side, tab.gvk, tab.includeStatus).then((data) => {
      if (!cancelled) setState({ key, data });
    });
    return () => {
      cancelled = true;
    };
    // `key` covers side, status toggle and refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tab.gvk]);
  return state.key === key ? state.data : null;
}

function ComparePane({
  clusterId,
  tab,
  active,
  refresh,
  onChange,
  onSync,
}: {
  clusterId: ClusterId;
  tab: CompareTab;
  active: boolean;
  refresh: number;
  onChange: (patch: Partial<CompareTab>) => void;
  onSync: (request: SyncRequest) => void;
}) {
  i18n.useLocale();
  const clusters = useAppStore((s) => s.clusters);
  const statuses = useAppStore((s) => s.statuses);
  const connected = (id: ClusterId) => statuses[id]?.state === 'connected';
  const source: CompareSide = { clusterId, namespace: tab.namespace, name: tab.name };
  const left = tab.left ?? source;
  const right = tab.right ?? defaultTarget(left, clusters, connected);
  const leftData = useSide(left, tab, active, refresh);
  const rightData = useSide(right, tab, active, refresh);
  const nameOf = (id: ClusterId) => clusters.find((c) => c.id === id)?.name ?? id;
  const sideLabel = (s: CompareSide) =>
    `${nameOf(s.clusterId)} · ${s.namespace ? `${s.namespace}/` : ''}${s.name}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/60 flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1">
        <SidePicker
          label={i18n.t('Left side')}
          side={left}
          gvk={tab.gvk}
          enabled={active}
          onChange={(next) => onChange({ left: next, right })}
        />
        <IconButton
          size="xs"
          label={i18n.t('Swap sides')}
          icon={<ArrowLeftRight />}
          disabled={!right}
          onClick={() => right && onChange({ left: right, right: left })}
        />
        {right ? (
          <SidePicker
            label={i18n.t('Right side')}
            side={right}
            gvk={tab.gvk}
            enabled={active}
            onChange={(next) => onChange({ left, right: next })}
          />
        ) : (
          <span className="text-fg-dim text-[11.5px]">
            {i18n.t('Connect another cluster to compare with.')}
          </span>
        )}
        {right && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            leftIcon={<ArrowRightLeft className="h-3 w-3" />}
            disabled={leftData?.state !== 'ok'}
            title={i18n.t('Make the right side match the left: review, then apply')}
            onClick={() =>
              onSync({ source: left, targets: [right.clusterId], namespace: right.namespace })
            }
          >
            {i18n.t('Sync to right…')}
          </Button>
        )}
      </div>
      {!right ? null : !leftData || !rightData ? (
        <div className="text-fg-dim flex flex-1 items-center justify-center gap-2 text-[12px]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {i18n.t('Reading both sides…')}
        </div>
      ) : leftData.state !== 'ok' || rightData.state !== 'ok' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          {[
            { key: 'left', side: left, data: leftData },
            { key: 'right', side: right, data: rightData },
          ]
            .filter((s) => s.data.state !== 'ok')
            .map((s) => (
              <p key={s.key} className="text-fg-muted max-w-lg text-[12px]">
                <SideProblem side={s.side} data={s.data} name={nameOf} />
              </p>
            ))}
        </div>
      ) : (
        <DiffView
          original={leftData.yaml}
          modified={rightData.yaml}
          originalLabel={sideLabel(left)}
          modifiedLabel={sideLabel(right)}
          identicalHint={i18n.t(
            'Same spec on both clusters (ignoring values each cluster assigns itself).',
          )}
        />
      )}
    </div>
  );
}

export function SideProblem({
  side,
  data,
  name,
}: {
  side: CompareSide;
  data: FetchedSide;
  name: (id: ClusterId) => string;
}) {
  i18n.useLocale();
  const values = {
    cluster: name(side.clusterId),
    object: `${side.namespace ? `${side.namespace}/` : ''}${side.name}`,
  };
  switch (data.state) {
    case 'missing':
      return <>{i18n.t('{object} does not exist on {cluster}.', values)}</>;
    case 'not-served':
      return <>{i18n.t('{cluster} does not serve this kind.', values)}</>;
    case 'forbidden':
      return <>{i18n.t('You are not allowed to read {object} on {cluster}.', values)}</>;
    default:
      return (
        <span className="text-status-error">
          {i18n.t('{cluster}: {message}', { cluster: values.cluster, message: data.message ?? '' })}
        </span>
      );
  }
}
