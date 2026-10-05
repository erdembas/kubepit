import * as i18n from '@/i18n/core';
import { Network, Route, ShieldCheck } from 'lucide-react';
import { asString, spec } from '@/lib/kube/accessors';
import { isExposable } from '@/lib/kube/wizards/expose';
import { servicePorts } from '@/lib/kube/wizards/ingress';
import { sharedNamespacesOf } from '@/store/useWorkbenchStore';
import type { ClusterDef, KubeObject } from '@/types';
import { openWizard } from '../wizards/wizardStore';
import type { ResourceAction } from './resourceActions';
import { roleBindingAccess, roleBindingNamespace } from './roleBindingTarget';

/**
 * Resource wizards started from an object: Expose (workloads and pods),
 * Create Ingress (Services) and Add RoleBinding (ServiceAccounts, Roles,
 * ClusterRoles). They open a form; nothing is written until the manifest
 * is applied from the create editor.
 */
export function wizardActions({
  clusterId,
  cluster,
  obj,
}: {
  clusterId: string;
  cluster: ClusterDef | undefined;
  obj: KubeObject;
}): ResourceAction[] {
  const out: ResourceAction[] = [];
  const ns = obj.metadata.namespace ?? null;
  const name = obj.metadata.name;
  if (isExposable(obj.kind))
    out.push({
      id: 'expose',
      label: i18n.t('Expose…'),
      icon: Network,
      mutating: true,
      run: () => openWizard({ kind: 'expose', clusterId, namespace: ns ?? 'default', target: obj }),
    });
  if (obj.kind === 'Service' && asString(spec(obj).type) !== 'ExternalName')
    out.push({
      id: 'create-ingress',
      label: i18n.t('Create Ingress…'),
      icon: Route,
      mutating: true,
      run: () =>
        openWizard({
          kind: 'ingress',
          clusterId,
          namespace: ns ?? 'default',
          service: { name, port: servicePorts(obj)[0]?.value ?? '' },
        }),
    });
  if (obj.kind === 'ServiceAccount')
    out.push({
      id: 'add-rolebinding',
      label: i18n.t('Add RoleBinding…'),
      icon: ShieldCheck,
      mutating: true,
      run: () =>
        openWizard({
          kind: 'serviceaccount',
          clusterId,
          namespace: ns ?? 'default',
          mode: 'bind',
          name,
        }),
    });
  if (obj.kind === 'Role' || obj.kind === 'ClusterRole') {
    // A ClusterRole is bound in the namespace the workbench shows (or the cluster default),
    // so the permission check asks about that namespace, not cluster-wide.
    const namespace = roleBindingNamespace(ns, sharedNamespacesOf(clusterId) ?? undefined, cluster);
    out.push({
      id: 'add-rolebinding',
      label: i18n.t('Add RoleBinding…'),
      icon: ShieldCheck,
      mutating: true,
      access: roleBindingAccess(namespace),
      run: () =>
        openWizard({
          kind: 'serviceaccount',
          clusterId,
          namespace,
          mode: 'bind',
          role: { kind: obj.kind as 'Role' | 'ClusterRole', name },
        }),
    });
  }
  return out;
}
