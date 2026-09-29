import type { AiAgentCatalog, AiAgentModel, AiProviderKind } from '@/types';

/** Synthetic native metadata only; the browser never probes installed agents or accounts. */
const model = (id: string, name: string, patch: Partial<AiAgentModel> = {}): AiAgentModel => ({
  id,
  name,
  description: null,
  resolved_model: null,
  is_alias: false,
  is_default: false,
  context_window: 128_000,
  max_output_tokens: 16_384,
  efforts: [],
  default_effort: null,
  service_tiers: [],
  default_service_tier: null,
  supports_fast_mode: false,
  ...patch,
});

export const DEMO_AGENT_CATALOGS: Partial<Record<AiProviderKind, AiAgentCatalog>> = {
  'codex-cli': {
    kind: 'codex-cli',
    default_model: 'gpt-6-sol',
    authenticated: true,
    auth_method: 'chatgpt',
    version: '0.158.0-demo',
    models: [
      model('gpt-6-sol', 'GPT-6 Sol', {
        is_default: true,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        default_effort: 'medium',
        service_tiers: ['standard', 'priority'],
        default_service_tier: 'standard',
        context_window: 400_000,
      }),
      model('gpt-6-astra', 'GPT-6 Astra', {
        efforts: ['high', 'xhigh', 'max'],
        default_effort: 'high',
        service_tiers: ['standard', 'priority'],
        default_service_tier: 'standard',
        context_window: 1_000_000,
      }),
      model('gpt-6-luna', 'GPT-6 Luna', {
        efforts: ['minimal', 'low', 'medium'],
        default_effort: 'low',
      }),
    ],
  },
  'claude-cli': {
    kind: 'claude-cli',
    default_model: 'sonnet',
    authenticated: true,
    auth_method: 'subscription',
    version: '2.1-demo',
    models: [
      model('sonnet', 'Sonnet', {
        is_alias: true,
        is_default: true,
        resolved_model: 'claude-sonnet-5',
        efforts: ['low', 'medium', 'high'],
        default_effort: 'high',
        context_window: 1_000_000,
      }),
      model('opus', 'Opus', {
        is_alias: true,
        resolved_model: 'claude-opus-5',
        efforts: ['low', 'medium', 'high', 'max'],
        default_effort: 'high',
        supports_fast_mode: true,
        context_window: 1_000_000,
      }),
      model('haiku', 'Haiku', {
        is_alias: true,
        resolved_model: 'claude-haiku-4-5',
        context_window: 200_000,
      }),
    ],
  },
  'opencode-cli': {
    kind: 'opencode-cli',
    default_model: null,
    authenticated: null,
    auth_method: null,
    version: '1.2-demo',
    models: [
      model('anthropic/claude-sonnet-5', 'Anthropic · Claude Sonnet 5', {
        efforts: ['low', 'high'],
        context_window: 1_000_000,
      }),
      model('openai/gpt-6-sol', 'OpenAI · GPT-6 Sol', {
        efforts: ['minimal', 'medium', 'high'],
        default_effort: 'medium',
        context_window: 400_000,
      }),
      model('hwc-maas/glm-5.1', 'Huawei Cloud - MaaS · GLM 5.1', {
        efforts: ['thinking', 'standard'],
        context_window: 128_000,
      }),
      model('hwc-maas/glm-5.2', 'Huawei Cloud - MaaS · GLM 5.2', {
        context_window: 256_000,
      }),
      model('modelion/kimi-k2.5', 'Modelion · Kimi K2.5', {
        efforts: ['fast', 'reasoning'],
        context_window: 256_000,
      }),
      model('modelion-npu/glm-4.6', 'Modelion NPU · GLM 4.6', {
        context_window: 200_000,
      }),
      model('9router/gpt-6-sol', '9Router · GPT-6 Sol', {
        efforts: ['low', 'high'],
        context_window: 400_000,
      }),
    ],
  },
};
