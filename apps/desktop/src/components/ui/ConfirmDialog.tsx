import * as i18n from '@/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Copy, Info, Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

export type ConfirmTone = 'danger' | 'warning' | 'info';

export function confirmWordMatches(typed: string, expected: string): boolean {
  return typed.trim() === expected;
}

interface Props {
  /** Short title for the dialog. Optional — plain message-only usage
   *  stays identical to the previous API. */
  title?: string;
  /** Main body of the confirmation. Rendered with `whitespace-pre-line`. */
  message: string;
  /** Optional monospace details block (e.g. command preview, file list). */
  details?: string;
  /** Labels for the action buttons; sensible defaults provided. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Visual severity. Defaults to `danger` for backward-compatibility with
   *  the original hard-coded `variant="danger"`. */
  tone?: ConfirmTone;
  /** When set, the confirm button stays disabled until the user types
   *  exactly this word/phrase. Used for irreversible ops (force-delete,
   *  reset, etc.) to avoid muscle-memory double-clicks. */
  confirmWord?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  details,
  confirmLabel = i18n.t('Confirm'),
  cancelLabel = i18n.t('Cancel'),
  tone = 'danger',
  confirmWord,
  onConfirm,
  onCancel,
}: Props) {
  i18n.useLocale();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const wordInputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number>(0);
  const confirmedRef = useRef(false);
  const wordInputId = useId();

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  const copyConfirmWord = async () => {
    if (!confirmWord) return;
    try {
      await navigator.clipboard.writeText(confirmWord);
      setCopied(true);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('confirm dialog: copy failed', err);
    }
  };

  // Focus strategy:
  // - When a confirmWord gate is present, focus the input so the user can
  //   start typing immediately instead of a pointless extra click.
  // - Otherwise focus the confirm button so ↵ submits, matching the
  //   previous behaviour exactly (no regression for existing callers).
  useEffect(() => {
    if (confirmWord) wordInputRef.current?.focus();
    else confirmRef.current?.focus();
  }, [confirmWord]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  const gateSatisfied = !confirmWord || confirmWordMatches(typed, confirmWord);

  // Auto-confirm: the gate is an exact-match check, so the moment the typed
  // text equals the word there is nothing left to decide — confirming right
  // away removes the second, easy-to-miss submit step. The guard keeps it to
  // one confirmation per keystroke burst.
  useEffect(() => {
    if (!confirmWord || !gateSatisfied || confirmedRef.current) return;
    confirmedRef.current = true;
    onConfirm();
  }, [confirmWord, gateSatisfied, onConfirm]);

  const Icon = tone === 'info' ? Info : AlertTriangle;
  const iconColorCls =
    tone === 'danger'
      ? 'text-status-error'
      : tone === 'warning'
        ? 'text-status-starting'
        : 'text-accent';

  return createPortal(
    <div
      className="fixed inset-0 z-10000 flex items-center justify-center bg-black/60 p-6"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="border-border bg-surface-overlay animate-fade-in rounded-app-lg w-full max-w-md border p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'mt-px flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
              tone === 'danger' && 'bg-status-error/12',
              tone === 'warning' && 'bg-status-starting/14',
              tone === 'info' && 'bg-accent/12',
            )}
          >
            <Icon className={cn('h-4 w-4', iconColorCls)} />
          </div>
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-fg mb-1 text-[14px] font-semibold">{title}</h3>}
            <p className="text-fg text-[13px] leading-relaxed whitespace-pre-line">{message}</p>
            {details && (
              <pre className="border-border bg-surface-muted/40 text-fg-muted mt-3 max-h-40 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap">
                {details}
              </pre>
            )}
            {confirmWord && (
              <div className="mt-3">
                <label
                  htmlFor={wordInputId}
                  className="text-fg-dim block text-[11px] font-semibold tracking-[0.14em] uppercase"
                >
                  {i18n.t('Type the name to confirm')}
                </label>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void copyConfirmWord()}
                    title={i18n.t('Copy')}
                    aria-label={i18n.t('Copy')}
                    className="border-border bg-surface-muted/50 text-fg hover:border-border-strong flex min-w-0 flex-1 items-center gap-2 rounded-app-sm border px-2 py-1.5 text-left transition"
                  >
                    <span className="min-w-0 flex-1 font-mono text-[11.5px] break-all select-text">
                      {confirmWord}
                    </span>
                    {copied ? (
                      <Check className="text-status-running h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <Copy className="text-fg-dim h-3.5 w-3.5 shrink-0" />
                    )}
                  </button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    leftIcon={<Keyboard className="h-3.5 w-3.5" />}
                    title={i18n.t('Fills the name and confirms')}
                    onClick={() => setTyped(confirmWord)}
                  >
                    {i18n.t('Type for me')}
                  </Button>
                </div>
                <input
                  id={wordInputId}
                  ref={wordInputRef}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && gateSatisfied) onConfirm();
                  }}
                  className="border-border bg-surface-raised text-fg focus:border-accent mt-1.5 h-8 w-full rounded-app-sm border px-2.5 font-mono text-[12px] transition focus:outline-none"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                />
                <p className="text-fg-dim mt-1.5 text-[11px]">
                  {i18n.t('It confirms on its own once the text matches.')}
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'info' ? 'primary' : 'danger'}
            onClick={onConfirm}
            ref={confirmRef}
            disabled={!gateSatisfied}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
