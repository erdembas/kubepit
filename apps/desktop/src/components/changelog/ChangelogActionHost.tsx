import * as i18n from '@/i18n';
import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowRight, Server } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { canOpenForCluster } from '@/lib/changelogActions';
import { useChangelogNavigation } from '@/lib/changelogNavigation';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore, VIEW } from '@/store/useWorkbenchStore';

const InvestigationsPage = lazy(() =>
  import('@/components/workbench/investigations/InvestigationsPage').then((module) => ({
    default: module.InvestigationsPage,
  })),
);
const ConnectionDoctorDialog = lazy(() =>
  import('@/components/workbench/doctor/ConnectionDoctor').then((module) => ({
    default: module.ConnectionDoctorDialog,
  })),
);

/** Feature links open a view; connections, captures and probes remain explicit actions. */
export function ChangelogActionHost() {
  i18n.useLocale();
  const action = useChangelogNavigation((state) => state.action);
  const close = useChangelogNavigation((state) => state.closeAction);
  const clusters = useAppStore((state) => state.clusters);
  const statuses = useAppStore((state) => state.statuses);
  const [query, setQuery] = useState('');
  const [doctorId, setDoctorId] = useState<string | null>(null);
  useEffect(() => {
    setQuery('');
    setDoctorId(null);
  }, [action]);
  if (!action) return null;
  const loading = <p className="text-fg-dim p-4 text-[12px]">{i18n.t('Loading…')}</p>;
  if (action === 'investigations')
    return (
      <Dialog
        title={i18n.t('Investigations')}
        onClose={close}
        size="xl"
        bodyClassName="flex h-[70vh] min-h-0 flex-col"
      >
        <Suspense fallback={loading}>
          <InvestigationsPage active />
        </Suspense>
      </Dialog>
    );
  if (
    action === 'connection-doctor' &&
    doctorId &&
    clusters.some((cluster) => cluster.id === doctorId)
  )
    return (
      <Suspense fallback={loading}>
        <ConnectionDoctorDialog clusterId={doctorId} onClose={close} />
      </Suspense>
    );

  const visible = clusters.filter((cluster) =>
    `${cluster.name} ${cluster.context}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const select = (clusterId: string) => {
    const app = useAppStore.getState();
    if (!app.clusters.some((cluster) => cluster.id === clusterId)) return;
    if (!canOpenForCluster(action, app.statuses[clusterId]?.state === 'connected')) return;
    if (action === 'connection-doctor') setDoctorId(clusterId);
    else if (action === 'network-diagnostics') {
      useWorkbenchStore.getState().setActiveKind(clusterId, VIEW.networkDiagnostics);
      app.openCluster(clusterId);
      close();
    }
  };
  return (
    <Dialog
      title={i18n.t('Choose a cluster')}
      subtitle={
        action === 'connection-doctor' ? i18n.t('Connection doctor') : i18n.t('Network diagnostics')
      }
      onClose={close}
      size="md"
      footer={
        <Button variant="ghost" onClick={close}>
          {i18n.t('Cancel')}
        </Button>
      }
    >
      <p className="text-fg-muted mb-3 text-[12px] leading-relaxed">
        {action === 'connection-doctor'
          ? i18n.t('Choose a cluster, then start the checks when you are ready.')
          : i18n.t(
              'Choose a connected cluster to open network diagnostics. Probes start only when you run them.',
            )}
      </p>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={i18n.t('Filter clusters…')}
        aria-label={i18n.t('Filter clusters')}
        autoFocus
      />
      <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
        {visible.map((cluster) => {
          const connected = statuses[cluster.id]?.state === 'connected';
          const available = canOpenForCluster(action, connected);
          return (
            <button
              key={cluster.id}
              type="button"
              disabled={!available}
              onClick={() => select(cluster.id)}
              className="hover:bg-fg/5 focus-visible:outline-accent border-border/60 flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left outline-none disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Server className="text-fg-dim h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="text-fg block truncate text-[12px]">{cluster.name}</span>
                <span className="text-fg-dim block truncate text-[11px]">
                  {connected ? i18n.t('Connected') : i18n.t('Not connected')}
                </span>
              </span>
              {available && <ArrowRight className="text-fg-dim h-3.5 w-3.5 shrink-0" />}
            </button>
          );
        })}
        {!visible.length && (
          <p className="text-fg-dim py-5 text-center text-[12px]">
            {clusters.length
              ? i18n.t('No clusters match your filter.')
              : i18n.t('Add a cluster to use this feature.')}
          </p>
        )}
      </div>
      {action === 'network-diagnostics' &&
        !clusters.some((cluster) => statuses[cluster.id]?.state === 'connected') && (
          <p className="text-fg-dim mt-3 text-[11px] leading-relaxed">
            {i18n.t('Connect a cluster from its workspace, then return to this shortcut.')}
          </p>
        )}
    </Dialog>
  );
}
