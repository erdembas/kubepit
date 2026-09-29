import type { AiProviderConfig, AiSettings } from '@/types';

/**
 * `Settings.ai` defaults, identical to `AiSettings::default()` in
 * `kubepit-core/src/ai/settings.rs` (spec §7.1): the assistant is off, the
 * active provider is Anthropic with `claude-opus-5`, tool results wait for
 * consent. The demo backend and tests start from these.
 */
export const DEFAULT_AI_PROVIDERS: readonly AiProviderConfig[] = [
  {
    id: 'anthropic',
    kind: 'anthropic',
    name: 'Anthropic',
    base_url: 'https://api.anthropic.com',
    model: 'claude-opus-5',
    context_window: null,
    max_output_tokens: 64000,
  },
  {
    id: 'openai',
    kind: 'openai-compatible',
    name: 'OpenAI-compatible',
    base_url: 'https://api.openai.com/v1',
    model: '',
    context_window: null,
    max_output_tokens: 4096,
  },
  {
    id: 'ollama',
    kind: 'ollama',
    name: 'Ollama',
    base_url: 'http://127.0.0.1:11434',
    model: '',
    context_window: 8192,
    max_output_tokens: 4096,
  },
];

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  local_only: false,
  active_provider: 'anthropic',
  providers: DEFAULT_AI_PROVIDERS.map((p) => ({ ...p })),
  clusters: [],
  production_acknowledged: [],
  redaction: { tokens: true, ips: false, hostnames: false },
  tool_policy: 'ask',
  log_requests: true,
  max_context_tokens: 60000,
  effort: null,
  prices: [],
};
