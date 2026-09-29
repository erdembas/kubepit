import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import * as i18n from '@/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { ResponseLanguageSelect } from '@/components/assistant/ResponseLanguageSelect';
import { settingsIssues, hasBlockingIssues } from '@/lib/ai/settingsIssues';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/useAppStore';
import type { AiEffort, AiSettings, AiStatus } from '@/types';
import { useSettingsDraft } from './categories';
import { SettingsPageShell, SettingsSection } from './SettingsView';
import { ProvidersSection } from './assistant/ProvidersSection';
import { PrivacySection } from './assistant/PrivacySection';
import { PricesSection } from './assistant/PricesSection';
import { ClustersSection } from './assistant/ClustersSection';
import { RequestLogSection } from './assistant/RequestLogSection';
import { Field, errorText } from './assistant/Fields';
import { isLocalAgent } from '@/lib/ai/localAgents';

export function AssistantCategory({ description }: { description: string }) {
  i18n.useLocale();
  const saved = useAppStore((s) => s.settings);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await ipc.aiStatus();
      if (id === request.current) {
        setStatus(next);
        setError(null);
      }
    } catch (e) {
      if (id === request.current) {
        setStatus(null);
        setError(errorText(e));
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      ++request.current;
    };
  }, [refresh, saved?.ai]);
  const { draft, update, footer } = useSettingsDraft({
    saveBlocked: (d) =>
      hasBlockingIssues(settingsIssues(d.ai, status))
        ? i18n.t('Fix the highlighted assistant settings before saving.')
        : null,
  });
  if (!draft) return <p className="text-fg-dim text-[12px]">{i18n.t('Loading settings…')}</p>;
  const ai = draft.ai;
  const activeProvider = ai.providers.find((provider) => provider.id === ai.active_provider);
  const agent = !!activeProvider && isLocalAgent(activeProvider.kind);
  const issues = settingsIssues(ai, status);
  const set = (patch: Partial<AiSettings>) => update('ai', { ...ai, ...patch });
  return (
    <SettingsPageShell description={description} footer={footer}>
      <div className="@container space-y-6">
        <SettingsSection title={i18n.t('Assistant')}>
          <Switch
            checked={ai.enabled}
            onChange={(enabled) => set({ enabled })}
            label={i18n.t('Enable assistant')}
            description={i18n.t(
              'Use your own model provider or a local model. Cluster access is enabled separately.',
            )}
          />
          <div className="mt-4 max-w-sm">
            <ResponseLanguageSelect
              value={ai.response_language ?? null}
              onChange={(response_language) => set({ response_language })}
            />
            <p className="text-fg-dim mt-2 text-[11px]">
              {i18n.t(
                'Choose the language for assistant responses without changing the app language. Applies to new chats.',
              )}
            </p>
          </div>
          {error && (
            <div role="alert" className="text-status-error mt-3 text-[11px]">
              {assistantErrorMessage(error)}
              <Button size="xs" variant="ghost" onClick={() => void refresh()}>
                {i18n.t('Retry')}
              </Button>
            </div>
          )}
          {status && !status.remote_allowed && (
            <p className="text-status-starting mt-3 text-[11px]">
              {i18n.t(
                'This app cannot reach remote providers. Choose a provider on this computer (localhost).',
              )}
            </p>
          )}
        </SettingsSection>
        <ProvidersSection
          ai={ai}
          saved={saved?.ai ?? ai}
          status={status}
          issues={issues}
          onChange={set}
          refreshStatus={refresh}
        />
        <PrivacySection ai={ai} onChange={set} />
        <SettingsSection title={i18n.t('Context budget')}>
          <div className="grid gap-3 @min-[460px]:grid-cols-2">
            <Field
              label={i18n.t('Maximum context tokens')}
              issues={issues}
              field="max_context_tokens"
            >
              <Input
                type="number"
                min={2000}
                max={900000}
                value={ai.max_context_tokens}
                aria-label={i18n.t('Maximum context tokens')}
                onChange={(e) => set({ max_context_tokens: Number(e.target.value) })}
              />
            </Field>
            {!agent && (
              <Field label={i18n.t('Reasoning effort')}>
                <Select
                  value={ai.effort ?? 'auto'}
                  onChange={(value) =>
                    set({ effort: value === 'auto' ? null : (value as AiEffort) })
                  }
                  ariaLabel={i18n.t('Reasoning effort')}
                  options={[
                    { value: 'auto', label: i18n.t('Automatic') },
                    { value: 'low', label: i18n.t('Low') },
                    { value: 'medium', label: i18n.t('Medium') },
                    { value: 'high', label: i18n.t('High') },
                    { value: 'xhigh', label: i18n.t('Extra high') },
                    { value: 'max', label: i18n.t('Maximum') },
                  ]}
                />
              </Field>
            )}
          </div>
        </SettingsSection>
        <PricesSection prices={ai.prices} issues={issues} onChange={(prices) => set({ prices })} />
        <ClustersSection />
        <RequestLogSection />
      </div>
    </SettingsPageShell>
  );
}
