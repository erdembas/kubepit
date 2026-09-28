import * as i18n from '@/i18n';
import { useEffect, useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { Kbd } from '@/components/ui/Kbd';
import { cn } from '@/lib/cn';
import { chordFromEvent, formatChord, normalizeChord } from '@/lib/keymap';

/** Records one chord (Esc cancels, Backspace clears). */
export function ShortcutRecorder({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (chord: string | null) => void;
}) {
  i18n.useLocale();
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      // Capture phase: the dialog must not see Esc while recording.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setRecording(false);
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        onChange(null);
        return setRecording(false);
      }
      const chord = chordFromEvent(e);
      if (!chord) return;
      const normalized = normalizeChord(chord);
      if (!normalized) return;
      onChange(normalized);
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onChange]);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setRecording((r) => !r)}
        className={cn(
          'border-border bg-surface-raised text-fg rounded-app-sm inline-flex h-8 min-w-40 items-center gap-2 border px-2.5 text-[12px] transition',
          recording ? 'border-accent text-accent' : 'hover:border-border-strong',
        )}
        aria-label={i18n.t('Record shortcut')}
      >
        <Keyboard className="h-3.5 w-3.5 shrink-0" />
        {recording ? (
          <span>{i18n.t('Press a key…')}</span>
        ) : value ? (
          <Kbd className="h-5 px-1.5 text-[11px]">
            <span lang="en">{formatChord(value)}</span>
          </Kbd>
        ) : (
          <span className="text-fg-dim">{i18n.t('No shortcut')}</span>
        )}
      </button>
      {value && !recording && (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label={i18n.t('Remove shortcut')}
          className="text-fg-dim hover:text-fg rounded p-1"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {recording && (
        <span className="text-fg-dim text-[11px]">
          {i18n.t('Esc cancels, Backspace removes the shortcut.')}
        </span>
      )}
    </div>
  );
}
