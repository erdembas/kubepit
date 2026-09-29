import type { AiContextSection, AiScope } from '@/types';

export function explainable(kind: string): boolean {
  return ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'].includes(
    kind,
  );
}
export function querySection(language: 'promql' | 'logql', query: string): AiContextSection {
  return {
    id: `query:${language}`,
    kind: 'query',
    priority: 0,
    format: 'text',
    label: language,
    content: query,
  };
}
export function nlRequest(intent: 'kubectl' | 'promql' | 'logql', message: string, scope: AiScope) {
  const section: AiContextSection = {
    id: 'scope',
    kind: 'scope',
    priority: 0,
    format: 'json',
    label: 'scope',
    content: JSON.stringify(scope),
  };
  return { intent, message, sections: [section] };
}

/** Identity remains useful even when the cluster does not publish a schema. */
export function yamlKindSection(
  apiVersion: string,
  kind: string,
  namespace: string,
): AiContextSection {
  return {
    id: 'resource-kind',
    kind: 'scope',
    priority: 0,
    format: 'json',
    label: `${apiVersion} ${kind}`,
    content: JSON.stringify({ apiVersion, kind, namespace }),
  };
}
