import * as i18n from '@/i18n/core';
import type {
  AiAgentCatalog,
  AiAgentModel,
  AiAgentOptions,
  AiProviderConfig,
  AiSettings,
} from '@/types';
import type { SearchableOption } from '@/lib/selectSearch';

export const DEFAULT_AGENT_OPTIONS: Readonly<AiAgentOptions> = {
  effort: null,
  service_tier: null,
  fast_mode: false,
};

export function selectedAgentModel(
  catalog: AiAgentCatalog | null,
  id: string,
): AiAgentModel | undefined {
  if (!catalog) return undefined;
  const selected = !id || id === 'default' ? catalog.default_model : id;
  return (
    catalog.models.find((model) => model.id === selected) ??
    catalog.models.find((model) => selected != null && model.resolved_model === selected) ??
    (!id || id === 'default' ? catalog.models.find((model) => model.is_default) : undefined)
  );
}

export function agentModelOptions(
  catalog: AiAgentCatalog | null,
  current: string,
): SearchableOption[] {
  const options: SearchableOption[] = [
    {
      value: 'default',
      label: i18n.t('Agent default'),
      description: catalog?.default_model ?? i18n.t('Let the agent choose its model'),
    },
  ];
  const seen = new Set(['default']);
  const groups = new Map<string, SearchableOption[]>();
  for (const model of catalog?.models ?? []) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const slash = model.id.indexOf('/');
    const separator = model.name.indexOf(' · ');
    const groupId = slash > 0 ? model.id.slice(0, slash) : '';
    const group = groupId && separator > 0 ? model.name.slice(0, separator) : groupId;
    const entries = groups.get(groupId) ?? [];
    entries.push({
      value: model.id,
      label: groupId && separator > 0 ? model.name.slice(separator + 3) : model.name || model.id,
      description: [model.resolved_model || model.id, model.description]
        .filter(Boolean)
        .join(' · '),
      badge: model.is_alias ? i18n.t('Alias') : model.is_default ? i18n.t('Default') : undefined,
      keywords: `${model.id} ${model.name} ${model.resolved_model ?? ''}`,
      ...(groupId ? { group, groupId } : {}),
    });
    groups.set(groupId, entries);
  }
  for (const entries of groups.values()) options.push(...entries);
  for (const model of catalog?.models ?? []) {
    const id = model.resolved_model;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      value: id,
      label: id,
      description: model.name,
      badge: i18n.t('Pinned version'),
      group: i18n.t('Exact versions'),
      groupId: 'resolved-versions',
    });
  }
  if (current && !seen.has(current))
    options.splice(1, 0, {
      value: current,
      label: current,
      description: i18n.t('Current model · not listed by the agent'),
      badge: i18n.t('Custom ID'),
    });
  return options;
}

/** Mirrors native session pinning, including context modifiers such as `[1m]`. */
export function agentSessionModel(model: AiAgentModel | undefined, requested: string): string {
  if (!model) return requested;
  if (model.resolved_model === requested) return requested;
  const modifier = model.id.match(/\[.*\]$/)?.[0];
  if (modifier && !model.resolved_model?.endsWith(modifier)) return model.id;
  return model.resolved_model || model.id;
}

export function customAgentModel(value: string): SearchableOption | null {
  const id = value.trim();
  return id && !/\s/.test(id)
    ? {
        value: id,
        label: i18n.t('Use {id}', { id }),
        description: i18n.t('Use this exact model ID; availability is checked by the agent'),
        badge: i18n.t('Custom ID'),
      }
    : null;
}

/** A model change keeps only choices that its native capabilities actually advertise. */
export function optionsForAgentModel(
  options: AiAgentOptions,
  model: AiAgentModel | undefined,
): AiAgentOptions {
  return {
    effort: options.effort && model?.efforts.includes(options.effort) ? options.effort : null,
    service_tier:
      options.service_tier && model?.service_tiers.includes(options.service_tier)
        ? options.service_tier
        : null,
    fast_mode: options.fast_mode && !!model?.supports_fast_mode,
  };
}

export function agentSelectionPatch(
  ai: AiSettings,
  provider: AiProviderConfig,
  model: string,
  options: AiAgentOptions,
): Partial<AiSettings> {
  return {
    providers: ai.providers.map((item) => (item.id === provider.id ? { ...item, model } : item)),
    agent_options: { ...(ai.agent_options ?? {}), [provider.id]: options },
  };
}

export function effortLabel(value: string): string {
  switch (value) {
    case 'none':
      return i18n.t('None');
    case 'minimal':
      return i18n.t('Minimal');
    case 'low':
      return i18n.t('Low');
    case 'medium':
      return i18n.t('Medium');
    case 'high':
      return i18n.t('High');
    case 'xhigh':
      return i18n.t('Extra high');
    case 'max':
      return i18n.t('Maximum');
    case 'ultra':
      return i18n.t('Ultra');
    default:
      return value;
  }
}

export function serviceTierLabel(value: string): string {
  switch (value) {
    case 'fast':
      return i18n.t('Fast');
    case 'priority':
      return i18n.t('Priority');
    case 'flex':
      return i18n.t('Flexible');
    case 'default':
    case 'standard':
      return i18n.t('Standard');
    default:
      return value;
  }
}
