import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { AiLocalAgent, AiModelInfo, AiProviderConfig, AiSettings, AiStatus } from '@/types';
import { isLocalAgent } from '@/lib/ai/localAgents';
import type { SettingsIssue } from '@/lib/ai/settingsIssues';
import { SettingsSection } from '../SettingsView';
import { Field, Issues, errorText } from './Fields';
import { LocalAgentsSection } from './LocalAgentsSection';
import { NativeModelControls } from '@/components/assistant/NativeModelControls';
import { AgentProviderLogo } from '@/components/assistant/AgentProviderLogo';
import { agentSelectionPatch, DEFAULT_AGENT_OPTIONS } from '@/lib/ai/agentModelOptions';

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
  const [agents, setAgents] = useState<AiLocalAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const discover = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await ipc.aiLocalAgents();
      if (id === request.current) {
        setAgents(next);
        setError(null);
      }
    } catch (e) {
      if (id === request.current) setError(errorText(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void discover();
    return () => {
      ++request.current;
    };
  }, [discover]);
  return (
    <>
      <LocalAgentsSection
        ai={props.ai}
        agents={agents}
        loading={loading}
        error={error ? assistantErrorMessage(error) : null}
        onChange={props.onChange}
        refresh={() => {
          void discover();
          void props.refreshStatus();
        }}
      />
      <SettingsSection title={i18n.t('Model providers')}>
        <Issues issues={props.issues} field="active_provider" />
        <div className="space-y-3">
          {props.ai.providers.map((provider) => (
            <ProviderRow key={provider.id} {...props} provider={provider} />
          ))}
        </div>
      </SettingsSection>
    </>
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
  const agent = isLocalAgent(provider.kind);
  const selected = ai.active_provider === provider.id;
  return (
    <div className={`border-border/70 relative rounded-lg border p-3 ${selected ? 'bg-fg/3' : ''}`}>
      {selected && <span className="bg-accent absolute inset-y-3 left-0 w-0.5 rounded-r" />}
      <label className="text-fg mb-3 flex cursor-pointer items-center gap-2.5 text-[12px] font-medium">
        <div className="bg-fg/4 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
          <AgentProviderLogo kind={provider.kind} baseUrl={provider.base_url} className="h-5 w-5" />
        </div>
        <span className="min-w-0 flex-1 truncate">{provider.name}</span>
        {agent && <span className="text-fg-dim text-[10px]">{i18n.t('Local agent')}</span>}
        {current?.local && <span className="text-fg-dim text-[10px]">{i18n.t('Local')}</span>}
        <input
          type="radio"
          name="assistant-provider"
          checked={selected}
          onChange={() => onChange({ active_provider: provider.id })}
          className="accent-accent"
        />
      </label>
      {agent && <Issues issues={issues} field={`${prefix}.executable`} />}
      {agent && (
        <div className="mb-3">
          <NativeModelControls
            provider={provider}
            options={ai.agent_options?.[provider.id] ?? DEFAULT_AGENT_OPTIONS}
            enabled={
              ai.active_provider === provider.id &&
              !ai.local_only &&
              status?.remote_allowed !== false
            }
            onChange={(model, options) =>
              onChange(agentSelectionPatch(ai, provider, model, options))
            }
          />
          <Issues issues={issues} field={`${prefix}.model`} />
        </div>
      )}
      <div className="grid gap-3 @min-[460px]:grid-cols-2">
        {!agent && (
          <Field label={i18n.t('Base URL')} issues={issues} field={`${prefix}.base_url`}>
            <Input
              value={provider.base_url}
              aria-label={i18n.t('Base URL for {name}', { name: provider.name })}
              spellCheck={false}
              onChange={(e) => update({ base_url: e.target.value })}
            />
          </Field>
        )}
        {!agent && (
          <Field label={i18n.t('Model')} issues={issues} field={`${prefix}.model`}>
            <Input
              value={provider.model}
              aria-label={i18n.t('Model for {name}', { name: provider.name })}
              spellCheck={false}
              placeholder={agent ? i18n.t('Agent default') : undefined}
              onChange={(e) => update({ model: e.target.value })}
            />
          </Field>
        )}
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
      {agent ? (
        <div className="text-fg-dim mt-3 space-y-1 text-[11px]">
          <p>
            {i18n.t(
              'Choose Agent default to let the agent select its model. Requests use your existing CLI sign-in.',
            )}
          </p>
          <p>{i18n.t('Output limits for local agents are approximate.')}</p>
          {provider.kind === 'opencode-cli' && (
            <p>
              {i18n.t(
                'For OpenCode, enter a model as provider/model, for example anthropic/claude-sonnet-4-5.',
              )}
            </p>
          )}
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
