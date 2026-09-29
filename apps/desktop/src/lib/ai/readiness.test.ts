import { describe, expect, it } from 'vitest';
import type { AiSettings, AiStatus, ClusterDef } from '@/types';
import { DEFAULT_AI_SETTINGS } from './defaults';
import { assistantReadiness } from './readiness';

// Enabled defaults (Anthropic active) with overrides.
const ai = (patch: Partial<AiSettings> = {}): AiSettings => ({
  ...structuredClone(DEFAULT_AI_SETTINGS),
  enabled: true,
  ...patch,
});
// A status where every provider is allowed; `keys` lists providers with a key.
const status = (keys: string[] = ['anthropic'], patch: Partial<AiStatus> = {}): AiStatus => ({
  enabled: true,
  local_only: false,
  remote_allowed: true,
  keychain: 'Test store',
  providers: DEFAULT_AI_SETTINGS.providers.map((p) => ({
    id: p.id,
    kind: p.kind,
    local: p.kind === 'ollama',
    has_key: keys.includes(p.id),
    key_error: null,
    allowed: true,
  })),
  ...patch,
});
const cluster = (id: string, environment: string | null = null) =>
  ({ id, name: `${id}-name`, environment }) as ClusterDef;

describe('assistantReadiness', () => {
  it('is off without settings or with the master switch off', () => {
    expect(assistantReadiness(null, status(), null).state).toBe('off');
    expect(assistantReadiness(ai({ enabled: false }), status(), null).state).toBe('off');
  });

  it('needs an active provider', () => {
    expect(assistantReadiness(ai({ active_provider: null }), status(), null).state).toBe(
      'no-provider',
    );
    expect(assistantReadiness(ai({ active_provider: 'gone' }), status(), null).state).toBe(
      'no-provider',
    );
  });

  it('reports a provider the backend would refuse', () => {
    const s = status();
    s.providers[0]!.allowed = false;
    expect(assistantReadiness(ai(), s, null)).toMatchObject({
      state: 'blocked',
      provider: { id: 'anthropic' },
    });
  });

  it('needs a key for remote providers and shows why it is missing', () => {
    expect(assistantReadiness(ai(), status([]), null)).toMatchObject({
      state: 'no-key',
      keyError: null,
    });
    const mismatch = status([]);
    mismatch.providers[0]!.key_error = 'The key was saved for another origin.';
    expect(assistantReadiness(ai(), mismatch, null)).toMatchObject({
      state: 'no-key',
      keyError: 'The key was saved for another origin.',
    });
  });

  it('needs no key for Ollama or a local OpenAI-compatible server', () => {
    const ollama = ai({ active_provider: 'ollama' });
    ollama.providers.find((p) => p.id === 'ollama')!.model = 'llama3.2';
    expect(assistantReadiness(ollama, status([]), null).state).toBe('ready');
    const local = ai({ active_provider: 'openai' });
    local.providers.find((p) => p.id === 'openai')!.model = 'qwen';
    const s = status([]);
    s.providers.find((p) => p.id === 'openai')!.local = true;
    expect(assistantReadiness(local, s, null).state).toBe('ready');
  });

  it('needs a model', () => {
    const openai = ai({ active_provider: 'openai' });
    expect(assistantReadiness(openai, status(['openai']), null)).toMatchObject({
      state: 'no-model',
      provider: { id: 'openai' },
    });
  });

  it('does not block on the status while it is loading', () => {
    expect(assistantReadiness(ai(), null, null).state).toBe('ready');
  });

  it('needs the cluster enabled, and production acknowledged', () => {
    expect(assistantReadiness(ai(), status(), cluster('c-dev'))).toMatchObject({
      state: 'cluster',
      cluster: { id: 'c-dev' },
      reacknowledge: false,
    });
    expect(assistantReadiness(ai({ clusters: ['c-dev'] }), status(), cluster('c-dev')).state).toBe(
      'ready',
    );
    const prod = cluster('c-prod', 'production');
    expect(assistantReadiness(ai({ clusters: ['c-prod'] }), status(), prod)).toMatchObject({
      state: 'cluster',
      reacknowledge: true,
    });
    expect(
      assistantReadiness(
        ai({ clusters: ['c-prod'], production_acknowledged: ['c-prod'] }),
        status(),
        prod,
      ).state,
    ).toBe('ready');
  });
});
