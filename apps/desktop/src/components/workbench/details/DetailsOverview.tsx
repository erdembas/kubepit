import * as i18n from '@/i18n';
import type { ComponentType } from 'react';
import { RefLink } from '@/lib/kube/columns/cells';
import type { ColumnContext } from '@/lib/kube/columns';
import { formatAge } from '@/lib/format';
import type { Gvk, KubeObject } from '@/types';
import { ChipList, MonoText, Row, Rows, Section } from './primitives';
import { ConfigMapSections, SecretSections } from './sections/ConfigSections';
import { CrdSections, GenericSections } from './sections/GenericSections';
import { CronJobSections, JobSections } from './sections/JobSections';
import { EndpointsSections, IngressSections, ServiceSections } from './sections/NetworkSections';
import { EventSections, NamespaceSections } from './sections/ClusterSections';
import { NodeSections } from './sections/NodeSections';
import { HpaSections, PdbSections } from './sections/PolicySections';
import { PodSections } from './sections/PodSections';
import { BindingSections, RoleSections, ServiceAccountSections } from './sections/RbacSections';
import { PvSections, PvcSections, StorageClassSections } from './sections/StorageSections';
import { WorkloadSections } from './sections/WorkloadSections';
import type { SectionProps } from './sections/types';

const BY_KIND: Record<string, ComponentType<SectionProps>> = {
  Pod: PodSections,
  Deployment: WorkloadSections,
  StatefulSet: WorkloadSections,
  DaemonSet: WorkloadSections,
  ReplicaSet: WorkloadSections,
  ReplicationController: WorkloadSections,
  Job: JobSections,
  CronJob: CronJobSections,
  Node: NodeSections,
  Namespace: NamespaceSections,
  Event: EventSections,
  Service: ServiceSections,
  Ingress: IngressSections,
  Endpoints: EndpointsSections,
  ConfigMap: ConfigMapSections,
  Secret: SecretSections,
  PersistentVolumeClaim: PvcSections,
  PersistentVolume: PvSections,
  StorageClass: StorageClassSections,
  Role: RoleSections,
  ClusterRole: RoleSections,
  RoleBinding: BindingSections,
  ClusterRoleBinding: BindingSections,
  ServiceAccount: ServiceAccountSections,
  HorizontalPodAutoscaler: HpaSections,
  PodDisruptionBudget: PdbSections,
  CustomResourceDefinition: CrdSections,
};

function MetaSection({ obj, ctx }: { obj: KubeObject; ctx: ColumnContext }) {
  i18n.useLocale();
  const m = obj.metadata;
  return (
    <Section title={i18n.t('Metadata')}>
      <Rows>
        <Row label={i18n.t('Created')}>
          {m.creationTimestamp ? (
            <span title={m.creationTimestamp}>
              {i18n.t('{age} ago', { age: formatAge(m.creationTimestamp, ctx.now) })}
              <span className="text-fg-dim ml-1.5 text-[11px]">
                {i18n.date(Date.parse(m.creationTimestamp), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </span>
          ) : null}
        </Row>
        <Row label={i18n.t('Name')}>
          <MonoText>{m.name}</MonoText>
        </Row>
        {m.namespace && (
          <Row label={i18n.t('Namespace')}>
            <RefLink
              target={{ apiVersion: 'v1', kind: 'Namespace', name: m.namespace }}
              ctx={ctx}
            />
          </Row>
        )}
        <Row label="UID">
          <MonoText>{m.uid}</MonoText>
        </Row>
        {m.deletionTimestamp && (
          <Row label={i18n.t('Deleting')}>
            <span className="text-status-starting">
              {i18n.t('Terminating since {age}', { age: formatAge(m.deletionTimestamp, ctx.now) })}
            </span>
          </Row>
        )}
        <Row label={i18n.t('Labels')}>
          <ChipList entries={Object.entries(m.labels ?? {})} />
        </Row>
        <Row label={i18n.t('Annotations')}>
          <ChipList
            entries={Object.entries(m.annotations ?? {}).filter(
              ([k]) => k !== 'kubectl.kubernetes.io/last-applied-configuration',
            )}
            limit={4}
          />
        </Row>
        {m.ownerReferences?.length ? (
          <Row label={i18n.t('Controlled By')}>
            <span className="flex flex-col gap-0.5">
              {m.ownerReferences.map((r) => (
                <span key={r.uid} className="flex min-w-0 items-baseline gap-1.5">
                  <span className="text-fg-dim text-[11px]">{r.kind}</span>
                  <RefLink
                    target={{
                      apiVersion: r.apiVersion,
                      kind: r.kind,
                      name: r.name,
                      namespace: m.namespace ?? null,
                    }}
                    ctx={ctx}
                  />
                </span>
              ))}
            </span>
          </Row>
        ) : null}
        {m.finalizers?.length ? (
          <Row label={i18n.t('Finalizers')}>
            <ChipList entries={m.finalizers} />
          </Row>
        ) : null}
      </Rows>
    </Section>
  );
}

export function DetailsOverview({
  obj,
  gvk,
  ctx,
  isActive,
  readOnly,
}: {
  obj: KubeObject;
  gvk: Gvk;
  ctx: ColumnContext;
  isActive: boolean;
  readOnly: boolean;
}) {
  i18n.useLocale();
  const Kind = BY_KIND[obj.kind] ?? GenericSections;
  return (
    <>
      <MetaSection obj={obj} ctx={ctx} />
      <Kind obj={obj} gvk={gvk} ctx={ctx} isActive={isActive} readOnly={readOnly} />
    </>
  );
}
