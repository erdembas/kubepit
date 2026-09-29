import type { AiLocalAgent, AiProviderKind, AiSettings } from '@/types';
import * as i18n from '@/i18n/core';

export function localAgentSource(source: string): string {
  switch (source) {
    case 'path':
      return 'PATH';
    case 'known-location':
      return i18n.t('Known installation folder');
    case 'explicit':
      return i18n.t('Explicit path');
    default:
      return source;
  }
}

/** A local executable is not necessarily a local model: all CLI agents may use the cloud. */
export function isLocalAgent(kind: AiProviderKind): boolean {
  return (
    kind === 'codex-cli' ||
    kind === 'claude-cli' ||
    kind === 'opencode-cli' ||
    kind === 'cursor-cli'
  );
}

/** Select in the draft only; preserve existing configuration and every consent setting. */
export function selectLocalAgent(
  ai: AiSettings,
  agent: AiLocalAgent,
): Pick<AiSettings, 'active_provider' | 'providers'> {
  if (!agent.available || !agent.supported || !isLocalAgent(agent.kind))
    return { active_provider: ai.active_provider, providers: ai.providers };
  const existing = ai.providers.find((provider) => provider.kind === agent.kind);
  if (existing) return { active_provider: existing.id, providers: ai.providers };
  const used = new Set(ai.providers.map((provider) => provider.id));
  let id: string = agent.kind;
  for (let n = 2; used.has(id); n++) id = `${agent.kind}-${n}`;
  return {
    active_provider: id,
    providers: [
      ...ai.providers,
      {
        id,
        kind: agent.kind,
        name: agent.name,
        base_url: '',
        model: 'default',
        context_window: null,
        max_output_tokens: 4096,
      },
    ],
  };
}
