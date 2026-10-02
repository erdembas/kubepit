import * as i18n from '@/i18n/core';
import { cveExposureSection, cveSection, vulnerabilitySection } from '@/lib/ai/context/security';
import type { CveRow, Vulnerability } from '@/lib/kube/trivy';
import { gatherExplainContext } from '@/lib/ai/context/gather';
import { useAssistantStore } from '@/store/useAssistantStore';
import { useAppStore } from '@/store/useAppStore';
import type { ClusterId, Gvk, KubeObject } from '@/types';

let gather: AbortController | null = null;
export async function explainObject(
  clusterId: ClusterId,
  gvk: Gvk,
  obj: KubeObject,
): Promise<void> {
  gather?.abort();
  const pending = new AbortController();
  gather = pending;
  const currentCluster = useAppStore.getState().selectedClusterId;
  try {
    const sections = await gatherExplainContext(clusterId, gvk, obj, pending.signal);
    if (pending.signal.aborted || useAppStore.getState().selectedClusterId !== currentCluster)
      return;
    await useAssistantStore
      .getState()
      .ask({
        intent: 'explain',
        message: i18n.t('Explain the selected workload and its current problems.'),
        sections,
        scope: {
          cluster_id: clusterId,
          namespace: obj.metadata.namespace ?? null,
          object: {
            api_version: obj.apiVersion,
            kind: obj.kind,
            name: obj.metadata.name,
            namespace: obj.metadata.namespace ?? null,
          },
        },
      });
  } catch (error) {
    if (!pending.signal.aborted) useAppStore.getState().pushToast('error', String(error));
  } finally {
    if (gather === pending) gather = null;
  }
}

/** The namespace of a CVE's first report, when every report agrees on one. */
function cveNamespace(row: Pick<CveRow, 'workloads'>): string | null {
  const namespaces = new Set(row.workloads.map((w) => w.namespace).filter(Boolean));
  return namespaces.size === 1 ? [...namespaces][0]! : null;
}

/** Risk analysis of one CVE across the cluster: the finding and where it is exposed. */
export async function analyzeCveRisk(clusterId: ClusterId, row: CveRow): Promise<void> {
  const sections = [
    cveSection({
      id: row.id,
      severity: row.severity,
      title: row.title,
      score: row.score,
      link: row.link,
      packages: row.packages,
      installed: row.installed,
      fixed: row.fixed,
    }),
    cveExposureSection(row.reports),
  ].filter((s): s is NonNullable<typeof s> => s !== null);
  await useAssistantStore.getState().ask({
    intent: 'risk-analysis',
    message: i18n.t('Analyze the risk of {cve} for this cluster and how to mitigate it.', {
      cve: row.id,
    }),
    sections,
    scope: {
      cluster_id: clusterId,
      namespace: cveNamespace(row),
      object: null,
    },
  });
}

/** Risk analysis of one vulnerability of one scanned image. */
export async function analyzeVulnerabilityRisk(
  clusterId: ClusterId,
  report: KubeObject,
  vuln: Vulnerability,
): Promise<void> {
  const { cve, exposure } = vulnerabilitySection(report, vuln);
  const target = report.metadata.namespace ?? null;
  await useAssistantStore.getState().ask({
    intent: 'risk-analysis',
    message: i18n.t('Analyze the risk of {cve} for this cluster and how to mitigate it.', {
      cve: vuln.id,
    }),
    sections: exposure ? [cve, exposure] : [cve],
    scope: {
      cluster_id: clusterId,
      namespace: target,
      object: null,
    },
  });
}
