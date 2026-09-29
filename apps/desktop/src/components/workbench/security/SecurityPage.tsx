import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { useState } from 'react';
import { Loader2, RefreshCw, Search, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';
import { gvkForKey, resolveRef } from '@/lib/kube/catalog';
import type { ObjectRef } from '@/lib/kube/columns';
import { TRIVY_KEYS, detectTrivy, trivyKindOf } from '@/lib/kube/trivy';
import { VIEW, navigateTo, useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { ApiResourceInfo, KubeObject } from '@/types';
import { DetailsPanel } from '../details/DetailsPanel';
import { useTrivyOperatorMissing, useTrivyReports } from './hooks';
import { PodSecurityOverview } from './PodSecurityOverview';
import { TrivyMissing } from './TrivyMissing';
import { TrivyOverview, type OverviewActions } from './TrivyOverview';

/**
 * Security view (`@security`): Trivy Operator reports (when its CRDs are
 * served) and Pod Security Standards per namespace. Reports open in a
 * docked details panel; workloads and namespaces open in their own tabs.
 */

type Tab = 'trivy' | 'pss';

/** Tab picked per cluster (survives the page remounting). */
const pickedTab = new Map<string, Tab>();

function scopeLabel(namespaces: string[]) {
  if (!namespaces.length) return i18n.t('All namespaces');
  if (namespaces.length === 1) return namespaces[0]!;
  return i18n.t('{count} namespaces', { count: namespaces.length });
}

export function SecurityPage({
  clusterId,
  namespaces,
  isActive,
  apiResources,
}: {
  clusterId: string;
  namespaces: string[];
  isActive: boolean;
  apiResources: ApiResourceInfo[] | null;
}) {
  i18n.useLocale();
  const [tab, setTabState] = useState<Tab>(() => pickedTab.get(clusterId) ?? 'trivy');
  const setTab = (t: Tab) => {
    pickedTab.set(clusterId, t);
    setTabState(t);
  };
  const [fixableOnly, setFixableOnly] = useState(false);
  const filterKey = `${clusterId}|${VIEW.security}|${tab}`;
  const query = useWorkbenchStore((s) => s.filters[filterKey] ?? '');
  const setQuery = (text: string) =>
    useWorkbenchStore.getState().setFilter(clusterId, `${VIEW.security}|${tab}`, text);
  const selection = useWorkbenchStore((s) => s.selection[clusterId]?.[VIEW.security] ?? null);

  const trivyServed = detectTrivy(apiResources);
  const trivy = useTrivyReports(
    clusterId,
    apiResources,
    namespaces,
    isActive && tab === 'trivy' && trivyServed,
  );
  const reportCount = Object.values(trivy.items).reduce((s, l) => s + l.length, 0);
  // CRDs without an operator (left by a failed install or an uninstall): offer the install again.
  const operatorMissing = useTrivyOperatorMissing(
    clusterId,
    isActive && tab === 'trivy' && trivy.synced && !trivy.errors.length && reportCount === 0,
  );
  const trivyCard = tab === 'trivy' && (!trivyServed || operatorMissing);

  const selectedGvk = selection ? gvkForKey(selection.key, apiResources) : null;
  const selectedObj = useMemo(() => {
    if (!selection) return null;
    for (const list of Object.values(trivy.items))
      for (const o of list)
        if (
          o.metadata.name === selection.name &&
          (o.metadata.namespace ?? null) === (selection.namespace ?? null) &&
          TRIVY_KEYS[o.kind as keyof typeof TRIVY_KEYS] === selection.key
        )
          return o;
    return null;
  }, [selection, trivy.items]);

  const navigate = (ref: ObjectRef) => {
    const gvk = resolveRef(ref.apiVersion, ref.kind, apiResources);
    if (gvk) navigateTo(clusterId, gvk, ref.namespace ?? null, ref.name);
  };
  const actions: OverviewActions = {
    openReport: (report: KubeObject) => {
      const kind = trivyKindOf(report);
      if (!kind) return;
      useWorkbenchStore.getState().select(clusterId, VIEW.security, {
        key: TRIVY_KEYS[kind],
        namespace: report.metadata.namespace ?? null,
        name: report.metadata.name,
      });
    },
    openObject: (target) =>
      navigate({ kind: target.kind, name: target.name, namespace: target.namespace }),
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'trivy', label: i18n.t('Vulnerabilities & audits') },
    { id: 'pss', label: i18n.t('Pod Security Standards') },
  ];
  const live = tab === 'trivy' ? trivy.synced : true;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="bg-accent/10 text-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
            <ShieldAlert className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-fg shrink-0 text-[13px] font-semibold">{i18n.t('Security')}</h2>
          <span className="text-fg-dim hidden truncate text-[11px] @2xl:inline">
            {scopeLabel(namespaces)}
          </span>
          <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-1.5">
            <div className="bg-surface border-border focus-within:border-accent/50 flex h-8 w-60 min-w-24 shrink items-center gap-2 rounded-lg border px-2.5">
              <Search className="text-fg-dim h-3.5 w-3.5 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                placeholder={
                  tab === 'trivy'
                    ? i18n.t('Search CVE, package or title…')
                    : i18n.t('Filter namespaces…')
                }
                aria-label={
                  tab === 'trivy' ? i18n.t('Search vulnerabilities') : i18n.t('Filter namespaces')
                }
                disabled={trivyCard}
                className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[12px] outline-none disabled:opacity-50"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={i18n.t('Clear filter')}
                  className="text-fg-dim hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {tab === 'trivy' && trivyServed && (
              <IconButton
                label={i18n.t('Restart watches')}
                icon={<RefreshCw />}
                onClick={trivy.restart}
              />
            )}
          </div>
        </div>
        <div className="border-border/60 flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
          <div
            className="flex items-center gap-0.5"
            role="radiogroup"
            aria-label={i18n.t('Section')}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex h-6 shrink-0 items-center rounded-md px-2 text-[11px] whitespace-nowrap transition',
                  tab === t.id
                    ? 'bg-fg/7 text-fg font-medium'
                    : 'text-fg-dim hover:bg-fg/4 hover:text-fg',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'trivy' && !trivyCard && (
            <label className="text-fg-dim ml-auto flex shrink-0 items-center gap-2 pr-1 text-[11px]">
              <Switch checked={fixableOnly} onChange={setFixableOnly} bare />
              {i18n.t('Fixable only')}
            </label>
          )}
        </div>
        {tab === 'trivy' && trivy.errors.length > 0 && (
          <div className="border-tone-warning/30 bg-tone-warning/8 text-tone-warning-fg flex shrink-0 flex-col gap-0.5 border-b px-4 py-1.5 text-[11.5px]">
            {trivy.errors.map((w) => (
              <span key={w.gvk.kind} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0 break-words">
                  {w.gvk.kind}: {w.snap.error}
                </span>
              </span>
            ))}
          </div>
        )}
        {!apiResources ? (
          <div className="text-fg-muted flex flex-1 items-center justify-center gap-2 text-[12px]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t('Discovering API resources…')}
          </div>
        ) : trivyCard ? (
          <TrivyMissing clusterId={clusterId} crdsServed={trivyServed} />
        ) : (
          <div className="overlay-scroll min-h-0 flex-1 overflow-auto">
            <div className="mx-auto max-w-6xl p-5">
              {tab === 'trivy' ? (
                <TrivyOverview
                  data={trivy}
                  query={query}
                  fixableOnly={fixableOnly}
                  actions={actions}
                />
              ) : (
                <PodSecurityOverview
                  clusterId={clusterId}
                  apiResources={apiResources}
                  namespaces={namespaces}
                  query={query}
                  isActive={isActive && tab === 'pss'}
                  onOpen={navigate}
                />
              )}
            </div>
          </div>
        )}
        <div className="border-border/60 text-fg-dim flex h-7 shrink-0 items-center gap-2 border-t px-4 text-[11px] tabular-nums">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              tab === 'trivy' && trivy.errors.length
                ? 'bg-status-error'
                : live && isActive
                  ? 'bg-status-running animate-breathe'
                  : 'bg-fg-dim/50',
            )}
          />
          <span>{!isActive ? i18n.t('Paused') : live ? i18n.t('Live') : i18n.t('Loading…')}</span>
          {tab === 'trivy' && trivyServed && (
            <>
              <span className="text-fg-dim/40">·</span>
              <span>{i18n.plural('{count} report', '{count} reports', reportCount)}</span>
            </>
          )}
        </div>
      </div>
      {selection && selectedGvk && (
        <DetailsPanel
          clusterId={clusterId}
          gvk={selectedGvk}
          kindKey={selection.key}
          selection={selection}
          liveObject={selectedObj}
          isActive={isActive}
          apiResources={apiResources}
          viewKey={VIEW.security}
        />
      )}
    </div>
  );
}
