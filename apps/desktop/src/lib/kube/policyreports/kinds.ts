import type { ApiResourceInfo, Gvk, KubeObject } from '@/types';
import { gvkFromApiResource, kindKey, parseApiVersion } from '../catalog';

/**
 * Policy reports (`wgpolicyk8s.io/v1alpha2`): what Kyverno, Falcosidekick
 * and other tools write about the policies they evaluated against objects.
 * Detection is discovery-driven, like Trivy: the reports are read only
 * when the cluster serves the CRDs, and Kubepit never installs them.
 */

export const POLICY_GROUP = 'wgpolicyk8s.io';
export const POLICY_VERSION = 'v1alpha2';

export type PolicyReportKind = 'PolicyReport' | 'ClusterPolicyReport';

export interface PolicyReportKindDef extends Gvk {
  kind: PolicyReportKind;
  key: string;
  shortNames: string[];
}

function def(kind: PolicyReportKind, plural: string, namespaced: boolean): PolicyReportKindDef {
  return {
    group: POLICY_GROUP,
    version: POLICY_VERSION,
    kind,
    plural,
    namespaced,
    key: `${plural}.${POLICY_GROUP}`,
    shortNames: kind === 'PolicyReport' ? ['polr', 'polrs'] : ['cpolr', 'cpolrs'],
  };
}

export const POLICY_REPORT_KINDS: readonly PolicyReportKindDef[] = [
  def('PolicyReport', 'policyreports', true),
  def('ClusterPolicyReport', 'clusterpolicyreports', false),
];

export const POLICY_REPORT_KEYS = Object.fromEntries(
  POLICY_REPORT_KINDS.map((k) => [k.kind, k.key]),
) as Record<PolicyReportKind, string>;

const BY_KIND = new Map(POLICY_REPORT_KINDS.map((k) => [k.kind as string, k]));

export function isPolicyReportObject(obj: Pick<KubeObject, 'apiVersion' | 'kind'>): boolean {
  return parseApiVersion(obj.apiVersion ?? '').group === POLICY_GROUP && BY_KIND.has(obj.kind);
}

export function policyReportKindOf(
  obj: Pick<KubeObject, 'apiVersion' | 'kind'>,
): PolicyReportKind | null {
  return isPolicyReportObject(obj) ? (obj.kind as PolicyReportKind) : null;
}

/** True when discovery serves a policy report kind. */
export function detectPolicyReports(
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): boolean {
  return !!apiResources?.some((r) => r.group === POLICY_GROUP && BY_KIND.has(r.kind));
}

/** Served Gvk of a report kind, or `null` when the cluster does not serve it. */
export function policyReportGvk(
  kind: PolicyReportKind,
  apiResources: readonly ApiResourceInfo[] | null | undefined,
): Gvk | null {
  const r = apiResources?.find((x) => kindKey(x) === POLICY_REPORT_KEYS[kind]);
  return r ? gvkFromApiResource(r) : null;
}

export const POLICY_REPORTS_SPEC_URL =
  'https://github.com/kubernetes-sigs/wg-policy-prototypes/tree/master/policy-report';
export const KYVERNO_DOCS_URL = 'https://kyverno.io/docs/policy-reports/';
