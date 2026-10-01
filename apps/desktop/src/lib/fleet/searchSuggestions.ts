import { BUILTIN_KINDS, resolveKindName } from '@/lib/kube/catalog';
import type { ApiResourceInfo, ClusterEnvironment, Gvk } from '@/types';
import {
  ENV_ALIASES,
  SEARCH_KINDS,
  isRegexText,
  quoteSearchValue,
  scanSearchInput,
  validSearchLabelKey,
  validSearchLabelValue,
  type SearchField,
} from './searchQuery';

export interface SearchSuggestionContext {
  apiResources?: readonly ApiResourceInfo[] | null;
  kinds?: readonly (Gvk | string)[];
  clusters?: readonly { id: string; name: string; environment?: ClusterEnvironment | null }[];
  namespaces?: readonly string[];
  labelValues?: Readonly<Record<string, readonly string[]>>;
}

export type SearchSuggestionCategory =
  'field' | 'kind' | 'namespace' | 'cluster' | 'environment' | 'label-key' | 'label-value';

export interface SearchSuggestion {
  id: string;
  category: SearchSuggestionCategory;
  /** Identifiers/query syntax only; the UI translates category headings. */
  label: string;
  /** Complete replacement text for [start, end), not just the displayed suffix. */
  value: string;
  detail?: string;
  start: number;
  end: number;
}

const FIELDS: Array<{ field: SearchField; value: string; aliases: string[] }> = [
  { field: 'kind', value: 'kind:', aliases: ['kind', 'kinds', 'k'] },
  { field: 'namespace', value: 'ns:', aliases: ['ns', 'namespace', 'n'] },
  { field: 'cluster', value: 'cluster:', aliases: ['cluster', 'c'] },
  { field: 'environment', value: 'env:', aliases: ['environment', 'env', 'e'] },
  { field: 'label', value: 'label:', aliases: ['label', 'l'] },
];
const PREFIX: Record<SearchField, string> = {
  kind: 'kind:',
  namespace: 'ns:',
  cluster: 'cluster:',
  environment: 'env:',
  label: 'label:',
};
const ENVIRONMENTS: ClusterEnvironment[] = [
  'production',
  'staging',
  'development',
  'testing',
  'local',
];

function matchRank(candidate: string, query: string): number {
  const value = candidate.toLowerCase();
  const term = query.toLowerCase();
  if (value === term) return 0;
  if (value.startsWith(term)) return 1;
  return value.includes(term) ? 2 : 3;
}

interface KindCandidate {
  label: string;
  value: string;
  aliases: string[];
  group: string;
  plural: string;
}
function kinds(context: SearchSuggestionContext): KindCandidate[] {
  const values = new Map<string, KindCandidate>();
  const add = (kind: Gvk, aliases: string[] = []) => {
    const identity = `${kind.group}/${kind.plural}`;
    const existing = values.get(identity);
    const builtin = BUILTIN_KINDS.find(
      (known) => known.group === kind.group && known.plural === kind.plural,
    );
    values.set(identity, {
      label: kind.kind,
      // A CRD can reuse another kind name. Its qualified resource key resolves
      // unambiguously through the same parser used for actual fleet queries.
      value: builtin ? kind.kind : kind.group ? `${kind.plural}.${kind.group}` : kind.plural,
      aliases: [
        ...new Set([
          ...(existing?.aliases ?? []),
          kind.kind,
          kind.plural,
          ...(kind.group ? [`${kind.plural}.${kind.group}`] : []),
          ...(builtin?.shortNames ?? []),
          ...aliases,
        ]),
      ],
      group: kind.group,
      plural: kind.plural,
    });
  };
  const supplied = context.kinds;
  if (supplied?.length) {
    for (const entry of supplied) {
      const resolved =
        typeof entry === 'string' ? resolveKindName(entry, context.apiResources) : entry;
      if (resolved) add(resolved, typeof entry === 'string' ? [entry] : []);
    }
  } else {
    for (const builtin of BUILTIN_KINDS) add(builtin);
  }
  for (const resource of context.apiResources ?? [])
    add(
      {
        group: resource.group,
        version: resource.version,
        kind: resource.kind,
        plural: resource.plural,
        namespaced: resource.namespaced,
      },
      resource.short_names,
    );
  return [...values.values()];
}

