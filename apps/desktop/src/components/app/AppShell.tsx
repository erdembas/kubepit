import * as i18n from '@/i18n';
import { lazy, memo, Suspense } from 'react';
import { MainTabBar } from '@/components/MainTabBar';
import { RightActivityBar } from '@/components/RightActivityBar';
import { RightSidePanel } from '@/components/RightSidePanel';
import { SidebarRail } from '@/components/SidebarRail';
import { StatusBar } from '@/components/StatusBar';
import { TitleBar } from '@/components/TitleBar';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { ClusterEditor } from '@/components/cluster-editor/ClusterEditor';
import { DiscoverDialog } from '@/components/discover/DiscoverDialog';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { ConfirmHost } from '@/components/app/ConfirmHost';
import { Toasts } from '@/components/app/Toasts';
import { GlobalTooltip } from '@/components/ui/GlobalTooltip';
import { ClusterWorkbench } from '@/components/workbench/ClusterWorkbench';
import { mainTabKey, useAppStore, type MainTab } from '@/store/useAppStore';

const SettingsView = lazy(() =>
  import('@/components/settings/SettingsView').then((m) => ({ default: m.SettingsView })),
);
const PortForwardsView = lazy(() =>
  import('@/components/port-forwards/PortForwardsView').then((m) => ({
    default: m.PortForwardsView,
  })),
);

export function AppShell() {
  i18n.useLocale();
  return (
    <div className="bg-surface text-fg relative flex h-screen flex-col overflow-hidden">
      <WorkspaceChrome />
      <AppOverlays />
      <GlobalTooltip />
    </div>
  );
}

// Overlay state must not reconcile every mounted workbench and terminal.
const WorkspaceChrome = memo(function WorkspaceChrome() {
  i18n.useLocale();
  return (
    <>
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <SidebarRail />
        <main className="flex min-w-0 flex-1 flex-col">
          <MainTabBar />
          <MainTabPanels />
        </main>
        <RightSidePanel />
        <RightActivityBar />
      </div>
      <StatusBar />
    </>
  );
});

function MainTabPanels() {
  i18n.useLocale();
  const mainTabs = useAppStore((s) => s.mainTabs);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {mainTabs.map((tab) => (
        <MainTabPanel key={mainTabKey(tab)} tab={tab} />
      ))}
    </div>
  );
}

// Switching tabs re-renders only the previous and next panels; hidden panels
// keep their DOM, watches (paused), terminals and log streams.
const MainTabPanel = memo(function MainTabPanel({ tab }: { tab: MainTab }) {
  i18n.useLocale();
  const key = mainTabKey(tab);
  const isActive = useAppStore((s) => s.activeMainTabKey === key);
  return (
    <div
      role="tabpanel"
      aria-hidden={!isActive}
      className={isActive ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}
    >
      {tab.kind === 'dashboard' && <Dashboard visible={isActive} />}
      {tab.kind === 'cluster' && <ClusterWorkbench clusterId={tab.refId} isActive={isActive} />}
      <Suspense fallback={<p className="text-fg-muted p-5 text-[12px]">{i18n.t('Loading…')}</p>}>
        {tab.kind === 'settings' && <SettingsView />}
        {tab.kind === 'port-forwards' && <PortForwardsView />}
      </Suspense>
    </div>
  );
});

function AppOverlays() {
  i18n.useLocale();
  const clusterEditor = useAppStore((s) => s.clusterEditor);
  const importDialogOpen = useAppStore((s) => s.importDialogOpen);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  return (
    <>
      {clusterEditor && <ClusterEditor state={clusterEditor} />}
      {importDialogOpen && <DiscoverDialog />}
      {paletteOpen && <CommandPalette />}
      <ConfirmHost />
      <Toasts />
    </>
  );
}
