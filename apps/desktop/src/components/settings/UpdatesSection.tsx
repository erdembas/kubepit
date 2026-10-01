import * as i18n from '@/i18n';
import { useEffect } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { UpdateCard } from '@/components/updates/UpdateCard';
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
          disabled={busy || phase === 'ready'}
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
        {phase === 'error' && error && !update && (
          <p className="text-status-error text-[12px] break-words">{error}</p>
        )}
        {update && phase !== 'up-to-date' && <UpdateCard />}
        {autoCheck !== null && (
          <Switch
            checked={autoCheck}
            onChange={onAutoCheck}
            label={i18n.t('Check for updates automatically')}
            description={i18n.t(
              'Checks {endpoint} after launch and every 5 minutes. Nothing is downloaded without your click.',
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
