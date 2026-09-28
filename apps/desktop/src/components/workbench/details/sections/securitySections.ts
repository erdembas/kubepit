import type { ComponentType } from 'react';
import { trivyKindOf } from '@/lib/kube/trivy';
import type { KubeObject } from '@/types';
import {
  CheckReportSections,
  ComplianceReportSections,
  ExposedSecretReportSections,
  SbomReportSections,
  VulnerabilityReportSections,
} from './TrivySections';
import type { SectionProps } from './types';

/**
 * Details sections for Trivy Operator reports, matched by API group
 * (`aquasecurity.github.io`) and kind.
 */
export function securitySectionsFor(obj: KubeObject): ComponentType<SectionProps> | null {
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
