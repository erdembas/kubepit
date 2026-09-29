import * as i18n from '@/i18n';
import { Switch } from '@/components/ui/Switch';
import { Select } from '@/components/ui/Select';
import type { AiSettings, AiToolPolicy } from '@/types';
import { SettingsSection } from '../SettingsView';
import { Field } from './Fields';
import { isLocalAgent } from '@/lib/ai/localAgents';

export function PrivacySection({
  ai,
  onChange,
}: {
  ai: AiSettings;
  onChange: (patch: Partial<AiSettings>) => void;
}) {
  i18n.useLocale();
  const active = ai.providers.find((provider) => provider.id === ai.active_provider);
  const agent = !!active && isLocalAgent(active.kind);
  return (
    <SettingsSection title={i18n.t('Privacy')}>
      <div className="space-y-3">
        <Switch
          checked={ai.local_only}
          onChange={(local_only) => onChange({ local_only })}
          label={i18n.t('Local-only mode')}
          description={i18n.t(
            'Refuse every remote provider. Only loopback addresses on this computer are allowed.',
          )}
        />
        <p className="text-fg-dim text-[11px]">
          {i18n.t('Secret values and private keys are always masked before sending.')}
        </p>
        <Switch
          checked={ai.redaction.tokens}
          onChange={(tokens) => onChange({ redaction: { ...ai.redaction, tokens } })}
          label={i18n.t('Mask tokens')}
        />
        <Switch
          checked={ai.redaction.ips}
          onChange={(ips) => onChange({ redaction: { ...ai.redaction, ips } })}
          label={i18n.t('Mask IP addresses')}
        />
        <Switch
          checked={ai.redaction.hostnames}
          onChange={(hostnames) => onChange({ redaction: { ...ai.redaction, hostnames } })}
          label={i18n.t('Mask hostnames')}
        />
        <Field label={i18n.t('Read-only tools')}>
          <Select
            value={agent ? 'off' : ai.tool_policy}
            disabled={agent}
            ariaLabel={i18n.t('Read-only tools')}
            onChange={(value) => onChange({ tool_policy: value as AiToolPolicy })}
            options={[
              { value: 'off', label: i18n.t('Off') },
              { value: 'ask', label: i18n.t('Ask before sharing each result') },
              { value: 'session', label: i18n.t('Share results for this session') },
            ]}
          />
          {agent && (
            <p className="text-fg-dim mt-2 text-[11px]">
              {i18n.t(
                'Local agents answer from the previewed context. Read-only tools are unavailable for these providers.',
              )}
            </p>
          )}
        </Field>
        <Switch
          checked={ai.log_requests}
          onChange={(log_requests) => onChange({ log_requests })}
          label={i18n.t('Record assistant requests')}
          description={i18n.t(
            'Keep redacted requests, responses and usage in the local history database.',
          )}
        />
      </div>
    </SettingsSection>
  );
}