/** Context is already collected by the caller. This function never fetches or watches. */
export function suggestSearchInput(
  input: string,
  caret: number,
  context: SearchSuggestionContext,
  limit = 12,
): SearchSuggestion[] {
  const position = Math.max(0, Math.min(input.length, caret));
  const tokens = scanSearchInput(input, context.apiResources);
  const active = tokens.find((token) => token.start <= position && position <= token.end);
  const start = active?.start ?? position;
  const end = active?.end ?? position;
  const prefix = input.slice(start, position);
  const token = scanSearchInput(prefix, context.apiResources)[0];
  const explicit = /^([a-z]+):/i.exec(prefix);
  const explicitField = explicit
    ? FIELDS.find((entry) => entry.aliases.includes(explicit[1]!.toLowerCase()))?.field
    : null;
  const ranked: Array<SearchSuggestion & { rank: number; priority: number }> = [];
  const seen = new Set<string>();
  const add = (
    category: SearchSuggestionCategory,
    label: string,
    value: string,
    rank: number,
    detail?: string,
    priority = Number.MAX_SAFE_INTEGER,
  ) => {
    if (rank > 2 || seen.has(value)) return;
    seen.add(value);
    ranked.push({
      id: `${category}:${value}`,
      category,
      label,
      value,
      start,
      end,
      rank,
      priority,
      ...(detail ? { detail } : {}),
    });
  };

  const fieldValues = token?.values ?? [''];
  const part = fieldValues.at(-1) ?? '';
  const previous = fieldValues.slice(0, -1);
  const withPrevious = (field: SearchField, value: string) =>
    `${PREFIX[field]}${[...previous, value].map(quoteSearchValue).join(',')}`;

  if (explicitField === 'kind') {
    const used = previous.map((value) => resolveKindName(value, context.apiResources));
    for (const candidate of kinds(context)) {
      if (used.some((kind) => kind?.group === candidate.group && kind.plural === candidate.plural))
        continue;
      const rank = Math.min(...candidate.aliases.map((alias) => matchRank(alias, part)));
      const commonIndex = SEARCH_KINDS.findIndex(
        ({ def }) => def.group === candidate.group && def.plural === candidate.plural,
      );
      add(
        'kind',
        candidate.label,
        withPrevious('kind', candidate.value),
        rank,
        candidate.group || undefined,
        !part && commonIndex >= 0 ? commonIndex : Number.MAX_SAFE_INTEGER,
      );
    }
  } else if (explicitField === 'namespace') {
    for (const namespace of new Set(context.namespaces ?? [])) {
      add('namespace', namespace, `ns:${quoteSearchValue(namespace)}`, matchRank(namespace, part));
    }
  } else if (explicitField === 'cluster') {
    for (const cluster of context.clusters ?? []) {
      if (previous.some((value) => value.toLowerCase() === cluster.name.toLowerCase())) continue;
      add(
        'cluster',
        cluster.name,
        withPrevious('cluster', cluster.name),
        matchRank(cluster.name, part),
        cluster.environment ?? undefined,
      );
    }
  } else if (explicitField === 'environment') {
    const used = previous.map((value) => ENV_ALIASES[value.toLowerCase()]);
    for (const environment of ENVIRONMENTS) {
      if (used.includes(environment)) continue;
      const aliases = Object.entries(ENV_ALIASES)
        .filter(([, value]) => value === environment)
        .map(([alias]) => alias);
      add(
        'environment',
        environment,
        withPrevious('environment', environment),
        Math.min(...aliases.map((alias) => matchRank(alias, part))),
      );
    }
  } else if (explicitField === 'label' || token?.type === 'label' || prefix.startsWith('!')) {
    const selector = explicitField === 'label' ? part : (token?.values[0] ?? prefix);
    const equality = /^([^=!,\s]+)(!=|==|=)(.*)$/.exec(selector);
    const prior = explicitField === 'label' && previous.length ? `${previous.join(',')},` : '';
    const field = explicitField === 'label' ? 'label:' : '';
    if (equality) {
      const key = equality[1]!;
      const operator = equality[2] === '!=' ? '!=' : '=';
      const valuePrefix = equality[3]!;
      const values = Object.hasOwn(context.labelValues ?? {}, key)
        ? (context.labelValues?.[key] ?? [])
        : [];
      for (const value of new Set(values)) {
        if (!validSearchLabelValue(value)) continue;
        add(
          'label-value',
          value || '""',
          `${field}${prior}${key}${operator}${quoteSearchValue(value)}`,
          matchRank(value, valuePrefix),
          key,
        );
      }
    } else {
      const absent = selector.startsWith('!');
      const keyPrefix = absent ? selector.slice(1) : selector;
      for (const key of Object.keys(context.labelValues ?? {})) {
        if (!validSearchLabelKey(key)) continue;
        add(
          'label-key',
          key,
          `${field}${prior}${absent ? '!' : ''}${key}`,
          matchRank(key, keyPrefix),
        );
      }
    }
  } else if (!explicit && !isRegexText(prefix) && !/[*/?\\]/.test(prefix)) {
    for (const [index, field] of FIELDS.entries()) {
      add(
        'field',
        field.value,
        field.value,
        Math.min(...field.aliases.map((alias) => matchRank(alias, prefix))),
        undefined,
        !prefix ? index : Number.MAX_SAFE_INTEGER,
      );
    }
    // An empty segment begins with syntax hints. Other categories appear as
    // soon as a user types, avoiding a long, arbitrary unfiltered inventory.
    if (prefix) {
      for (const candidate of kinds(context)) {
        add(
          'kind',
          candidate.label,
          `kind:${quoteSearchValue(candidate.value)}`,
          Math.min(...candidate.aliases.map((alias) => matchRank(alias, prefix))),
          candidate.group || undefined,
        );
      }
      for (const namespace of new Set(context.namespaces ?? []))
        add(
          'namespace',
          namespace,
          `ns:${quoteSearchValue(namespace)}`,
          matchRank(namespace, prefix),
        );
      for (const cluster of context.clusters ?? [])
        add(
          'cluster',
          cluster.name,
          `cluster:${quoteSearchValue(cluster.name)}`,
          matchRank(cluster.name, prefix),
          cluster.environment ?? undefined,
        );
      for (const key of Object.keys(context.labelValues ?? {})) {
        if (validSearchLabelKey(key)) add('label-key', key, `${key}=`, matchRank(key, prefix));
      }
    }
  }
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.priority - b.priority ||
        a.label.localeCompare(b.label, 'en') ||
        a.value.localeCompare(b.value, 'en'),
    )
    .slice(0, Math.max(0, Math.min(50, limit)))
    .map(({ rank: _rank, priority: _priority, ...suggestion }) => suggestion);
}
