import type { AiProviderConfig, AiSettings, AiStatus, ClusterDef } from '@/types';
import { isLocalAgent } from './localAgents';

/**
 * Whether the assistant panel can take a request, and if not, what the
 * user has to do first (spec §6 "Not ready states"). Mirrors the backend's
 * refusals so the panel explains them before anything is previewed:
 * the master switch, the active provider (allowed by local-only mode and
 * egress, a usable key where one is needed, a model), and the cluster's
 * enablement — production clusters only count with the typed
 * acknowledgement. While the status is loading nothing is blocked on it
 * (the backend still refuses).
 */
export type AiReadiness =
  | { state: 'ready' }
  | { state: 'off' }
  | { state: 'no-provider' }
  | { state: 'blocked'; provider: AiProviderConfig }
  | { state: 'no-key'; provider: AiProviderConfig; keyError: string | null }
  | { state: 'no-model'; provider: AiProviderConfig }
  | { state: 'cluster'; cluster: ClusterDef; reacknowledge: boolean };

export function assistantReadiness(
  ai: AiSettings | null | undefined,
  status: AiStatus | null,
  cluster: ClusterDef | null,
): AiReadiness {
  if (!ai?.enabled) return { state: 'off' };
  const provider = ai.providers.find((p) => p.id === ai.active_provider);
  if (!provider) return { state: 'no-provider' };
  const s = status?.providers.find((p) => p.id === provider.id);
  if (s) {
    if (!s.allowed) return { state: 'blocked', provider };
    // Anthropic always needs a key, OpenAI-compatible servers unless local, Ollama never.
    const needsKey =
      provider.kind === 'anthropic' || (provider.kind === 'openai-compatible' && !s.local);
    if (!isLocalAgent(provider.kind) && !s.has_key && (needsKey || s.key_error))
      return { state: 'no-key', provider, keyError: s.key_error };
  }
  if (!isLocalAgent(provider.kind) && !provider.model.trim())
    return { state: 'no-model', provider };
  if (cluster) {
    if (!ai.clusters.includes(cluster.id))
      return { state: 'cluster', cluster, reacknowledge: false };
    if (
      cluster.environment === 'production' &&
      !(ai.production_acknowledged ?? []).includes(cluster.id)
    )
      return { state: 'cluster', cluster, reacknowledge: true };
  }
  return { state: 'ready' };
}
