import type { Gvk, KubeObject } from '@/types';
import { asArray, asString, isObject, spec } from '../accessors';
import { BUILTIN } from '../catalog';
import { eventColumns, namespaceColumns, nodeColumns } from './cluster';
import { customColumns, crdDefinitionColumns } from './custom';
import {
  configMapColumns,
  hpaColumns,
  leaseColumns,
  limitRangeColumns,
  pdbColumns,
  priorityClassColumns,
  resourceQuotaColumns,
  runtimeClassColumns,
  secretColumns,
  webhookColumns,
} from './config';
import {
  endpointSliceColumns,
  endpointsColumns,
  ingressClassColumns,
  ingressColumns,
  networkPolicyColumns,
  serviceColumns,
} from './network';
import {
  bindingColumns,
  pvColumns,
  pvcColumns,
  roleColumns,
  serviceAccountColumns,
  storageClassColumns,
} from './storage';
import { podColumns } from './pods';
import type { KindColumns } from './types';
import {
  cronJobColumns,
  daemonSetColumns,
  deploymentColumns,
  jobColumns,
  replicaSetColumns,
  replicationControllerColumns,
  statefulSetColumns,
} from './workloads';

export type { ColumnContext, ColumnDef, KindColumns, ObjectRef } from './types';

const REGISTRY: Record<string, KindColumns> = {
  [BUILTIN.Pod.key]: podColumns,
  [BUILTIN.Deployment.key]: deploymentColumns,
  [BUILTIN.DaemonSet.key]: daemonSetColumns,
  [BUILTIN.StatefulSet.key]: statefulSetColumns,
  [BUILTIN.ReplicaSet.key]: replicaSetColumns,
  [BUILTIN.ReplicationController.key]: replicationControllerColumns,
  [BUILTIN.Job.key]: jobColumns,
  [BUILTIN.CronJob.key]: cronJobColumns,
  [BUILTIN.Node.key]: nodeColumns,
  [BUILTIN.Namespace.key]: namespaceColumns,
  [BUILTIN.Event.key]: eventColumns,
  [BUILTIN.ConfigMap.key]: configMapColumns,
  [BUILTIN.Secret.key]: secretColumns,
  [BUILTIN.ResourceQuota.key]: resourceQuotaColumns,
  [BUILTIN.LimitRange.key]: limitRangeColumns,
  [BUILTIN.HorizontalPodAutoscaler.key]: hpaColumns,
  [BUILTIN.PodDisruptionBudget.key]: pdbColumns,
  [BUILTIN.PriorityClass.key]: priorityClassColumns,
  [BUILTIN.RuntimeClass.key]: runtimeClassColumns,
  [BUILTIN.Lease.key]: leaseColumns,
  [BUILTIN.MutatingWebhookConfiguration.key]: webhookColumns,
  [BUILTIN.ValidatingWebhookConfiguration.key]: webhookColumns,
  [BUILTIN.Service.key]: serviceColumns,
  [BUILTIN.Endpoints.key]: endpointsColumns,
  [BUILTIN.EndpointSlice.key]: endpointSliceColumns,
  [BUILTIN.Ingress.key]: ingressColumns,
  [BUILTIN.IngressClass.key]: ingressClassColumns,
  [BUILTIN.NetworkPolicy.key]: networkPolicyColumns,
  [BUILTIN.PersistentVolumeClaim.key]: pvcColumns,
  [BUILTIN.PersistentVolume.key]: pvColumns,
  [BUILTIN.StorageClass.key]: storageClassColumns,
  [BUILTIN.ServiceAccount.key]: serviceAccountColumns,
  [BUILTIN.ClusterRole.key]: roleColumns(false),
  [BUILTIN.Role.key]: roleColumns(true),
  [BUILTIN.ClusterRoleBinding.key]: bindingColumns(false),
  [BUILTIN.RoleBinding.key]: bindingColumns(true),
  [BUILTIN.CustomResourceDefinition.key]: crdDefinitionColumns,
};

export interface PrinterColumn {
  name: string;
  type: string;
  jsonPath: string;
  priority?: number;
  description?: string;
}

/** `additionalPrinterColumns` of the CRD version that serves `gvk`. */
export function printerColumns(
  crd: KubeObject | null | undefined,
  version: string,
): PrinterColumn[] {
  if (!crd) return [];
  const versions = asArray(spec(crd).versions).filter(isObject);
  const v =
    versions.find((x) => asString(x.name) === version) ??
    versions.find((x) => x.storage === true) ??
    versions[0];
  const cols = asArray(v?.additionalPrinterColumns ?? spec(crd).additionalPrinterColumns).filter(
    isObject,
  );
  return cols.map((c) => ({
    name: asString(c.name),
    type: asString(c.type) || 'string',
    jsonPath: asString(c.jsonPath ?? c.JSONPath),
    priority: typeof c.priority === 'number' ? c.priority : undefined,
    description: asString(c.description) || undefined,
  }));
}

export function columnsFor(key: string, gvk: Gvk, crd?: KubeObject | null): KindColumns {
  return REGISTRY[key] ?? customColumns(gvk, printerColumns(crd, gvk.version));
}
