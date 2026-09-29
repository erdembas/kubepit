import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import * as i18n from '@/i18n';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { AiModelInfo, AiProviderConfig, AiSettings, AiStatus } from '@/types';
import type { SettingsIssue } from '@/lib/ai/settingsIssues';
import { SettingsSection } from '../SettingsView';
import { Field, Issues, errorText } from './Fields';

interface Props {
  ai: AiSettings;
  saved: AiSettings;
  status: AiStatus | null;
  issues: SettingsIssue[];
  onChange: (patch: Partial<AiSettings>) => void;
  refreshStatus: () => Promise<void>;
}
export function ProvidersSection(props: Props) {
  i18n.useLocale();
  return (
    <SettingsSection title={i18n.t('Model providers')}>
      <Issues issues={props.issues} field="active_provider" />
      <div className="space-y-3">
        {props.ai.providers.map((provider) => (
          <ProviderRow key={provider.id} {...props} provider={provider} />
        ))}
      </div>
    </SettingsSection>
  );
}

function ProviderRow({
  provider,
  ai,
  saved,
  status,
  issues,
  onChange,
  refreshStatus,
}: Props & { provider: AiProviderConfig }) {
  i18n.useLocale();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const mounted = useRef(true);
  const address = `${provider.id}|${provider.base_url}`;
  const currentAddress = useRef(address);
  currentAddress.current = address;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setModels([]);
    setKey('');
  }, [provider.id, provider.base_url]);
  const current = status?.providers.find((p) => p.id === provider.id);
  const savedProvider = saved.providers.find((p) => p.id === provider.id);
  // IPC resolves the saved provider configuration. Never attach a typed key
  // or fetched model list to an unsaved address shown in the draft.
  const changed = JSON.stringify(provider) !== JSON.stringify(savedProvider);
  const update = (patch: Partial<AiProviderConfig>) =>
    onChange({
      providers: ai.providers.map((p) => (p.id === provider.id ? { ...p, ...patch } : p)),
    });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      useAppStore.getState().pushToast('error', assistantErrorMessage(errorText(e)));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const prefix = `providers.${provider.id}`;
  return (
    <div className="border-border/70 rounded-md border p-3">
      <label className="text-fg mb-3 flex items-center gap-2 text-[12px] font-medium">
        <input
          type="radio"
          name="assistant-provider"
          checked={ai.active_provider === provider.id}
          onChange={() => onChange({ active_provider: provider.id })}
          className="accent-accent"
        />
        <span className="min-w-0 flex-1 truncate">{provider.name}</span>
        {current?.local && <span className="text-fg-dim text-[10px]">{i18n.t('Local')}</span>}
      </label>
      <div className="grid gap-3 @min-[460px]:grid-cols-2">
        <Field label={i18n.t('Base URL')} issues={issues} field={`${prefix}.base_url`}>
          <Input
            value={provider.base_url}
            aria-label={i18n.t('Base URL for {name}', { name: provider.name })}
            spellCheck={false}
            onChange={(e) => update({ base_url: e.target.value })}
          />
        </Field>
        <Field label={i18n.t('Model')} issues={issues} field={`${prefix}.model`}>
          <Input
            value={provider.model}
            aria-label={i18n.t('Model for {name}', { name: provider.name })}
            spellCheck={false}
            onChange={(e) => update({ model: e.target.value })}
          />
        </Field>
        <Field label={i18n.t('Context window')} issues={issues} field={`${prefix}.context_window`}>
          <Input
            type="number"
            min={1}
            value={provider.context_window ?? ''}
            aria-label={i18n.t('Context window for {name}', { name: provider.name })}
            placeholder={i18n.t('Automatic')}
            onChange={(e) =>
              update({ context_window: e.target.value === '' ? null : Number(e.target.value) })
            }
          />
        </Field>
        <Field
          label={i18n.t('Maximum output tokens')}
          issues={issues}
          field={`${prefix}.max_output_tokens`}
        >
          <Input
            type="number"
            min={1}
            value={provider.max_output_tokens}
            aria-label={i18n.t('Maximum output tokens for {name}', { name: provider.name })}
            onChange={(e) => update({ max_output_tokens: Number(e.target.value) })}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="secondary"
          disabled={busy || changed}
          onClick={() =>
            void run(async () => {
              const result = await ipc.aiModels(provider.id);
              if (mounted.current && currentAddress.current === address) setModels(result);
            })
          }
        >
          {i18n.t('Fetch models')}
        </Button>
        {models.length > 0 && (
          <SearchableSelect
            compact
            value={provider.model}
            label={i18n.t('Model for {name}', { name: provider.name })}
            options={models.map((m) => ({
              value: m.id,
              label: m.display_name || m.id,
              description: m.id,
            }))}
            onChange={(model) => update({ model })}
          />
        )}
      </div>
      <div className="border-border/50 mt-3 border-t pt-3">
        <p className="text-fg-dim mb-2 text-[11px]">
          {current?.has_key
            ? i18n.t('Stored in {keychain}', { keychain: status?.keychain ?? '' })
            : i18n.t('No stored API key')}
        </p>
        <Issues issues={issues} field={`${prefix}.key`} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            type="password"
            value={key}
            autoComplete="new-password"
            spellCheck={false}
            className="min-w-0 flex-1"
            aria-label={i18n.t('API key for {name}', { name: provider.name })}
            disabled={busy || changed}
            onChange={(e) => setKey(e.target.value)}
          />
          <Button
            size="xs"
            variant="secondary"
            disabled={busy || changed || !key.trim()}
            onClick={() =>
              void run(async () => {
                await ipc.aiKeySet(provider.id, key);
                setKey('');
                await refreshStatus();
              })
            }
          >
            {i18n.t('Set')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !current || (!current.has_key && !current.key_error)}
            onClick={() =>
              void run(async () => {
                await ipc.aiKeyDelete(provider.id);
                setKey('');
                await refreshStatus();
              })
            }
          >
            {i18n.t('Remove')}
          </Button>
        </div>
        {changed && (
          <p className="text-status-starting mt-2 text-[11px]">
            {i18n.t('Save provider changes before setting a key or fetching models.')}
          </p>
        )}
      </div>
    </div>
  );
}
