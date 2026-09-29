import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import { AgentProviderLogo } from '@/components/assistant/AgentProviderLogo';
import { localAgentSource, selectLocalAgent } from '@/lib/ai/localAgents';
import type { AiLocalAgent, AiSettings } from '@/types';
import { SettingsSection } from '../SettingsView';

interface Props {
  ai: AiSettings;
  agents: AiLocalAgent[];
  loading: boolean;
  error: string | null;
  onChange: (patch: Partial<AiSettings>) => void;
  refresh: () => void;
}

export function LocalAgentsSection({ ai, agents, loading, error, onChange, refresh }: Props) {
  i18n.useLocale();
  return (
    <SettingsSection title={i18n.t('Local agents')}>
      <div className="mb-3 flex items-start gap-3">
        <p className="text-fg-muted flex-1 text-[12px]">
          {i18n.t(
            'Use an installed agent with its existing CLI login. Sign in through its command-line tool before sending a request; Kubepit does not need its API key.',
          )}
        </p>
        <Button size="xs" variant="secondary" disabled={loading} onClick={refresh}>
          {loading ? i18n.t('Detecting…') : i18n.t('Refresh')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-status-error mb-3 text-[11px]">
          {error}
        </p>
      )}
      <div className="space-y-2">
        {agents.map((agent) => {
          const selected = ai.providers.some(
            (provider) => provider.kind === agent.kind && provider.id === ai.active_provider,
          );
          return (
            <div
              key={agent.kind}
              className={`border-border/70 relative flex items-start gap-3 rounded-lg border p-3 ${selected ? 'bg-fg/5' : ''}`}
            >
              {selected && <span className="bg-accent absolute inset-y-2 left-0 w-0.5 rounded-r" />}
              <div className="bg-fg/4 text-fg mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                <AgentProviderLogo kind={agent.kind} className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-fg font-medium">{agent.name}</span>
                  <span
                    className={`inline-flex items-center gap-1.5 text-[10px] ${agent.available ? 'text-status-running' : 'text-fg-dim'}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-1 w-1 rounded-full ${agent.available ? 'bg-status-running' : 'bg-fg/25'}`}
                    />
                    {agent.available ? i18n.t('Detected') : i18n.t('Not found')}
                  </span>
                </div>
                {agent.executable && (
                  <p
                    className="text-fg-dim mt-1 truncate font-mono text-[10px]"
                    title={agent.executable}
                  >
                    {agent.executable}
                  </p>
                )}
                {agent.source && (
                  <p className="text-fg-dim mt-1 text-[11px]">
                    {i18n.t('Source: {source}', { source: localAgentSource(agent.source) })}
                  </p>
                )}
                {!agent.supported && (
                  <p className="text-status-starting mt-1 text-[11px]">
                    {i18n.t('This agent cannot run with Assistant permissions yet.')}
                  </p>
                )}
              </div>
              <Button
                size="xs"
                variant="secondary"
                disabled={!agent.available || !agent.supported || selected || loading}
                aria-label={i18n.t('Use {name}', { name: agent.name })}
                className="mt-1"
                onClick={() => onChange(selectLocalAgent(ai, agent))}
              >
                {selected ? i18n.t('Selected') : i18n.t('Use')}
              </Button>
            </div>
          );
        })}
      </div>
      <p className="text-fg-dim mt-3 text-[11px]">
        {i18n.t(
          'Local agents may send context to cloud models and are unavailable in local-only mode. They answer using the context you preview; their shell, file and cluster tools are disabled.',
        )}
      </p>
    </SettingsSection>
  );
}
