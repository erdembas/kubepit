import * as i18n from '@/i18n';
import { ArrowRight, Check, Download, Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Markdown } from '@/components/workbench/common/Markdown';
import { formatBytes } from '@/lib/format';
import { useUpdaterStore } from '@/store/useUpdaterStore';

/** Shared release details for About & Updates and the announcement dialog. */
export function UpdateCard() {
  i18n.useLocale();
  const update = useUpdaterStore((s) => s.update);
  const phase = useUpdaterStore((s) => s.phase);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const total = useUpdaterStore((s) => s.total);
  const error = useUpdaterStore((s) => s.error);
  const relaunching = useUpdaterStore((s) => s.relaunching);
  const store = useUpdaterStore.getState;
  if (!update) return null;
  const ready = phase === 'ready';
  const working = phase === 'downloading' || phase === 'installing';
  const pct = total && total > 0 ? Math.min(100, Math.max(0, (downloaded / total) * 100)) : null;
  const date =
    update.date && Number.isFinite(Date.parse(update.date)) ? new Date(update.date) : null;

  return (
    <div className="border-border/70 bg-surface-raised/40 overflow-hidden rounded-md border">
      <div className="border-accent/70 relative border-l-2 px-4 py-4">
        <div className="flex items-start gap-3">
          <span className="bg-accent/12 text-accent flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
            {ready ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-fg text-[13px] font-semibold">
              {ready
                ? i18n.t('Kubepit {version} is ready', { version: update.version })
                : i18n.t('Kubepit {version} is available', { version: update.version })}
            </p>
            <div className="text-fg-dim mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-mono tabular-nums">v{update.current_version}</span>
              <ArrowRight aria-hidden="true" className="h-3 w-3" />
              <span className="bg-accent/10 text-accent rounded px-1.5 py-0.5 font-mono tabular-nums">
                v{update.version}
              </span>
              {date && (
                <span>
                  {i18n.t('Released {date}', { date: i18n.date(date, { dateStyle: 'medium' }) })}
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="text-fg-muted mt-3 text-[12px] leading-relaxed">
          {ready
            ? i18n.t('Update installed. Relaunch Kubepit to finish.')
            : i18n.t('Review what changed, then install when you are ready.')}
        </p>
      </div>
      {update.notes ? (
        <div className="border-border/60 border-t px-4 py-3">
          <div className="text-fg-dim mb-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
            {i18n.t('Release notes')}
          </div>
          <div className="overlay-scroll max-h-64 overflow-y-auto pr-1">
            <Markdown source={update.notes} />
          </div>
        </div>
      ) : (
        <p className="border-border/60 text-fg-dim border-t px-4 py-3 text-[12px]">
          {i18n.t('No release notes were provided for this version.')}
        </p>
      )}
      {(working || ready) && (
        <div className="border-border/60 border-t px-4 py-3">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              ready ? 100 : phase === 'downloading' && pct !== null ? Math.round(pct) : undefined
            }
            aria-label={
              phase === 'installing' ? i18n.t('Installing update') : i18n.t('Download progress')
            }
            className="bg-fg/8 relative h-1.5 overflow-hidden rounded-full"
          >
            <span
              className="bg-accent absolute inset-y-0 left-0 rounded-full transition-[width] duration-150"
              style={{ width: `${phase === 'downloading' ? (pct ?? 12) : 100}%` }}
            />
          </div>
          <p role="status" className="text-fg-dim mt-2 text-[11px] tabular-nums">
            {ready
              ? i18n.t('Ready to relaunch')
              : phase === 'installing'
                ? i18n.t('Installing…')
                : total
                  ? i18n.t('Downloading… {downloaded} of {total}', {
                      downloaded: formatBytes(downloaded),
                      total: formatBytes(total),
                    })
                  : i18n.t('Downloading… {downloaded}', { downloaded: formatBytes(downloaded) })}
          </p>
        </div>
      )}
      {phase === 'error' && error && (
        <p
          role="alert"
          className="border-border/60 text-status-error border-t px-4 py-3 text-[12px] break-words"
        >
          {error}
        </p>
      )}
      <div className="border-border/60 bg-fg/2 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        <div className="text-fg-dim min-w-0 flex-1 basis-48 text-[11px] leading-relaxed">
          <p>
            {ready
              ? i18n.t('Save your work before relaunching.')
              : i18n.t('Installation may close Kubepit. Save your work first.')}
          </p>
          {!ready && (
            <p className="mt-1">
              {i18n.t('Your operating system may ask for permission to install the update.')}
            </p>
          )}
        </div>
        {ready ? (
          <Button
            variant="primary"
            size="sm"
            disabled={relaunching}
            onClick={() => void store().relaunch()}
            leftIcon={
              relaunching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )
            }
          >
            {relaunching ? i18n.t('Relaunching…') : i18n.t('Relaunch now')}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={working || phase === 'checking'}
            onClick={() => void store().install()}
            leftIcon={
              working ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )
            }
          >
            {working ? i18n.t('Updating…') : i18n.t('Download and install')}
          </Button>
        )}
      </div>
    </div>
  );
}
