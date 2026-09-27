import * as i18n from '@/i18n';
import { AlertTriangle } from 'lucide-react';
import { SidebarFilterMenu } from '../SidebarFilterMenu';
import { useAppStore } from '@/store/useAppStore';

export function WorkspaceHeader({
  clustersCount,
  connectedCount,
}: {
  clustersCount: number;
  connectedCount: number;
}) {
  i18n.useLocale();
  const errorCount = useAppStore(
    (s) => Object.values(s.statuses).filter((status) => status.state === 'error').length,
  );
  const setGroupBy = useAppStore((s) => s.setSidebarGroupBy);

  return (
    <div className="flex items-center gap-1.5 px-3 pt-3 pb-1.5">
      <span className="text-fg-dim text-[10.5px] font-semibold tracking-[0.18em] uppercase">
        {i18n.t('Clusters')}
      </span>
      <span className="bg-surface-muted text-fg-muted rounded-app-sm px-1.5 text-[10px] tabular-nums">
        {clustersCount}
      </span>
      {connectedCount > 0 && (
        <span className="bg-status-running/15 text-status-running rounded-app-sm px-1.5 text-[10px] tabular-nums">
          {i18n.t('{connectedCount} on', { connectedCount })}
        </span>
      )}
      {errorCount > 0 && (
        <button
          type="button"
          onClick={() => setGroupBy('status')}
          title={i18n.t('Group clusters by connection status')}
          className="bg-status-error/15 text-status-error hover:bg-status-error/25 rounded-app-sm inline-flex items-center gap-1 px-1.5 text-[10px] font-medium tabular-nums transition"
        >
          {i18n.rich('{icon}{errorCount} failing', {
            icon: <AlertTriangle size={9} strokeWidth={2.2} />,
            errorCount,
          })}
        </button>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        <SidebarFilterMenu />
      </div>
    </div>
  );
}
