import * as i18n from '@/i18n';
import { AlertTriangle, FileSearch, FolderPlus, Plus, Search, X } from 'lucide-react';
import { AddSectionButton } from '../SectionMenus';
import { SidebarFilterMenu } from '../SidebarFilterMenu';
import { IconButton } from '@/components/ui/IconButton';
import { modChord } from '@/lib/platform';
import { useAppStore } from '@/store/useAppStore';

/** "Clusters" tree header: counts, then create / filter tools like an IDE explorer section. */
export function ClustersHeader({
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
    <div className="flex h-8 items-center gap-1.5 pr-2 pl-4">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <span className="text-fg-dim shrink-0 text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          {i18n.t('Clusters')}
        </span>
        <span
          className="text-fg-dim text-[10px] tabular-nums"
          title={i18n.t('{running} running · {count} total', {
            running: connectedCount,
            count: clustersCount,
          })}
        >
          {connectedCount > 0 ? (
            <>
              <span className="text-status-running">{i18n.number(connectedCount)}</span>/
              {i18n.number(clustersCount)}
            </>
          ) : (
            i18n.number(clustersCount)
          )}
        </span>
        {errorCount > 0 && (
          <button
            type="button"
            onClick={() => setGroupBy('status')}
            title={i18n.t('Group clusters by connection status')}
            className="bg-status-error/15 text-status-error hover:bg-status-error/25 rounded-app-sm inline-flex min-w-0 items-center gap-1 truncate px-1.5 text-[10px] font-medium whitespace-nowrap tabular-nums transition"
          >
            {i18n.rich('{icon}{errorCount} failing', {
              icon: <AlertTriangle size={9} strokeWidth={2.2} />,
              errorCount,
            })}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        <IconButton
          label={i18n.t('Discover kubeconfig contexts')}
          icon={<FileSearch />}
          size="xs"
          onClick={() => useAppStore.getState().setImportDialogOpen(true)}
        />
        <AddSectionButton className="text-fg-muted hover:bg-fg/10 hover:text-fg h-6 w-6 justify-center px-0 py-0">
          <FolderPlus className="h-3 w-3" aria-hidden />
        </AddSectionButton>
        <SidebarFilterMenu />
        <IconButton
          label={i18n.t('Add cluster ({shortcut})', { shortcut: modChord('N') })}
          icon={<Plus />}
          size="xs"
          onClick={() => useAppStore.getState().openClusterEditor({ mode: 'add' })}
        />
      </div>
    </div>
  );
}

export function ClusterFilterInput() {
  i18n.useLocale();
  const search = useAppStore((s) => s.search);
  const setSearch = useAppStore((s) => s.setSearch);
  return (
    <div className="border-border/70 bg-surface/50 focus-within:border-accent/40 mx-3 mb-1.5 flex h-7 items-center gap-2 rounded-md border px-2 transition-colors">
      <Search className="text-fg-dim h-3 w-3 shrink-0" />
      <input
        aria-label={i18n.t('Search clusters')}
        placeholder={i18n.t('Filter clusters…')}
        className="text-fg placeholder:text-fg-dim min-w-0 flex-1 bg-transparent text-[11.5px] outline-none"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setSearch('');
          }
        }}
      />
      {search && (
        <button
          type="button"
          aria-label={i18n.t('Clear search')}
          className="text-fg-dim hover:text-fg p-0.5"
          onClick={() => setSearch('')}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
