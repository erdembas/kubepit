import * as i18n from '@/i18n';
import { ChevronUp, FilePlus2, TerminalSquare } from 'lucide-react';
import { Kbd } from '@/components/ui/Kbd';
import { DockStripAction } from './DockStripAction';

interface Props {
  tabCount: number;
  activeTitle: string | null;
  onOpen: () => void;
  onClusterShell: () => void;
  onCreate: () => void;
}

/** Slim h-8 bar shown while the dock is minimized (or has no tabs yet). */
export function DockCollapsedBar({
  tabCount,
  activeTitle,
  onOpen,
  onClusterShell,
  onCreate,
}: Props) {
  i18n.useLocale();
  return (
    <div className="border-border/70 bg-surface flex h-8 shrink-0 items-center gap-1 border-t px-2">
      {tabCount > 0 ? (
        <button
          type="button"
          onClick={onOpen}
          title={i18n.t('Show dock (Ctrl+`)')}
          className="text-fg-muted hover:text-fg hover:bg-surface-overlay/60 rounded-app-sm flex h-6 min-w-0 items-center gap-1.5 px-1.5 text-[11.5px] font-medium transition-colors"
        >
          <ChevronUp className="h-3 w-3 shrink-0" />
          <TerminalSquare className="text-fg-dim h-3 w-3 shrink-0" />
          <span className="shrink-0">{i18n.plural('{count} tab', '{count} tabs', tabCount)}</span>
          {activeTitle && (
            <span className="text-fg-dim min-w-0 truncate font-normal">· {activeTitle}</span>
          )}
        </button>
      ) : (
        <>
          <DockStripAction
            icon={<TerminalSquare />}
            label={i18n.t('Terminal')}
            title={i18n.t('Open a shell with this cluster’s kubeconfig')}
            onClick={onClusterShell}
          />
          <DockStripAction
            icon={<FilePlus2 />}
            label={i18n.t('Create')}
            title={i18n.t('Create a resource from YAML')}
            onClick={onCreate}
          />
        </>
      )}
      <span className="text-fg-dim ml-auto flex shrink-0 items-center gap-1 text-[10.5px]">
        <Kbd>Ctrl</Kbd>
        <Kbd>`</Kbd>
      </span>
    </div>
  );
}
