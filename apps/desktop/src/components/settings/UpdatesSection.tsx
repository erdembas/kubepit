import * as i18n from '@/i18n';
import { useEffect } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, RotateCw, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Markdown } from '@/components/workbench/common/Markdown';
import { formatBytes } from '@/lib/format';
import { useUpdaterStore } from '@/store/useUpdaterStore';
import { SettingsSection } from './SettingsView';

/** "Updates" block of Settings → About & Updates. */
export function UpdatesSection({
  autoCheck,
  onAutoCheck,
}: {
  autoCheck: boolean | null;
  onAutoCheck: (value: boolean) => void;
}) {
  i18n.useLocale();
  const status = useUpdaterStore((s) => s.status);
  const phase = useUpdaterStore((s) => s.phase);
  const update = useUpdaterStore((s) => s.update);
  const error = useUpdaterStore((s) => s.error);
  const checkedAt = useUpdaterStore((s) => s.checkedAt);
  const store = useUpdaterStore.getState;

  useEffect(() => {
    if (!useUpdaterStore.getState().status) void useUpdaterStore.getState().loadStatus();
  }, []);

  if (!status)
    return (
      <SettingsSection title={i18n.t('Updates')}>
        <p className="text-fg-dim text-[12px]">{error ?? i18n.t('Loading…')}</p>
      </SettingsSection>
    );

  if (!status.configured)
    return (
      <SettingsSection title={i18n.t('Updates')}>
        <div className="border-border/70 bg-surface-raised/50 flex items-start gap-3 rounded-md border px-3 py-2.5">
          <ShieldOff className="text-fg-dim mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 text-[12px]">
            <p className="text-fg font-medium">
              {i18n.t('Updates are not configured for this build.')}
            </p>
            <p className="text-fg-dim mt-0.5 text-[11px] leading-snug">
              {i18n.t(
                'Only release builds signed with the Kubepit update key can check for and install new versions. Download new releases from GitHub instead.',
              )}
            </p>
          </div>
        </div>
      </SettingsSection>
    );

  const checking = phase === 'checking';
  const busy = checking || phase === 'downloading' || phase === 'installing';
  return (
    <SettingsSection
      title={i18n.t('Updates')}
      trailing={
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void store().check()}
          leftIcon={
            checking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )
          }
        >
          {i18n.t('Check for updates')}
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-fg-dim text-[11.5px]">
          {checkedAt
            ? i18n.t('Current version {version} · last checked {time}', {
                version: status.current_version,
                time: i18n.date(checkedAt, { hour: '2-digit', minute: '2-digit' }),
              })
            : i18n.t('Current version {version}', { version: status.current_version })}
        </p>
        {phase === 'up-to-date' && (
          <p className="text-fg flex items-center gap-2 text-[12px]">
            <CheckCircle2 className="text-status-running h-3.5 w-3.5" />
            {i18n.t('Kubepit is up to date.')}
          </p>
        )}
        {phase === 'error' && error && (
          <p className="text-status-error text-[12px] break-words">{error}</p>
        )}
        {update && phase !== 'up-to-date' && <UpdateCard />}
        {autoCheck !== null && (
          <Switch
            checked={autoCheck}
            onChange={onAutoCheck}
            label={i18n.t('Check for updates on startup')}
            description={i18n.t(
              'Asks {endpoint} once after launch. Nothing is downloaded without your click.',
              { endpoint: hostOf(status.endpoint) },
            )}
          />
        )}
      </div>
    </SettingsSection>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function UpdateCard() {
  i18n.useLocale();
  const update = useUpdaterStore((s) => s.update)!;
  const phase = useUpdaterStore((s) => s.phase);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const total = useUpdaterStore((s) => s.total);
  const store = useUpdaterStore.getState;
  const pct = total ? Math.min(100, (downloaded / total) * 100) : null;

  return (
    <div className="border-border/70 bg-surface-raised/50 rounded-md border">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="bg-accent/12 text-accent flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
          <Download className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-fg text-[12.5px] font-semibold">
            {i18n.t('Kubepit {version} is available', { version: update.version })}
          </p>
          <p className="text-fg-dim text-[11px]">
            {update.date
              ? i18n.t('Released {date} · you have {current}', {
                  date: i18n.date(new Date(update.date), { dateStyle: 'medium' }),
                  current: update.current_version,
                })
              : i18n.t('You have {current}', { current: update.current_version })}
          </p>
        </div>
        {phase === 'ready' ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => void store().relaunch()}
            leftIcon={<RotateCw className="h-3.5 w-3.5" />}
          >
            {i18n.t('Relaunch now')}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={phase === 'downloading' || phase === 'installing'}
            onClick={() => void store().install()}
            leftIcon={<Download className="h-3.5 w-3.5" />}
          >
            {i18n.t('Download and install')}
          </Button>
        )}
      </div>
      {(phase === 'downloading' || phase === 'installing' || phase === 'ready') && (
        <div className="border-border/60 border-t px-3 py-2.5">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase === 'downloading' ? Math.round(pct ?? 0) : 100}
            aria-label={i18n.t('Download progress')}
            className="bg-fg/8 relative h-1.5 overflow-hidden rounded-full"
          >
            <span
              className="bg-accent absolute inset-y-0 left-0 rounded-full transition-[width] duration-150"
              style={{ width: `${phase === 'downloading' ? (pct ?? 8) : 100}%` }}
            />
          </div>
          <p className="text-fg-dim mt-1.5 text-[11px] tabular-nums">
            {phase === 'ready'
              ? i18n.t('Update installed. Relaunch Kubepit to finish.')
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
      {update.notes && (
        <div className="border-border/60 border-t px-3 py-2.5">
          <div className="text-fg-dim mb-1.5 text-[10px] font-semibold tracking-[0.12em] uppercase">
            {i18n.t('Release notes')}
          </div>
          <div className="overlay-scroll max-h-56 overflow-y-auto pr-1">
            <Markdown source={update.notes} />
          </div>
        </div>
      )}
    </div>
  );
}
