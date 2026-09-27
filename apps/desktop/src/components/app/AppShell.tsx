import * as i18n from '@/i18n';
import { memo } from 'react';
import { MainPanes } from '@/components/MainPanes';
import { RightActivityBar } from '@/components/RightActivityBar';
import { RightSidePanel } from '@/components/RightSidePanel';
import { SidebarRail } from '@/components/SidebarRail';
import { StatusBar } from '@/components/StatusBar';
import { TitleBar } from '@/components/TitleBar';
import { ClusterEditor } from '@/components/cluster-editor/ClusterEditor';
import { DiscoverDialog } from '@/components/discover/DiscoverDialog';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { ConfirmHost } from '@/components/app/ConfirmHost';
import { Toasts } from '@/components/app/Toasts';
import { GlobalTooltip } from '@/components/ui/GlobalTooltip';
import { useAppStore } from '@/store/useAppStore';

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
          <MainPanes />
        </main>
        <RightSidePanel />
        <RightActivityBar />
      </div>
      <StatusBar />
    </>
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
