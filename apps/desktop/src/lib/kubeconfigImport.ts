import * as i18n from '@/i18n/core';
import type { ClusterDef, KubeconfigSource } from '@/types';

export interface KubeconfigChoice {
  create: boolean;
  context: string;
  cluster: string;
  /** null = user must choose; empty string = explicit anonymous authentication. */
  user: string | null;
}

export function initialKubeconfigChoice(
  source: KubeconfigSource,
  preferredContext?: string,
): KubeconfigChoice {
  const valid = source.contexts.filter(
    (c) =>
      source.clusters.some((cluster) => cluster.name === c.cluster && !!cluster.server) &&
      (!c.user || source.users.includes(c.user)),
  );
  const context =
    valid.find((c) => c.name === preferredContext) ??
    valid.find((c) => c.name === source.current_context) ??
    valid[0];
  const cluster = source.clusters.length === 1 ? source.clusters[0]!.name : '';
  return {
    create: !context,
    context:
      context?.name ??
      (source.current_context
        ? nextContextName(source, source.current_context)
        : cluster
          ? nextContextName(source, cluster)
          : ''),
    cluster,
    user: source.users.length === 1 ? source.users[0]! : source.users.length === 0 ? '' : null,
  };
}
export function nextContextName(source: KubeconfigSource, cluster: string): string {
  let name = cluster;
  for (let suffix = 2; source.contexts.some((c) => c.name === name); suffix++)
    name = `${cluster}-${suffix}`;
  return name;
}
export function kubeconfigChoiceProblem(
  source: KubeconfigSource | null,
  choice: KubeconfigChoice,
): string | null {
  if (!source || source.error) return source?.error ?? i18n.t('Choose a kubeconfig first.');
  if (!choice.context.trim()) return i18n.t('Give the context a name.');
  if (!choice.create) {
    const context = source.contexts.find((c) => c.name === choice.context);
    if (!context) return i18n.t('Choose a kubeconfig context first.');
    if (!source.clusters.some((c) => c.name === context.cluster))
      return i18n.t(
        'This context refers to a missing cluster. Create a context with an available cluster.',
      );
    if (context.user && !source.users.includes(context.user))
      return i18n.t(
        'This context refers to a missing user. Create a context with an available user.',
      );
    if (!source.clusters.find((c) => c.name === context.cluster)?.server)
      return i18n.t('The selected cluster has no API server address.');
    return null;
  }
  if (!source.clusters.some((c) => c.name === choice.cluster))
    return i18n.t('Choose a cluster from this kubeconfig.');
  if (!source.clusters.find((c) => c.name === choice.cluster)?.server)
    return i18n.t('The selected cluster has no API server address.');
  if (choice.user === null) return i18n.t('Choose a user or anonymous authentication.');
  if (choice.user && !source.users.includes(choice.user))
    return i18n.t('Choose a user from this kubeconfig.');
  if (source.contexts.some((c) => c.name === choice.context.trim()))
    return i18n.t('A context with this name already exists. Choose another name.');
  return null;
}

export const sourcePathOf = (
  cluster: Pick<ClusterDef, 'source_kubeconfig_path' | 'kubeconfig_path'>,
): string => cluster.source_kubeconfig_path ?? cluster.kubeconfig_path;

/** Translate app-owned import failures; names, paths and technical I/O details stay intact. */
export function kubeconfigErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/(?:^|: )invalid kubeconfig (?:file|YAML)$/.test(text))
    return i18n.t('The kubeconfig YAML is invalid.');
  if (
    /(?:^|: )(?:generated kubeconfig is too large \(maximum 16 MiB\)|kubeconfig (?:text is too large \(maximum 16 MiB\)|must be a file no larger than 16 MiB))$/.test(
      text,
    )
  )
    return i18n.t('Kubeconfig files must be no larger than 16 MiB.');
  if (/(?:^|: )No contexts found in (?:this|the pasted) kubeconfig$/.test(text))
    return i18n.t('This kubeconfig contains no clusters.');
  if (/(?:^|: )a context name is required$/.test(text)) return i18n.t('Give the context a name.');
  if (text.endsWith('set either kubeconfig_path or kubeconfig_text, not both'))
    return i18n.t('Choose either a kubeconfig file or pasted YAML.');
  if (text.endsWith('a kubeconfig path or pasted kubeconfig is required'))
    return i18n.t('Choose a kubeconfig first.');
  if (text.endsWith('the cluster source changed; reopen its settings and try again'))
    return i18n.t('The cluster’s kubeconfig changed. Reopen Edit cluster and try again.');
  let match =
    /context "([^"]+)" not found(?: \(available: .*\)|: the kubeconfig defines no contexts)$/.exec(
      text,
    );
  if (match)
    return i18n.t(
      'Context "{context}" was not found. Choose another context or create one from the available cluster and user entries.',
      { context: match[1] },
    );
  match = /context "([^"]+)" already exists; choose it or use a different name$/.exec(text);
  if (match)
    return i18n.t('Context "{context}" already exists. Choose it or enter another name.', {
      context: match[1],
    });
  match = /(?:context|cluster) "([^"]+)" has no server$/.exec(text);
  if (match) return i18n.t('The selected cluster has no API server address.');
  match = /(cluster|user) "([^"]+)"(?: referenced by context "[^"]+")? is not defined$/.exec(text);
  if (match)
    return match[1] === 'cluster'
      ? i18n.t('Cluster "{name}" is missing from the kubeconfig.', { name: match[2] })
      : i18n.t('User "{name}" is missing from the kubeconfig.', { name: match[2] });
  if (text.endsWith('uses a relative path; import the original kubeconfig file instead'))
    return i18n.t(
      'This kubeconfig uses relative credential paths. Import the original file instead of pasting it.',
    );
  if (text.endsWith('token file is empty')) return i18n.t('The token file is empty.');
  if (text.endsWith('token file is not UTF-8'))
    return i18n.t('The token file must contain UTF-8 text.');
  return text;
}
