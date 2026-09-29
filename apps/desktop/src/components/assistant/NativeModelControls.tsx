import * as i18n from '@/i18n';
import { Check, Loader2, RefreshCw, Zap } from 'lucide-react';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Switch } from '@/components/ui/Switch';
import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import { useAgentCatalog } from '@/lib/ai/useAgentCatalog';
import {
  agentModelOptions,
  customAgentModel,
  optionsForAgentModel,
  selectedAgentModel,
  serviceTierLabel,
} from '@/lib/ai/agentModelOptions';
import type { AiAgentOptions, AiProviderConfig } from '@/types';
import { AgentProviderLogo } from './AgentProviderLogo';
import { AgentEffortPicker } from './AgentEffortPicker';

interface Props {
  provider: AiProviderConfig;
  options: AiAgentOptions;
  enabled: boolean;
  disabled?: boolean;
  compact?: boolean;
  onChange: (model: string, options: AiAgentOptions) => void;
}

export function NativeModelControls({
  provider,
  options,
  enabled,
  disabled,
  compact = false,
  onChange,
}: Props) {
  i18n.useLocale();
  const { catalog, loading, error, stale, refresh } = useAgentCatalog(provider.kind, enabled);
  const model = selectedAgentModel(catalog, provider.model);
  const effortSupported = !options.effort || !!model?.efforts.includes(options.effort);
  const tierSupported =
    !options.service_tier || !!model?.service_tiers.includes(options.service_tier);
  const controlLabel = 'text-fg-dim mb-1 block text-[10px] font-medium tracking-wider uppercase';
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <span className={controlLabel}>{i18n.t('Model')}</span>
          <SearchableSelect
            label={i18n.t('Model for {name}', { name: provider.name })}
            value={provider.model || 'default'}
            options={agentModelOptions(catalog, provider.model)}
            onChange={(id) =>
              onChange(id, optionsForAgentModel(options, selectedAgentModel(catalog, id)))
            }
            disabled={disabled}
            compact={compact}
            className="w-full"
            leading={
              <AgentProviderLogo
                kind={provider.kind}
                baseUrl={provider.base_url}
                className="h-3.5 w-3.5"
              />
            }
            menuWidth={420}
            searchPlaceholder={i18n.t('Search models or providers…')}
            createOption={customAgentModel}
            hint={i18n.t(
              'Models and capabilities come from your agent. Paste an exact model ID to pin a version.',
            )}
          />
        </div>
        <button
          type="button"
          aria-label={i18n.t('Refresh models')}
          title={loading ? i18n.t('Loading models…') : i18n.t('Refresh models')}
          disabled={disabled || !enabled || loading}
          onClick={refresh}
          className={`text-fg-dim hover:bg-fg/5 hover:text-fg focus-visible:ring-fg/25 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 disabled:opacity-40 ${compact ? '' : 'mb-1'}`}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {(!!model?.efforts.length || !!options.effort) && (
          <div className="min-w-28 flex-1">
            <span className={controlLabel}>
              {provider.kind === 'opencode-cli'
                ? i18n.t('Model variant')
                : i18n.t('Reasoning effort')}
            </span>
            <AgentEffortPicker
              efforts={model?.efforts ?? []}
              value={options.effort}
              defaultEffort={model?.default_effort ?? null}
              variant={provider.kind === 'opencode-cli'}
              compact={compact}
              label={
                provider.kind === 'opencode-cli'
                  ? i18n.t('Model variant for {name}', { name: provider.name })
                  : i18n.t('Reasoning effort for {name}', { name: provider.name })
              }
              disabled={disabled}
              onChange={(effort) => onChange(provider.model, { ...options, effort })}
            />
          </div>
        )}
        {(!!model?.service_tiers.length || !!options.service_tier) && (
          <div className="min-w-28 flex-1">
            <span className={controlLabel}>{i18n.t('Service tier')}</span>
            <SearchableSelect
              value={options.service_tier ?? ''}
              label={i18n.t('Service tier for {name}', { name: provider.name })}
              disabled={disabled}
              searchable={false}
              compact={compact}
              menuWidth={240}
              className="w-full"
              leading={<Zap aria-hidden="true" className="h-3 w-3" />}
              onChange={(service_tier) =>
                onChange(provider.model, { ...options, service_tier: service_tier || null })
              }
              options={[
                {
                  value: '',
                  label: model?.default_service_tier
                    ? i18n.t('Default ({value})', {
                        value: serviceTierLabel(model.default_service_tier),
                      })
                    : i18n.t('Agent default'),
                },
                ...(model?.service_tiers ?? []).map((value) => ({
                  value,
                  label: serviceTierLabel(value),
                })),
                ...(!tierSupported && options.service_tier
                  ? [{ value: options.service_tier, label: options.service_tier, disabled: true }]
                  : []),
              ]}
            />
          </div>
        )}
      </div>
      {(model?.supports_fast_mode || options.fast_mode) && (
        <Switch
          checked={options.fast_mode}
          onChange={(fast_mode) => onChange(provider.model, { ...options, fast_mode })}
          label={i18n.t('Fast mode')}
          description={i18n.t(
            'Use the agent’s faster response mode. Provider usage charges may differ.',
          )}
          disabled={disabled}
        />
      )}
      {catalog &&
        (!effortSupported ||
          !tierSupported ||
          (options.fast_mode && !model?.supports_fast_mode)) && (
          <p className="text-status-starting text-[11px]">
            {i18n.t(
              'A saved option is not advertised for this model. Choose an available value or restore the agent default.',
            )}
          </p>
        )}
      {!compact && catalog && model && !model.efforts.length && !options.effort && (
        <p className="text-fg-dim text-[11px]">
          {provider.kind === 'opencode-cli'
            ? i18n.t('This model does not advertise any variants.')
            : i18n.t('This model does not advertise a reasoning effort control.')}
        </p>
      )}
      {loading && !catalog && (
        <p role="status" className="text-fg-dim text-[11px]">
          {i18n.t('Loading models…')}
        </p>
      )}
      {catalog && (
        <div className="text-fg-dim flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <span className="inline-flex items-center gap-1">
            {catalog.authenticated === true && <Check aria-hidden="true" className="h-3 w-3" />}
            {catalog.authenticated === true
              ? i18n.t('Signed in')
              : catalog.authenticated === false
                ? i18n.t('Sign in through the agent CLI')
                : i18n.t('Account status not reported')}
          </span>
          {!compact && catalog.auth_method && (
            <span>{i18n.t('Sign-in method: {method}', { method: catalog.auth_method })}</span>
          )}
          {!compact && catalog.version && (
            <span>{i18n.t('CLI version: {version}', { version: catalog.version })}</span>
          )}
        </div>
      )}
      {stale && (
        <p className="text-status-starting text-[11px]">
          {loading
            ? i18n.t('Showing cached models while the catalog is refreshed.')
            : i18n.t('Cached models may be out of date. Refresh to try again.')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-status-error text-[11px]">
          {assistantErrorMessage(error)}
        </p>
      )}
      {catalog && !catalog.models.length && (
        <p className="text-fg-dim text-[11px]">
          {i18n.t(
            'The agent did not report any models. Refresh after signing in, or enter an exact model ID.',
          )}
        </p>
      )}
      {!compact && catalog && model && (model.context_window || model.max_output_tokens) && (
        <p className="text-fg-dim text-[11px]">
          {i18n.t('Model limits: {context} context tokens · {output} output tokens', {
            context: model.context_window
              ? i18n.number(model.context_window)
              : i18n.t('Not reported'),
            output: model.max_output_tokens
              ? i18n.number(model.max_output_tokens)
              : i18n.t('Not reported'),
          })}
        </p>
      )}
    </div>
  );
}
