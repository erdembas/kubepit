import * as i18n from '@/i18n';
import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { pathSegments, resolveInput } from './model';

/**
 * Breadcrumb that turns into an editable path field: click a segment to
 * jump there, click the empty area (or press ⌘L / Ctrl+L in the browser)
 * to type a path; Enter goes, Escape cancels.
 */
export function PathBar({
  path,
  editSignal,
  onNavigate,
}: {
  path: string;
  /** Bump to switch into edit mode (keyboard shortcut). */
  editSignal: number;
  onNavigate: (path: string) => void;
}) {
  i18n.useLocale();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editSignal > 0) setEditing(true);
  }, [editSignal]);
  useEffect(() => {
    if (!editing) return;
    setValue(path);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing, path]);

  if (editing)
    return (
      <input
        ref={inputRef}
        autoFocus
        value={value}
        spellCheck={false}
        aria-label={i18n.t('Path')}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            setEditing(false);
            onNavigate(resolveInput(value, path));
          } else if (e.key === 'Escape') setEditing(false);
        }}
        className="border-accent bg-surface-raised text-fg rounded-app-sm h-6.5 min-w-40 flex-1 border px-2 font-mono text-[11.5px] outline-none"
      />
    );

  const segments = pathSegments(path);
  return (
    <div
      role="navigation"
      aria-label={i18n.t('Path')}
      title={i18n.t('Click to type a path')}
      onClick={() => setEditing(true)}
      className="border-border/50 bg-surface hover:border-border rounded-app-sm flex h-6.5 min-w-40 flex-1 cursor-text items-center overflow-hidden border px-1 font-mono text-[11.5px] transition"
    >
      {segments.map((segment, index) => (
        <Fragment key={segment.path}>
          {index > 1 && <ChevronRight className="text-fg-dim h-3 w-3 shrink-0" />}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(segment.path);
            }}
            className={cn(
              'hover:bg-fg/6 rounded-app-sm shrink-0 truncate px-1 py-0.5 transition',
              index === segments.length - 1 ? 'text-fg' : 'text-fg-muted',
            )}
          >
            {segment.name}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
