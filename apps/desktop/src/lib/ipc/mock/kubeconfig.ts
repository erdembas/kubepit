import YAML from 'yaml';
import * as i18n from '@/i18n/core';
import { kubeconfigChoiceProblem } from '@/lib/kubeconfigImport';
import type { KubeconfigContext, KubeconfigImportInput, KubeconfigSource } from '@/types';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record) : [];
const name = (value: unknown) => (typeof value === 'string' ? value : '');

/** Browser demo metadata parser. Credentials never appear in the result or parse errors. */
export function parseKubeconfigText(text: string): KubeconfigSource {
  const empty: KubeconfigSource = {
    path: '',
    current_context: null,
    error: null,
    contexts: [],
    clusters: [],
    users: [],
  };
  try {
    if (new TextEncoder().encode(text).length > 16 * 1024 * 1024)
      return { ...empty, error: i18n.t('Kubeconfig files must be no larger than 16 MiB.') };
    const document = record(YAML.parse(text, { maxAliasCount: 50 }));
    const clusters = list(document.clusters)
      .filter((entry) => name(entry.name))
      .map((entry) => ({
        name: name(entry.name),
        server: name(record(entry.cluster).server) || null,
      }));
    const users = list(document.users)
      .map((entry) => name(entry.name))
      .filter(Boolean);
    const contexts: KubeconfigContext[] = list(document.contexts)
      .filter((entry) => name(entry.name))
      .map((entry) => {
        const context = record(entry.context);
        const cluster = name(context.cluster);
        return {
          name: name(entry.name),
          cluster,
          user: name(context.user),
          namespace: name(context.namespace) || null,
          server: clusters.find((c) => c.name === cluster)?.server ?? null,
        };
      });
    return {
      ...empty,
      clusters,
      users,
      contexts,
      current_context: name(document['current-context']) || null,
      error: clusters.length ? null : i18n.t('This kubeconfig contains no clusters.'),
    };
  } catch {
    return { ...empty, error: i18n.t('The kubeconfig YAML is invalid.') };
  }
}

export function importedKubeconfigSource(
  source: KubeconfigSource,
  input: KubeconfigImportInput,
  managedPath: string,
): KubeconfigSource {
  const problem = kubeconfigChoiceProblem(source, {
    create: !!input.create_context,
    context: input.context,
    cluster: input.create_context?.cluster ?? '',
    user: input.create_context?.user ?? '',
  });
  if (problem) throw new Error(problem);
  const requested = input.create_context;
  const context = requested
    ? {
        name: input.context.trim(),
        cluster: requested.cluster,
        user: requested.user ?? '',
        namespace: requested.namespace,
        server: source.clusters.find((c) => c.name === requested.cluster)?.server ?? null,
      }
    : source.contexts.find((c) => c.name === input.context)!;
  return structuredClone({
    path: managedPath,
    contexts: [context],
    current_context: context.name,
    error: null,
    clusters: source.clusters.filter((c) => c.name === context.cluster),
    users: context.user ? [context.user] : [],
  });
}
