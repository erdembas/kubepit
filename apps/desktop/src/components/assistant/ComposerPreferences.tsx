import { useId, useRef, useState } from 'react';
import { ChevronDown, Loader2, SlidersHorizontal } from 'lucide-react';
import * as i18n from '@/i18n';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Button } from '@/components/ui/Button';
import { NativeModelControls } from './NativeModelControls';
import { AgentProviderLogo } from './AgentProviderLogo';
import { ResponseLanguageSelect } from './ResponseLanguageSelect';
import { useAppStore } from '@/store/useAppStore';
import { useAssistantStore } from '@/store/useAssistantStore';
import { ipc } from '@/lib/ipc';
import { isLocalAgent } from '@/lib/ai/localAgents';
import { agentSelectionPatch, DEFAULT_AGENT_OPTIONS } from '@/lib/ai/agentModelOptions';
import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import type { AiSettings } from '@/types';
import { useAssistantNavigation } from './navigation';

export function ComposerPreferences({
  disabled,
  visible,
  onSavingChange,
}: {
  disabled: boolean;
  visible: boolean;
  onSavingChange: (saving: boolean) => void;
}) {
  const locale = i18n.useLocale();
  const revealWorkbench = useAssistantNavigation();
  const ai = useAppStore((state) => state.settings?.ai);
  const activeSessionId = useAssistantStore((state) => state.activeSessionId);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const panelId = useId();
  if (!ai) return null;
  const provider = ai.providers.find((item) => item.id === ai.active_provider);
  const model =
    provider?.model === 'default'
      ? i18n.t('Agent default')
      : provider?.model.split('/').at(-1) || i18n.t('Choose a model');
  const save = async (change: (current: AiSettings) => Partial<AiSettings>) => {
    if (disabled || locked.current) return;
    locked.current = true;
    setSaving(true);
    onSavingChange(true);
    setError(null);
    try {
      const latest = await ipc.settingsGet();
      const patch = change(latest.ai);
      const nextAi = { ...latest.ai, ...patch };
      if (JSON.stringify(nextAi) === JSON.stringify(latest.ai)) return;
      const saved = await ipc.settingsSet({ ...latest, ai: nextAi });
      useAppStore.getState().setSettings(saved);
      // Conversations freeze their provider, model and response language.
      // Keep the user's unsent text and selected context while starting afresh.
      const state = useAssistantStore.getState();
      const compose = {
        draft: state.draft,
        composerIntent: state.composerIntent,
        composerSections: state.composerSections,
        composerScope: state.composerScope,
        composerOrigin: state.composerOrigin,
      };
      state.newChat();
      useAssistantStore.setState(compose);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      locked.current = false;
      setSaving(false);
      onSavingChange(false);
    }
  };
  return (
    <div className="mb-2">
      {expanded && (
        <div
          id={panelId}
          role="group"
          aria-label={i18n.t('Assistant preferences')}
          className="border-border/50 bg-surface-raised/60 mb-2 max-h-60 space-y-3 overflow-y-auto overscroll-contain rounded-xl border p-3"
        >
          <SearchableSelect
            label={i18n.t('Assistant provider')}
            value={ai.active_provider ?? ''}
            leading={
              provider && <AgentProviderLogo kind={provider.kind} baseUrl={provider.base_url} />
            }
            renderOptionLeading={(option) => {
              const item = ai.providers.find((entry) => entry.id === option.value);
              return item && <AgentProviderLogo kind={item.kind} baseUrl={item.base_url} />;
            }}
            options={ai.providers.map((item) => ({
              value: item.id,
              label: item.name,
              description: isLocalAgent(item.kind) ? i18n.t('Local agent') : item.model,
            }))}
            compact
            className="w-full font-medium"
            disabled={disabled || saving}
            onChange={(id) => {
              if (id !== ai.active_provider) void save(() => ({ active_provider: id }));
            }}
          />
          {provider && isLocalAgent(provider.kind) ? (
            <NativeModelControls
              provider={provider}
              options={ai.agent_options?.[provider.id] ?? DEFAULT_AGENT_OPTIONS}
              enabled={visible && expanded && !ai.local_only}
              disabled={disabled || saving}
              compact
              onChange={(model, options) => {
                const currentOptions = ai.agent_options?.[provider.id] ?? DEFAULT_AGENT_OPTIONS;
                if (
                  model === provider.model &&
                  JSON.stringify(options) === JSON.stringify(currentOptions)
                )
                  return;
                void save((current) => agentSelectionPatch(current, provider, model, options));
              }}
            />
          ) : (
            provider && (
              <div className="text-fg-dim flex items-center justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate">
                  {provider.model || i18n.t('Choose a model')}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    useAppStore.getState().openSettings('assistant');
                    revealWorkbench();
                  }}
                >
                  {i18n.t('Configure model')}
                </Button>
              </div>
            )
          )}
          <ResponseLanguageSelect
            value={ai.response_language ?? null}
            disabled={disabled || saving}
            compact
            onChange={(response_language) => {
              if (response_language !== (ai.response_language ?? null))
                void save(() => ({ response_language }));
            }}
          />
          {activeSessionId && (
            <p className="text-fg-dim text-[11px] leading-relaxed">
              {i18n.t(
                'Changing the provider, model, reasoning or response language starts a new chat. Your draft is kept.',
              )}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        aria-label={i18n.t('Assistant preferences')}
        title={i18n.t('Assistant preferences')}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={() => setExpanded((current) => !current)}
        className="text-fg-dim hover:bg-fg/5 hover:text-fg focus-visible:ring-fg/25 flex h-7 max-w-full min-w-0 items-center gap-2 rounded-lg px-2 text-[11px] outline-none focus-visible:ring-2"
      >
        {provider ? (
          <AgentProviderLogo
            kind={provider.kind}
            baseUrl={provider.base_url}
            className="h-3.5 w-3.5"
          />
        ) : (
          <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 truncate" title={provider?.model}>
          {model}
        </span>
        <span aria-hidden="true" className="text-fg-dim/50">
          ·
        </span>
        <span
          className="shrink-0 text-[11px] tracking-wide uppercase"
          title={ai.response_language ? i18n.t('Response language') : i18n.t('Follow app language')}
        >
          {ai.response_language ?? locale}
        </span>
        {saving ? (
          <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <ChevronDown
            aria-hidden="true"
            className={`h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      {saving && (
        <p role="status" className="text-fg-dim text-[11px]">
          {i18n.t('Saving assistant preferences…')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-status-error text-[11px]">
          {assistantErrorMessage(error)}
        </p>
      )}
    </div>
  );
}
