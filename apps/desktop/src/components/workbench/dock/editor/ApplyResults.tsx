import * as i18n from '@/i18n';
import { CheckCircle2, Circle, Loader2, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { DocResult } from './applyManifest';

/** Per-document outcome list under the editor (problems-panel style). */
export function ApplyResults({
  results,
  onDismiss,
}: {
  results: DocResult[];
  onDismiss: () => void;
}) {
  i18n.useLocale();
  const running = results.some((r) => r.state === 'running' || r.state === 'pending');
  const ok = results.filter((r) => r.state === 'ok').length;
  const failed = results.filter((r) => r.state === 'error').length;
  return (
    <div className="border-border/60 bg-surface flex max-h-[40%] min-h-0 shrink-0 flex-col border-t">
      <div className="text-fg-dim flex h-7 shrink-0 items-center gap-2 px-3 text-[11px]">
        <span className="text-fg-muted font-semibold tracking-[0.06em] uppercase">
          {i18n.t('Results')}
        </span>
        <span className="tabular-nums">
          {running
            ? i18n.t('Applying…')
            : i18n.t('{ok} succeeded · {failed} failed', { ok, failed })}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          title={i18n.t('Dismiss')}
          aria-label={i18n.t('Dismiss')}
          className="text-fg-dim hover:text-fg hover:bg-surface-overlay rounded-app-sm ml-auto flex h-5 w-5 items-center justify-center transition"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <ul className="min-h-0 overflow-y-auto px-2 pb-2">
        {results.map((r) => (
          <li
            key={r.index}
            className="rounded-app-sm hover:bg-fg/5 flex items-start gap-2 px-1.5 py-1 text-[12px]"
          >
            <StateIcon state={r.state} />
            <span className="text-fg shrink-0 font-mono text-[11.5px]">{r.label}</span>
            {r.namespace && (
              <span className="text-fg-dim border-border/70 shrink-0 rounded border px-1 font-mono text-[10px] leading-4">
                {r.namespace}
              </span>
            )}
            {r.message && (
              <span
                className={cn(
                  'min-w-0 flex-1 text-[11.5px] break-words whitespace-pre-wrap',
                  r.state === 'error' ? 'text-status-error' : 'text-fg-dim',
                )}
              >
                {r.message}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StateIcon({ state }: { state: DocResult['state'] }) {
  const cls = 'mt-0.5 h-3.5 w-3.5 shrink-0';
  if (state === 'running') return <Loader2 className={cn(cls, 'text-accent animate-spin')} />;
  if (state === 'ok') return <CheckCircle2 className={cn(cls, 'text-status-running')} />;
  if (state === 'error') return <XCircle className={cn(cls, 'text-status-error')} />;
  return <Circle className={cn(cls, 'text-fg-dim')} />;
}
