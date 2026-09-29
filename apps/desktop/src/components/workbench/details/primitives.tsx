import * as i18n from '@/i18n';
import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import type { StatusTone } from '@/lib/kube/pods';
import { toneText } from '@/lib/kube/workloads';
import { cn } from '@/lib/cn';
import { copyText } from '../util';

/** Building blocks shared by every details section. */

export function Section({
  title,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('border-border/60 border-b px-4 py-4 last:border-b-0', className)}>
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className="text-fg-dim text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          {title}
        </h3>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[minmax(96px,140px)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]">
      {children}
    </dl>
  );
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  if (children === null || children === undefined || children === '' || children === false)
    return null;
  return (
    <>
      <dt className="text-fg-dim truncate">{label}</dt>
      <dd className="text-fg min-w-0 break-words">{children}</dd>
    </>
  );
}

export function MonoText({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="font-mono text-[11.5px] break-all" title={title}>
      {children}
    </span>
  );
}

export function ToneText({
  tone,
  children,
  title,
}: {
  tone: StatusTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={cn('font-medium', toneText(tone))} title={title}>
      {children}
    </span>
  );
}

/** `key=value` chips; click copies; long lists collapse behind "Show all". */
export function ChipList({
  entries,
  limit = 8,
  empty,
}: {
  entries: Array<[string, string]> | string[];
  limit?: number;
  empty?: string;
}) {
  i18n.useLocale();
  const [expanded, setExpanded] = useState(false);
  const values = entries.map((e) => (Array.isArray(e) ? (e[1] ? `${e[0]}=${e[1]}` : e[0]) : e));
  if (!values.length) return <span className="text-fg-dim">{empty ?? '—'}</span>;
  const shown = expanded ? values : values.slice(0, limit);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => void copyText(v, v.length > 40 ? `${v.slice(0, 40)}…` : v)}
          title={i18n.t('Click to copy')}
          className="bg-fg/5 text-fg-muted ring-border/60 hover:text-fg hover:ring-border-strong max-w-full truncate rounded-md px-1.5 py-0.5 text-left font-mono text-[10.5px] ring-1 transition"
        >
          {v}
        </button>
      ))}
      {values.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="text-accent px-1 text-[11px] hover:underline"
        >
          {expanded ? i18n.t('Show less') : i18n.t('Show all {count}', { count: values.length })}
        </button>
      )}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  i18n.useLocale();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
      title={label ?? i18n.t('Copy')}
      aria-label={label ?? i18n.t('Copy')}
      className="text-fg-dim hover:text-fg hover:bg-fg/8 inline-flex h-6 w-6 items-center justify-center rounded-md transition"
    >
      {done ? <Check className="text-status-running h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export function CodeBlock({ text, maxHeight = 'max-h-72' }: { text: string; maxHeight?: string }) {
  return (
    <div className="group relative">
      <pre
        className={cn(
          'bg-fg/[0.035] border-border/60 text-fg-muted overflow-auto rounded-md border p-2.5 font-mono text-[11px] leading-[1.55] whitespace-pre',
          maxHeight,
        )}
      >
        {text || ' '}
      </pre>
      <div className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <CopyButton text={text} />
      </div>
    </div>
  );
}

export interface TableColumn<T> {
  label: string;
  cell: (row: T) => ReactNode;
  className?: string;
  /**
   * Language of the header (`'en'` for identifiers such as Container that
   * stay English in every locale, so the uppercase header keeps English
   * casing); unset, the page's language.
   */
  lang?: string;
}

export function MiniTable<T>({
  rows,
  columns,
  rowKey,
  rowClass,
  empty,
}: {
  rows: T[];
  columns: TableColumn<T>[];
  rowKey: (row: T, i: number) => string;
  rowClass?: (row: T) => string;
  empty?: string;
}) {
  i18n.useLocale();
  if (!rows.length) return <p className="text-fg-dim text-[12px]">{empty ?? i18n.t('None')}</p>;
  return (
    <div className="border-border/60 overflow-x-auto rounded-md border">
      <table className="w-full text-left text-[11.5px]">
        <thead>
          <tr className="border-border/60 bg-fg/[0.02] border-b">
            {columns.map((c) => (
              <th
                key={c.label}
                scope="col"
                lang={c.lang}
                className={cn(
                  'text-fg-dim px-2.5 py-1.5 text-[10px] font-semibold tracking-[0.08em] whitespace-nowrap uppercase',
                  c.className,
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={rowKey(r, i)}
              className={cn('border-border/40 border-b last:border-b-0', rowClass?.(r))}
            >
              {columns.map((c) => (
                <td
                  key={c.label}
                  className={cn('text-fg-muted px-2.5 py-1.5 align-top', c.className)}
                >
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Bar({ used, total, tone }: { used: number; total: number; tone?: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <span className="bg-fg/8 relative block h-1.5 w-full overflow-hidden rounded-full">
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full', tone ?? 'bg-accent')}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
