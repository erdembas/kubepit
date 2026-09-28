import * as i18n from '@/i18n/core';
import type { CustomAction } from '@/types';
import { DEFAULT_TIMEOUT_SECS } from './customActions';

/**
 * Built-in examples, added disabled the first time `actions.json` is
 * created (and on demand from Settings). Names and descriptions are written
 * in the user's language at that moment; commands are never translated.
 */
export const EXAMPLE_ID_PREFIX = 'example-';

function example(
  id: string,
  fields: Omit<CustomAction, 'id' | 'enabled' | 'namespaces' | 'cluster_tags' | 'timeout_secs'> &
    Partial<Pick<CustomAction, 'timeout_secs'>>,
): CustomAction {
  return {
    id: `${EXAMPLE_ID_PREFIX}${id}`,
    enabled: false,
    namespaces: [],
    cluster_tags: [],
    timeout_secs: DEFAULT_TIMEOUT_SECS,
    ...fields,
  };
}

export function builtinExamples(): CustomAction[] {
  return [
    example('describe', {
      name: i18n.t('kubectl describe'),
      description: i18n.t('Describe the object in a terminal.'),
      icon: 'file-text',
      scopes: ['*'],
      command: 'kubectl describe {resource} {name} -n {namespace}',
      mode: 'terminal',
      confirm: false,
      mutating: false,
      shortcut: 'shift+d',
    }),
    example('wide', {
      name: i18n.t('Pods of this app (wide)'),
      description: i18n.t('kubectl get -o wide for the pods with the same app label.'),
      icon: 'list',
      scopes: ['apps/Deployment', 'apps/StatefulSet', 'apps/DaemonSet', 'core/Service', 'core/Pod'],
      command: 'kubectl get pods -n {namespace} -l app={labels.app} -o wide',
      mode: 'background',
      confirm: false,
      mutating: false,
      shortcut: null,
    }),
    example('stern', {
      name: i18n.t('Tail logs with stern'),
      description: i18n.t('Follow the logs of every pod of the workload (needs stern).'),
      icon: 'activity',
      scopes: ['apps/Deployment', 'apps/StatefulSet', 'apps/DaemonSet', 'batch/Job'],
      command: 'stern -n {namespace} --tail 100 {resource}/{name}',
      mode: 'terminal',
      confirm: false,
      mutating: false,
      shortcut: 'shift+l',
    }),
    example('neat', {
      name: i18n.t('Clean YAML (kubectl neat)'),
      description: i18n.t('The manifest without status and server fields (needs kubectl-neat).'),
      icon: 'eye',
      scopes: ['*'],
      command: 'kubectl get {resource} {name} -n {namespace} -o yaml | kubectl neat',
      mode: 'background',
      confirm: false,
      mutating: false,
      shortcut: null,
    }),
    example('grafana', {
      name: i18n.t('Open in Grafana'),
      description: i18n.t('Workload dashboard; change the URL to your Grafana.'),
      icon: 'gauge',
      scopes: ['apps/Deployment', 'apps/StatefulSet', 'apps/DaemonSet'],
      command:
        'https://grafana.example.com/d/a164a7f0339f99e89cea5cb47e9be617/kubernetes-compute-resources-workload?var-cluster={cluster}&var-namespace={namespace}&var-workload={name}',
      mode: 'open-url',
      confirm: false,
      mutating: false,
      shortcut: null,
    }),
    example('argocd', {
      name: i18n.t('Open in Argo CD'),
      description: i18n.t('Application page; change the URL to your Argo CD.'),
      icon: 'git-branch',
      scopes: ['argoproj.io/Application'],
      command: 'https://argocd.example.com/applications/{namespace}/{name}',
      mode: 'open-url',
      confirm: false,
      mutating: false,
      shortcut: null,
    }),
    example('annotate', {
      name: i18n.t('Mark as checked'),
      description: i18n.t('Annotate every selected object with the current time.'),
      icon: 'tag',
      scopes: ['*'],
      command:
        'kubectl annotate {resource} {selection.names} -n {namespace} --overwrite kubepit.io/checked-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
      mode: 'background',
      confirm: true,
      mutating: true,
      shortcut: null,
    }),
    example('top-nodes', {
      name: i18n.t('Node usage (kubectl top)'),
      description: i18n.t('CPU and memory of every node (needs metrics-server).'),
      icon: 'gauge',
      scopes: ['cluster'],
      command: 'kubectl top nodes',
      mode: 'background',
      confirm: false,
      mutating: false,
      shortcut: null,
    }),
  ];
}
