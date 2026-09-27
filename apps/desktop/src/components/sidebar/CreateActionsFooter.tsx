import * as i18n from '@/i18n';
import { FileSearch, Plus } from 'lucide-react';
import { modChord } from '@/lib/platform';

export function CreateActionsFooter({
  onAddCluster,
  onImport,
}: {
  onAddCluster: () => void;
  onImport: () => void;
}) {
  i18n.useLocale();
  const cta =
    'border-border/80 bg-surface-raised text-fg hover:bg-surface-overlay hover:border-border-strong hover:shadow-md focus-visible:border-border-strong rounded-app-sm flex min-w-0 flex-1 items-center justify-center gap-1 border px-2 py-1.5 text-[11px] font-semibold shadow-sm transition active:scale-[0.98]';
  return (
    <div className="border-border/60 bg-surface-raised/95 border-t px-2 py-2 backdrop-blur">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onAddCluster}
          title={i18n.t('Add cluster ({shortcut})', { shortcut: modChord('N') })}
          className={cta}
        >
          <Plus className="h-3 w-3 shrink-0" />
          <span className="truncate">{i18n.t('Cluster')}</span>
        </button>
        <button
          type="button"
          onClick={onImport}
          title={i18n.t('Discover kubeconfig contexts')}
          className={cta}
        >
          <FileSearch className="h-3 w-3 shrink-0" />
          <span className="truncate">{i18n.t('Discover')}</span>
        </button>
      </div>
    </div>
  );
}
