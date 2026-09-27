import * as i18n from '@/i18n';
import { Component, memo, useCallback, type ReactNode } from 'react';
import { useAppStore } from '@/store/useAppStore';
import type { DockTab } from '@/store/useDockStore';
import type { ClusterId } from '@/types';
import { CreateEditor } from './editor/CreateEditor';
import { EditEditor } from './editor/EditEditor';
import { FileBrowser } from './files/FileBrowser';
import { LogView } from './logs/LogView';
import { WorkloadLogView } from './workload-logs/WorkloadLogView';
import { requestCloseTabs } from './tabs';
import { TerminalView } from './terminal/TerminalView';

interface Props {
  clusterId: ClusterId;
  tab: DockTab;
  /** On screen: active tab of an open dock in the visible cluster tab. */
  active: boolean;
}

/** Renders one dock tab. Stays mounted while hidden so sessions survive. */
export const DockTabBody = memo(function DockTabBody({ clusterId, tab, active }: Props) {
  const fontSize = useAppStore((s) => s.settings?.terminal_font_size ?? 13);
  const close = useCallback(() => requestCloseTabs(clusterId, [tab.id]), [clusterId, tab.id]);
  let body: ReactNode;
  switch (tab.kind) {
    case 'terminal':
      body = (
        <TerminalView
          id={tab.id}
          spec={tab.spec}
          active={active}
          fontSize={fontSize}
          onClose={close}
        />
      );
      break;
    case 'logs':
      body = <LogView clusterId={clusterId} tab={tab} active={active} />;
      break;
    case 'editor':
      body =
        tab.mode === 'create' ? (
          <CreateEditor clusterId={clusterId} tab={tab} />
        ) : (
          <EditEditor clusterId={clusterId} tab={tab} />
        );
      break;
    case 'workload-logs':
      body = <WorkloadLogView clusterId={clusterId} tab={tab} active={active} />;
      break;
    case 'files':
      body = <FileBrowser clusterId={clusterId} tab={tab} active={active} />;
      break;
  }
  return <TabErrorBoundary>{body}</TabErrorBoundary>;
});

class TabErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return <TabCrashed error={this.state.error} onRetry={() => this.setState({ error: null })} />;
  }
}

function TabCrashed({ error, onRetry }: { error: Error; onRetry: () => void }) {
  i18n.useLocale();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="text-fg text-[12px] font-medium">{i18n.t('This tab crashed.')}</span>
      <span className="text-status-error max-w-xl font-mono text-[11px] break-words">
        {error.message}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="btn-chrome rounded-app-sm h-6 px-2.5 text-[11px] font-medium"
      >
        {i18n.t('Retry')}
      </button>
    </div>
  );
}
