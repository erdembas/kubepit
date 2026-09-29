import { afterEach, describe, expect, it } from 'vitest';
import * as i18n from '@/i18n/core';
import { DEMO_AGENT_CATALOGS } from '@/lib/ipc/mock/fixtures/agentCatalogs';
import { DEFAULT_AI_SETTINGS } from './defaults';
import { selectLocalAgent } from './localAgents';
import { filterSelectOptions } from '@/lib/selectSearch';
import {
  agentModelOptions,
  agentSessionModel,
  agentSelectionPatch,
  customAgentModel,
  DEFAULT_AGENT_OPTIONS,
  effortLabel,
  optionsForAgentModel,
  selectedAgentModel,
} from './agentModelOptions';

afterEach(() => i18n.setLocale('en', false));
const claude = DEMO_AGENT_CATALOGS['claude-cli']!;
const codex = DEMO_AGENT_CATALOGS['codex-cli']!;

describe('native model choices', () => {
  it('keeps context modifiers while pinning a native alias for a conversation', () => {
    const model = { ...claude.models[0]!, id: 'opus[1m]', resolved_model: 'claude-opus-5' };
    expect(agentSessionModel(model, 'default')).toBe('opus[1m]');
    expect(agentSessionModel(model, 'opus[1m]')).toBe('opus[1m]');
    expect(agentSessionModel(model, 'claude-opus-5')).toBe('claude-opus-5');
    expect(agentSessionModel({ ...model, resolved_model: 'claude-opus-5[1m]' }, 'default')).toBe(
      'claude-opus-5[1m]',
    );
  });
  it('resolves aliases and their native exact versions to the same capabilities', () => {
    expect(selectedAgentModel(claude, 'default')?.id).toBe('sonnet');
    expect(selectedAgentModel(claude, 'claude-opus-5')).toBe(selectedAgentModel(claude, 'opus'));
    expect(selectedAgentModel(claude, 'future-model')).toBeUndefined();
    expect(selectedAgentModel(DEMO_AGENT_CATALOGS['opencode-cli']!, 'default')).toBeUndefined();
  });

  it('preserves native model names and ids while translating owned labels', () => {
    i18n.setLocale('tr', false);
    const options = agentModelOptions(claude, 'custom/version');
    expect(options.find((option) => option.value === 'opus')).toMatchObject({
      label: 'Opus',
      description: 'claude-opus-5',
    });
    expect(options.find((option) => option.value === 'claude-opus-5')).toMatchObject({
      label: 'claude-opus-5',
    });
    expect(options.find((option) => option.value === 'custom/version')?.label).toBe(
      'custom/version',
    );
    expect(options[0]!.label).not.toBe('Agent default');
    expect(effortLabel('native-experimental')).toBe('native-experimental');
    expect(customAgentModel(' exact/model ')?.value).toBe('exact/model');
    expect(customAgentModel('not an id')).toBeNull();
    expect(customAgentModel('')).toBeNull();
  });

  it('uses the native provider prefix to group OpenCode models', () => {
    const options = agentModelOptions(DEMO_AGENT_CATALOGS['opencode-cli']!, 'default');
    expect(options.find((option) => option.value === 'openai/gpt-6-sol')).toMatchObject({
      label: 'GPT-6 Sol',
      group: 'OpenAI',
      groupId: 'openai',
    });
  });

  it('finds custom provider models by native provider name and id without repeating the provider in each model label', () => {
    const options = agentModelOptions(DEMO_AGENT_CATALOGS['opencode-cli']!, 'default');
    for (const query of ['hwc', 'Huawei Cloud', 'hwc-maas/glm']) {
      expect(filterSelectOptions(options, query).map((option) => option.value)).toContain(
        'hwc-maas/glm-5.1',
      );
    }
    expect(options.find((option) => option.value === 'hwc-maas/glm-5.1')).toMatchObject({
      label: 'GLM 5.1',
      group: 'Huawei Cloud - MaaS',
      groupId: 'hwc-maas',
    });
    expect(options.filter((option) => option.groupId === 'hwc-maas')).toHaveLength(2);
  });

  it('keeps provider groups contiguous when the native catalog interleaves entries', () => {
    const models = DEMO_AGENT_CATALOGS['opencode-cli']!.models;
    const first = models.find((model) => model.id === 'hwc-maas/glm-5.1')!;
    const second = models.find((model) => model.id === 'hwc-maas/glm-5.2')!;
    const catalog = {
      ...DEMO_AGENT_CATALOGS['opencode-cli']!,
      models: [first, models[0]!, second],
    };
    expect(
      agentModelOptions(catalog, 'default')
        .slice(1)
        .map((option) => option.groupId),
    ).toEqual(['hwc-maas', 'hwc-maas', 'anthropic']);
  });

  it('retains supported preferences and clears incompatible ones on model change', () => {
    const preferences = { effort: 'high', service_tier: 'priority', fast_mode: true };
    expect(optionsForAgentModel(preferences, selectedAgentModel(codex, 'gpt-6-sol'))).toEqual({
      effort: 'high',
      service_tier: 'priority',
      fast_mode: false,
    });
    expect(optionsForAgentModel(preferences, selectedAgentModel(codex, 'gpt-6-luna'))).toEqual(
      DEFAULT_AGENT_OPTIONS,
    );
    expect(optionsForAgentModel(preferences, selectedAgentModel(claude, 'opus'))).toEqual({
      effort: 'high',
      service_tier: null,
      fast_mode: true,
    });
    expect(optionsForAgentModel(preferences, undefined)).toEqual(DEFAULT_AGENT_OPTIONS);
  });

  it('updates only the provider model and its preferences without changing consent', () => {
    const original = structuredClone(DEFAULT_AI_SETTINGS);
    const ai = {
      ...original,
      ...selectLocalAgent(original, {
        kind: 'codex-cli',
        name: 'Codex',
        executable: '/fixture/codex',
        source: 'path',
        supported: true,
        available: true,
      }),
    };
    ai.agent_options = { another: { effort: 'low', service_tier: null, fast_mode: false } };
    const provider = ai.providers.at(-1)!;
    const patch = agentSelectionPatch(ai, provider, 'gpt-6-sol', {
      effort: 'ultra',
      service_tier: 'priority',
      fast_mode: false,
    });
    expect(Object.keys(patch).sort()).toEqual(['agent_options', 'providers']);
    expect(patch.agent_options?.another).toEqual(ai.agent_options.another);
    expect(patch.providers?.at(-1)).toEqual({ ...provider, model: 'gpt-6-sol' });
    expect(provider.model).toBe('default');
    expect(ai.enabled).toBe(false);
    expect(ai.clusters).toEqual([]);
  });
});
