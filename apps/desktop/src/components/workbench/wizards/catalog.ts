import * as i18n from '@/i18n/core';
import {
  CalendarClock,
  FileKey2,
  FileLock2,
  FolderPlus,
  KeyRound,
  Network,
  Package,
  PlayCircle,
  Route,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react';
import type { SecretFlavor } from '@/lib/kube/wizards/secret';
import type { ClusterId } from '@/types';
import { openWizard, type WizardRequest, type WizardResultHandler } from './wizardStore';

/**
 * Every wizard reachable from a "Create" menu, the create editor's
 * template picker and the command palette. `kindKeys` are the resource
 * pages whose Create menu offers the entry.
 */
export interface WizardEntry {
  id: string;
  /** Menu label (translated). */
  label: () => string;
  /** The kubectl command it mirrors (not translated). */
  command: string;
  icon: LucideIcon;
  kindKeys: readonly string[];
  /** Extra palette search words. */
  keywords: string;
  /** Needs a namespace (all but Namespace). */
  namespaced: boolean;
  request: (clusterId: ClusterId, namespace: string) => WizardRequest;
}

const secret = (
  flavor: SecretFlavor,
  label: () => string,
  icon: LucideIcon,
  keywords: string,
): WizardEntry => ({
  id: `secret-${flavor}`,
  label,
  command: `kubectl create secret ${flavor}`,
  icon,
  kindKeys: ['secrets'],
  keywords: `create secret ${flavor} ${keywords}`,
  namespaced: true,
  request: (clusterId, namespace) => ({ kind: 'secret', clusterId, namespace, flavor }),
});

export const WIZARDS: readonly WizardEntry[] = [
  secret('generic', () => i18n.t('Secret from literals and files…'), KeyRound, 'opaque env'),
  secret(
    'docker-registry',
    () => i18n.t('Registry credentials Secret…'),
    Package,
    'image pull registry dockerconfigjson',
  ),
  secret('tls', () => i18n.t('TLS Secret from certificate and key…'), FileLock2, 'certificate'),
  secret('basic-auth', () => i18n.t('Basic auth Secret…'), UserRoundCheck, 'username password'),
  secret('ssh-auth', () => i18n.t('SSH key Secret…'), FileKey2, 'ssh git deploy key'),
  {
    id: 'configmap',
    label: () => i18n.t('ConfigMap from literals, files or .env…'),
    command: 'kubectl create configmap',
    icon: SlidersHorizontal,
    kindKeys: ['configmaps'],
    keywords: 'create configmap config env file',
    namespaced: true,
    request: (clusterId, namespace) => ({ kind: 'configmap', clusterId, namespace }),
  },
  {
    id: 'expose',
    label: () => i18n.t('Expose a workload as a Service…'),
    command: 'kubectl expose',
    icon: Network,
    kindKeys: ['services'],
    keywords: 'expose service create port',
    namespaced: true,
    request: (clusterId, namespace) => ({ kind: 'expose', clusterId, namespace, target: null }),
  },
  {
    id: 'ingress',
    label: () => i18n.t('Ingress for a Service…'),
    command: 'kubectl create ingress',
    icon: Route,
    kindKeys: ['ingresses.networking.k8s.io'],
    keywords: 'create ingress host tls route',
    namespaced: true,
    request: (clusterId, namespace) => ({ kind: 'ingress', clusterId, namespace, service: null }),
  },
  {
    id: 'namespace',
    label: () => i18n.t('Namespace with quotas and pod security…'),
    command: 'kubectl create namespace',
    icon: FolderPlus,
    kindKeys: ['namespaces'],
    keywords: 'create namespace ns quota limitrange pod security',
    namespaced: false,
    request: (clusterId) => ({ kind: 'namespace', clusterId }),
  },
  {
    id: 'serviceaccount',
    label: () => i18n.t('ServiceAccount with a role binding…'),
    command: 'kubectl create serviceaccount',
    icon: UserPlus,
    kindKeys: ['serviceaccounts'],
    keywords: 'create serviceaccount sa rbac',
    namespaced: true,
    request: (clusterId, namespace) => ({
      kind: 'serviceaccount',
      clusterId,
      namespace,
      mode: 'create',
    }),
  },
  {
    id: 'rolebinding',
    label: () => i18n.t('RoleBinding for a ServiceAccount…'),
    command: 'kubectl create rolebinding',
    icon: ShieldCheck,
    kindKeys: ['rolebindings.rbac.authorization.k8s.io'],
    keywords: 'create rolebinding rbac bind role clusterrole',
    namespaced: true,
    request: (clusterId, namespace) => ({
      kind: 'serviceaccount',
      clusterId,
      namespace,
      mode: 'bind',
    }),
  },
  {
    id: 'cronjob',
    label: () => i18n.t('CronJob from an image…'),
    command: 'kubectl create cronjob',
    icon: CalendarClock,
    kindKeys: ['cronjobs.batch'],
    keywords: 'create cronjob cron schedule',
    namespaced: true,
    request: (clusterId, namespace) => ({ kind: 'cronjob', clusterId, namespace }),
  },
  {
    id: 'job-from-cronjob',
    label: () => i18n.t('Job from a CronJob…'),
    command: 'kubectl create job --from=cronjob/…',
    icon: PlayCircle,
    kindKeys: ['jobs.batch'],
    keywords: 'create job cronjob trigger run now',
    namespaced: true,
    request: (clusterId, namespace) => ({ kind: 'job-from-cronjob', clusterId, namespace }),
  },
];

export function wizardsForKind(kindKey: string): WizardEntry[] {
  return WIZARDS.filter((w) => w.kindKeys.includes(kindKey));
}

export function wizardById(id: string): WizardEntry | undefined {
  return WIZARDS.find((w) => w.id === id);
}

/** Wizards that end in a manifest (the Job trigger runs an action instead). */
export function manifestWizards(): WizardEntry[] {
  return WIZARDS.filter((w) => w.id !== 'job-from-cronjob');
}

export function openWizardEntry(
  entry: WizardEntry,
  clusterId: ClusterId,
  namespace: string,
  onYaml?: WizardResultHandler,
) {
  openWizard({ ...entry.request(clusterId, namespace), ...(onYaml ? { onYaml } : {}) });
}
