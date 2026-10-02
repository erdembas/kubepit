import type { ComponentType } from 'react';
import { policyReportKindOf } from '@/lib/kube/policyreports';
import { trivyKindOf } from '@/lib/kube/trivy';
import type { KubeObject } from '@/types';
import { PolicyReportSections } from './PolicyReportSections';
import {
  CheckReportSections,
  ComplianceReportSections,
  ExposedSecretReportSections,
  SbomReportSections,
  VulnerabilityReportSections,
} from './TrivySections';
import type { SectionProps } from './types';

/**
 * Details sections for security report objects, matched by API group
 * (`aquasecurity.github.io`, `wgpolicyk8s.io`) and kind.
 */
export function securitySectionsFor(obj: KubeObject): ComponentType<SectionProps> | null {
  if (policyReportKindOf(obj)) return PolicyReportSections;
  switch (trivyKindOf(obj)) {
    case 'VulnerabilityReport':
    case 'ClusterVulnerabilityReport':
      return VulnerabilityReportSections;
    case 'ConfigAuditReport':
    case 'ClusterConfigAuditReport':
    case 'RbacAssessmentReport':
    case 'ClusterRbacAssessmentReport':
    case 'InfraAssessmentReport':
    case 'ClusterInfraAssessmentReport':
      return CheckReportSections;
    case 'ExposedSecretReport':
      return ExposedSecretReportSections;
    case 'ClusterComplianceReport':
      return ComplianceReportSections;
    case 'SbomReport':
    case 'ClusterSbomReport':
      return SbomReportSections;
    default:
      return null;
  }
}