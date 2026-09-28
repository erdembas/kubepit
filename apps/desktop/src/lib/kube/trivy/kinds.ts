import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { gvkFromApiResource, kindKey, parseApiVersion } from '../catalog';

/**
 * Trivy Operator (https://aquasecurity.github.io/trivy-operator/) report
 * kinds. Detection is discovery-driven: the Security view reads reports
 * only when the cluster serves `aquasecurity.github.io`.
 */

export const TRIVY_GROUP = 'aquasecurity.github.io';
export const TRIVY_VERSION = 'v1alpha1';

export type TrivyKind =
  | 'VulnerabilityReport'
  | 'ClusterVulnerabilityReport'
  | 'ConfigAuditReport'
  | 'ClusterConfigAuditReport'
  | 'ExposedSecretReport'
  | 'RbacAssessmentReport'
  | 'ClusterRbacAssessmentReport'
  | 'InfraAssessmentReport'
  | 'ClusterInfraAssessmentReport'
  | 'ClusterComplianceReport'
  | 'SbomReport'
  | 'ClusterSbomReport';

export interface TrivyKindDef extends Gvk {
  kind: TrivyKind;
  key: string;
  shortNames: string[];
}

function def(
  kind: TrivyKind,
  plural: string,
  namespaced: boolean,
  shortNames: string[],
): TrivyKindDef {
  return {
    group: TRIVY_GROUP,
    version: TRIVY_VERSION,
    kind,
    plural,
    namespaced,
    key: `${plural}.${TRIVY_GROUP}`,
    shortNames,
  };
}

export const TRIVY_KINDS: readonly TrivyKindDef[] = [
  def('VulnerabilityReport', 'vulnerabilityreports', true, ['vuln', 'vulns']),
  def('ClusterVulnerabilityReport', 'clustervulnerabilityreports', false, ['clustervuln']),
  def('ConfigAuditReport', 'configauditreports', true, ['configaudit', 'configaudits']),
  def('ClusterConfigAuditReport', 'clusterconfigauditreports', false, ['clusterconfigaudit']),
  def('ExposedSecretReport', 'exposedsecretreports', true, ['exposedsecret', 'exposedsecrets']),
  def('RbacAssessmentReport', 'rbacassessmentreports', true, ['rbacassessment']),
  def('ClusterRbacAssessmentReport', 'clusterrbacassessmentreports', false, [
    'clusterrbacassessment',
  ]),
  def('InfraAssessmentReport', 'infraassessmentreports', true, ['infraassessment']),
  def('ClusterInfraAssessmentReport', 'clusterinfraassessmentreports', false, [
    'clusterinfraassessment',
  ]),
  def('ClusterComplianceReport', 'clustercompliancereports', false, ['compliance']),
  def('SbomReport', 'sbomreports', true, ['sbom', 'sboms']),
  def('ClusterSbomReport', 'clustersbomreports', false, ['clustersbom']),
];

export const TRIVY_KEYS = Object.fromEntries(TRIVY_KINDS.map((k) => [k.kind, k.key])) as Record<
  TrivyKind,
  string
>;

const BY_KIND = new Map(TRIVY_KINDS.map((k) => [k.kind as string, k]));

export function isTrivyObject(obj: Pick<KubeObject, 'apiVersion' | 'kind'>): boolean {
  return parseApiVersion(obj.apiVersion ?? '').group === TRIVY_GROUP && BY_KIND.has(obj.kind);
}

export function trivyKindOf(obj: Pick<KubeObject, 'apiVersion' | 'kind'>): TrivyKind | null {
  return isTrivyObject(obj) ? (obj.kind as TrivyKind) : null;
}

/** True when discovery serves any Trivy Operator report kind. */
export function detectTrivy(apiResources: readonly ApiResourceInfo[] | null | undefined): boolean {
  return !!apiResources?.some((r) => r.group === TRIVY_GROUP && BY_KIND.has(r.kind));
}

/** Served Gvk of a report kind, or `null` when the cluster does not serve it. */
export function trivyGvk(
  kind: TrivyKind,
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): Gvk | null {
  const key = TRIVY_KEYS[kind];
  const r = apiResources?.find((x) => kindKey(x) === key);
  return r ? gvkFromApiResource(r) : null;
}

export const TRIVY_DOCS_URL = 'https://aquasecurity.github.io/trivy-operator/latest/';
export const TRIVY_INSTALL_URL =
  'https://aquasecurity.github.io/trivy-operator/latest/getting-started/installation/helm/';
export const TRIVY_HELM_INSTALL = `helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm repo update
helm install trivy-operator aqua/trivy-operator \\
  --namespace trivy-system --create-namespace`;
