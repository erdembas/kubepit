import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, Languages } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Compact language switcher for the status bar, the sibling of `ThemeMenu`.
 * Language names are endonyms so each option stays readable to its speakers
 * whatever the current display language is.
 */
const LABELS: Record<i18n.Locale, string> = { en: 'English', tr: 'Türkçe' };
const OPTIONS = i18n.LOCALES.map((key) => ({ key, label: LABELS[key] }));

export function LanguageMenu() {
  const locale = i18n.useLocale();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as HTMLElement)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={i18n.t('Language: {language}', { language: LABELS[locale] })}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'rounded-app-sm hover:bg-surface-overlay hover:text-fg flex items-center gap-1.5 px-1.5 py-1 transition',
          open ? 'bg-surface-overlay text-fg' : 'text-fg-muted',
        )}
      >
        <Languages className="h-3 w-3" />
        <span className="text-fg-dim text-[11px] uppercase">{locale}</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={i18n.t('Display language')}
          className="border-border bg-surface-raised rounded-app-sm animate-fade-in absolute right-0 bottom-full z-50 mb-1.5 w-[160px] overflow-hidden border shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
        >
          {OPTIONS.map((opt) => {
            const active = locale === opt.key;
            return (
              <button
                key={opt.key}
                role="menuitemradio"
                aria-checked={active}
                lang={opt.key}
                type="button"
                onClick={() => {
                  i18n.setLocale(opt.key);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] transition',
                  active
                    ? 'bg-accent/10 text-accent'
                    : 'text-fg-muted hover:bg-surface-overlay hover:text-fg',
                )}
              >
                <span className="text-fg-dim w-5 font-mono text-[10px] uppercase">{opt.key}</span>
                <span className="flex-1 font-medium">{opt.label}</span>
                {active && <Check className="text-accent h-3 w-3" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
