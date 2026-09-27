import * as i18n from '@/i18n';
import { Search } from 'lucide-react';
import { KubepitMark } from '@/components/ui/KubepitMark';
import { useAppStore } from '@/store/useAppStore';
import { IS_MAC, modChord } from '@/lib/platform';

/**
 * macOS overlay title bar (native traffic lights, hidden title). Other
 * platforms keep their native chrome, so this renders nothing there.
 */
export function TitleBar() {
  i18n.useLocale();
  const connectedCount = useAppStore(
    (s) => Object.values(s.statuses).filter((status) => status.state === 'connected').length,
  );
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);

  if (!IS_MAC) return null;

  return (
    <div
      data-tauri-drag-region
      className="border-border/60 bg-surface-raised relative z-20 flex h-10 shrink-0 items-center border-b px-3 select-none"
    >
      {/* Gutter for macOS traffic lights (x=14 + ~3*12 + 2*8 ≈ 70 → pad 76) */}
      <div className="w-[76px] shrink-0" aria-hidden />

      <div data-tauri-drag-region className="flex items-center gap-1.5">
        <span className="bg-accent/15 text-accent rounded-app-sm inline-flex h-5 w-5 items-center justify-center">
          <KubepitMark className="h-3.5 w-3.5" />
        </span>
        <span className="text-fg text-[12px] font-semibold tracking-tight">Kubepit</span>
      </div>

      {/*
        Centered command palette trigger. The wrapper is pointer-events:none
        so the rest of the title bar stays draggable.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bottom-0 flex items-center justify-center">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="border-border/70 bg-surface-muted/70 hover:bg-surface-overlay hover:border-border-strong/70 text-fg-dim hover:text-fg-muted rounded-app-sm pointer-events-auto flex h-7 w-[360px] max-w-[42vw] items-center gap-2 border px-2.5 text-[11.5px] transition"
          aria-label={i18n.t('Open command palette')}
        >
          <Search className="h-3 w-3 shrink-0" />
          <span className="truncate">{i18n.t('Search clusters, resources, actions…')}</span>
          <kbd className="border-border bg-surface text-fg-dim ml-auto shrink-0 rounded border px-1 font-mono text-[10px]">
            {modChord('K')}
          </kbd>
        </button>
      </div>

      <div data-tauri-drag-region className="ml-auto flex items-center gap-2">
        {connectedCount > 0 && (
          <span className="bg-status-running/15 text-status-running rounded-app-sm flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] font-semibold">
            {i18n.rich('{dot}{connectedCount} connected', {
              dot: <span className="bg-status-running animate-breathe h-1.5 w-1.5 rounded-full" />,
              connectedCount,
            })}
          </span>
        )}
      </div>
    </div>
  );
}
