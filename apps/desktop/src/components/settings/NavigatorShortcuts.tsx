import * as i18n from '@/i18n';
import { useLocaleMemo as useMemo } from '@/i18n';
import { memo, useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  chordFromEvent,
  chordParts,
  formatChord,
  globalShortcutFor,
  keymapCommandFor,
} from '@/lib/keymap';
import { buildNav, flattenNav, type NavItem } from '@/lib/kube/nav';
import { cn } from '@/lib/cn';
import { useNavShortcutsStore } from '@/store/useNavShortcutsStore';

/**
 * Settings → Keyboard → Navigator shortcuts: assign a keyboard chord to any
 * cluster navigator item (Pods, Services, Ingresses, …). Only the most-used
 * kinds have a default; every other kind can be assigned here. A chord maps
 * to at most one kind — assigning it moves it off the previous owner.
 */

function ShortcutCapture({
  id,
  value,
  onChange,
  onClear,
}: {
  id?: string;
  value: string;
  onChange: (chord: string) => void;
  onClear: () => void;
}) {
  i18n.useLocale();
  const [capturing, setCapturing] = useState(false);
  return (
    <span className="flex shrink-0 items-center gap-1">
      <input
        id={id}
        readOnly
        aria-label={i18n.t('Shortcut')}
        value={value ? formatChord(value) : ''}
        placeholder={capturing ? i18n.t('Press keys…') : i18n.t('Unassigned')}
        onFocus={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') {
            (e.target as HTMLInputElement).blur();
            return;
          }
          if (e.key === 'Backspace' || e.key === 'Delete') {
            onClear();
            return;
          }
          const chord = chordFromEvent(e);
          if (chord) {
            onChange(chord);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn(
          'border-border bg-surface-raised text-fg placeholder:text-fg-dim h-6 w-28 rounded-md border px-2 text-center text-[11.5px]',
          'focus:border-accent transition focus:outline-none',
          value && 'font-mono',
        )}
      />
      {value && (
        <button
          type="button"
          aria-label={i18n.t('Clear')}
          onClick={onClear}
          className="text-fg-dim hover:text-fg rounded p-0.5"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

const Row = memo(function Row({
  item,
  chord,
  onChange,
  onClear,
}: {
  item: NavItem;
  chord: string;
  onChange: (chord: string) => void;
  onClear: () => void;
}) {
  i18n.useLocale();
  const Icon = item.icon;
  const global = chord ? globalShortcutFor(chord) : undefined;
  const keymap = chord ? keymapCommandFor(chord) : undefined;
  const conflict = global
    ? i18n.t('Taken by the app shortcut “{name}”.', { name: global.label() })
    : keymap
      ? i18n.t('Taken by the keyboard mode key “{name}”.', { name: keymap.label() })
      : null;
  return (
    <div className="hover:bg-fg/4 flex min-h-8 items-center gap-2 rounded-md px-2 py-1">
      <Icon className="text-fg-dim h-3.5 w-3.5 shrink-0" />
      <span className="text-fg-muted min-w-0 flex-1 truncate text-[12px]">{item.label}</span>
      {conflict && (
        <span title={conflict} className="shrink-0">
          <AlertTriangle className="text-status-starting h-3 w-3" aria-label={conflict} />
        </span>
      )}
      <ShortcutCapture
        id={`nav-shortcut-capture-${item.key}`}
        value={chord}
        onChange={onChange}
        onClear={onClear}
      />
    </div>
  );
});

export function NavigatorShortcutsSection() {
  i18n.useLocale();
  const [query, setQuery] = useState('');
  const shortcuts = useNavShortcutsStore((s) => s.shortcuts);
  const setShortcut = useNavShortcutsStore((s) => s.setShortcut);
  const clearShortcut = useNavShortcutsStore((s) => s.clearShortcut);
  const resetDefaults = useNavShortcutsStore((s) => s.resetDefaults);
  const pendingFocusKey = useNavShortcutsStore((s) => s.pendingFocusKey);
  const clearFocus = useNavShortcutsStore((s) => s.clearFocus);

  const all = useMemo(() => flattenNav(buildNav(null)), []);
  const q = query.trim().toLowerCase();
  const items = useMemo(
    () =>
      q
        ? all.filter(
            (i) => i.label.toLowerCase().includes(q) || i.terms.includes(q) || i.key.includes(q),
          )
        : all,
    [all, q],
  );
  const assignedCount = Object.values(shortcuts).filter((c) => c).length;

  // “Assign shortcut” in the navigator context menu asks us to focus a kind's
  // capture field. Clear the filter so the row is present, then focus it after
  // the row has rendered.
  useEffect(() => {
    if (!pendingFocusKey) return;
    setQuery('');
    const id = `nav-shortcut-capture-${pendingFocusKey}`;
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) {
          el.focus({ preventScroll: false });
          el.scrollIntoView({ block: 'center' });
        }
        clearFocus();
      }),
    );
    return () => cancelAnimationFrame(raf);
  }, [pendingFocusKey, clearFocus]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={i18n.t('Find a kind…')}
          aria-label={i18n.t('Find a resource kind')}
          className="border-border bg-surface-raised text-fg placeholder:text-fg-dim h-7 w-56 rounded-md border px-2.5 text-[12px] focus:border-accent focus:outline-none"
        />
        <span className="text-fg-dim text-[11px]">
          {i18n.t('{count} assigned', { count: assignedCount })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
          onClick={resetDefaults}
          className="ml-auto"
        >
          {i18n.t('Reset to defaults')}
        </Button>
      </div>
      <div className="border-border/60 max-h-[420px] overflow-y-auto rounded-md border">
        {items.length === 0 ? (
          <p className="text-fg-dim px-3 py-8 text-center text-[12px]">
            {i18n.t('No matching kinds')}
          </p>
        ) : (
          items.map((item) => (
            <Row
              key={item.key}
              item={item}
              chord={shortcuts[item.key] ?? ''}
              onChange={(chord) => setShortcut(item.key, chord)}
              onClear={() => clearShortcut(item.key)}
            />
          ))
        )}
      </div>
      <p className="text-fg-dim text-[11px] leading-snug">
        {i18n.t(
          'Click a field and press a key combination to assign it; Backspace clears it. A combination opens one kind; reassigning it moves it off the previous kind.',
        )}
      </p>
      <p className="text-fg-dim text-[11px] leading-snug">
        {i18n.t('Defaults use {mod}+1…9 for the most-used kinds.', {
          mod: chordParts('alt+1')[0] ?? 'Alt',
        })}
      </p>
    </div>
  );
}
