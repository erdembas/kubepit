import { describe, expect, it } from 'vitest';
import type { AiLocalAgent } from '@/types';
import { DEFAULT_AI_SETTINGS } from './defaults';
import { selectLocalAgent } from './localAgents';

const codex: AiLocalAgent = {
  kind: 'codex-cli',
  name: 'Codex',
  executable: '/usr/local/bin/codex',
  source: 'PATH',
  available: true,
  supported: true,
};

describe('local agent selection', () => {
  it('adds a provider to the draft without enabling AI, clusters, or changing privacy', () => {
    const original = structuredClone(DEFAULT_AI_SETTINGS);
    const patch = selectLocalAgent(original, codex);
    expect(Object.keys(patch).sort()).toEqual(['active_provider', 'providers']);
    expect(patch.active_provider).toBe('codex-cli');
    expect(patch.providers.at(-1)).toMatchObject({
      kind: 'codex-cli',
      base_url: '',
      model: 'default',
    });
    expect(original).toEqual(DEFAULT_AI_SETTINGS);
    expect({ ...original, ...patch }).toMatchObject({
      enabled: false,
      clusters: [],
      local_only: original.local_only,
    });
  });

  it('selects existing configuration without resetting its model or creating duplicates', () => {
    const initial = structuredClone(DEFAULT_AI_SETTINGS);
    const first = { ...initial, ...selectLocalAgent(initial, codex) };
    first.providers.at(-1)!.model = 'custom-model';
    first.providers.at(-1)!.id = 'custom-codex';
    const again = selectLocalAgent(first, codex);
    expect(again.active_provider).toBe('custom-codex');
    expect(again.providers).toBe(first.providers);
    expect(again.providers.at(-1)!.model).toBe('custom-model');
  });

  it('refuses missing and unsupported agents while preserving saved configurations', () => {
    const initial = structuredClone(DEFAULT_AI_SETTINGS);
    const configured = { ...initial, ...selectLocalAgent(initial, codex) };
    for (const unavailable of [
      { ...codex, available: false },
      { ...codex, supported: false },
    ]) {
      expect(selectLocalAgent(initial, unavailable)).toEqual({
        active_provider: initial.active_provider,
        providers: initial.providers,
      });
      expect(selectLocalAgent(configured, unavailable).providers).toBe(configured.providers);
    }
  });
});
