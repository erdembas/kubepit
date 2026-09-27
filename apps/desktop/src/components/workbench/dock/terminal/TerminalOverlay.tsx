import * as i18n from '@/i18n';
import type { ReactNode } from 'react';
import { ClipboardPaste, Copy, Eraser, RotateCcw, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { modChord } from '@/lib/platform';

export type TerminalEnd =
  { kind: 'exited'; code: number | null } | { kind: 'failed'; message: string };

interface ActionsProps {
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onFind: () => void;
  onRestart: () => void;
}

/**
 * Minor-utility pill in the terminal's top-right corner (RunHQ's restart
 * pill, grown into a small group). Dim until the pane is hovered so it never
 * competes with shell output.
 */
export function TerminalActions({ onCopy, onPaste, onClear, onFind, onRestart }: ActionsProps) {
  i18n.useLocale();
  return (
    <div
      className={cn(
        'border-border bg-surface-raised/85 absolute top-2 right-3 z-10 flex items-center gap-0.5',
        'rounded-app-sm border p-0.5 shadow-sm backdrop-blur transition-opacity',
        'opacity-0 group-hover/term:opacity-100 focus-within:opacity-100',
      )}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <PillButton label={i18n.t('Copy selection')} onClick={onCopy} icon={<Copy />} />
      <PillButton label={i18n.t('Paste')} onClick={onPaste} icon={<ClipboardPaste />} />
      <PillButton label={i18n.t('Clear')} onClick={onClear} icon={<Eraser />} />
      <PillButton
        label={i18n.t('Find ({shortcut})', { shortcut: modChord('F') })}
        onClick={onFind}
        icon={<Search />}
      />
      <PillButton
        label={i18n.t('Restart terminal (kill current shell & respawn)')}
        onClick={onRestart}
        icon={<RotateCcw />}
      />
    </div>
  );
}

function PillButton({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="text-fg-dim hover:text-fg hover:bg-surface-overlay rounded-app-sm flex h-6 w-6 items-center justify-center transition [&>svg]:h-3 [&>svg]:w-3"
    >
      {icon}
    </button>
  );
}

/** Bottom banner once the shell / exec session is gone. */
export function TerminalExitBanner({
  end,
  onRestart,
  onClose,
}: {
  end: TerminalEnd;
  onRestart: () => void;
  onClose: () => void;
}) {
  i18n.useLocale();
  const failed = end.kind === 'failed' || (end.code !== null && end.code !== 0);
  const message =
    end.kind === 'failed'
      ? i18n.t('The terminal could not be started.')
      : end.code === null
        ? i18n.t('The session ended.')
        : i18n.t('Process exited with code {code}.', { code: end.code });
  return (
    <div
      className={cn(
        'border-border bg-surface-raised/95 absolute right-3 bottom-3 left-3 z-10 flex items-center gap-3',
        'rounded-app-sm border px-3 py-2 text-[12px] shadow-lg backdrop-blur',
      )}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span
        aria-hidden
        className={cn('h-2 w-2 shrink-0 rounded-full', failed ? 'bg-status-error' : 'bg-fg-dim')}
      />
      <span className="text-fg-muted min-w-0 flex-1 truncate">{message}</span>
      <button
        type="button"
        onClick={onRestart}
        className="btn-primary rounded-app-sm flex h-6 items-center gap-1 px-2 text-[11px] font-medium"
      >
        <RotateCcw className="h-3 w-3" />
        {i18n.t('Restart')}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="text-fg-dim hover:text-fg hover:bg-surface-overlay rounded-app-sm flex h-6 items-center gap-1 px-2 text-[11px] font-medium transition"
      >
        <X className="h-3 w-3" />
        {i18n.t('Close tab')}
      </button>
    </div>
  );
}
