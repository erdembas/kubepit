import * as i18n from '@/i18n';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/useAppStore';

export function Toasts() {
  i18n.useLocale();
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-12 z-[70] flex w-[360px] flex-col gap-2">
      {toasts.map((toast) => {
        const Icon =
          toast.tone === 'success' ? CheckCircle2 : toast.tone === 'error' ? XCircle : Info;
        return (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className="border-border bg-surface-overlay animate-slide-in-right pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
          >
            <Icon
              className={cn(
                'mt-px h-4 w-4 shrink-0',
                toast.tone === 'success'
                  ? 'text-status-running'
                  : toast.tone === 'error'
                    ? 'text-status-error'
                    : 'text-accent',
              )}
            />
            <p className="text-fg min-w-0 flex-1 text-[12px] leading-snug break-words whitespace-pre-line">
              {toast.message}
            </p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label={i18n.t('Dismiss')}
              className="text-fg-dim hover:text-fg -mt-0.5 rounded p-0.5"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
