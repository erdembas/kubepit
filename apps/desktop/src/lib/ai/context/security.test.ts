import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@/types';
import { cveExposureSection, cveSection, vulnerabilitySection } from './security';

/** A VulnerabilityReport of the `web` Deployment's `app` container in `shop`. */
function report(): KubeObject {
  return {
    apiVersion: 'aquasecurity.github.io/v1alpha1',
    kind: 'VulnerabilityReport',
    metadata: {
      name: 'web-7c9d8b6f5-abcde-app',
      namespace: 'shop',
      uid: 'uid-1',
      labels: {
        'trivy-operator.resource.kind': 'ReplicaSet',
        'trivy-operator.resource.name': 'web-7c9d8b6f5',
        'trivy-operator.resource.namespace': 'shop',
        'trivy-operator.container.name': 'app',
      },
    },
    report: {
      scanner: { name: 'Trivy', vendor: 'Aqua Security', version: '0.58.2' },
      artifact: { repository: 'acme/web', tag: '1.2.3', digest: 'sha256:abc' },
      registry: { server: 'ghcr.io' },
      os: { family: 'alpine', name: '3.19.1' },
      updateTimestamp: '2026-09-28T10:00:00Z',
      summary: { criticalCount: 1, highCount: 2, mediumCount: 0, lowCount: 0, unknownCount: 0 },
      vulnerabilities: [
        {
          vulnerabilityID: 'CVE-2023-44487',
          resource: 'golang.org/x/net',
          installedVersion: 'v0.15.0',
          fixedVersion: '0.17.0',
          severity: 'HIGH',
          title: 'HTTP/2 rapid reset can make a server do excessive work',
          primaryLink: 'https://avd.aquasec.com/nvd/cve-2023-44487',
          score: 7.5,
          target: 'app',
          publishedDate: '2023-10-10',
        },
        {
          vulnerabilityID: 'CVE-2024-45337',
          resource: 'golang.org/x/crypto',
          installedVersion: 'v0.21.0',
          fixedVersion: '0.31.0',
          severity: 'CRITICAL',
          title: 'Misuse of PublicKeyCallback may lead to an authorization bypass',
          primaryLink: 'https://avd.aquasec.com/nvd/cve-2024-45337',
          score: 9.1,
          target: 'app',
          publishedDate: '2024-12-11',
        },
      ],
    },
  };
}

describe('risk-analysis context sections', () => {
  it('describes the CVE with severity, score, versions and fix status', () => {
    const section = cveSection({
      id: 'CVE-2023-44487',
      severity: 'HIGH',
      title: 'HTTP/2 rapid reset can make a server do excessive work',
      score: 7.5,
      link: 'https://avd.aquasec.com/nvd/cve-2023-44487',
      packages: ['golang.org/x/net'],
      installed: ['v0.15.0'],
      fixed: ['0.17.0'],
    });
    expect(section).toMatchObject({
      id: 'cve',
      kind: 'vulnerabilities',
      label: 'CVE-2023-44487',
      priority: 0,
      format: 'text',
    });
    expect(section.content).toContain('cve: CVE-2023-44487');
    expect(section.content).toContain('severity: HIGH');
    expect(section.content).toContain('cvss score: 7.5');
    expect(section.content).toContain('fixed in:');
    expect(section.content).toContain('0.17.0');
  });

  it('says when no fix is released', () => {
    const section = cveSection({
      id: 'CVE-2024-99999',
      severity: 'CRITICAL',
      title: '',
      score: null,
      link: '',
      packages: ['openssl'],
      installed: ['3.1.0'],
      fixed: [],
    });
    expect(section.content).toContain('(no fix released yet)');
    expect(section.content).not.toContain('advisory:');
  });

  it('maps report targets to the workloads a person thinks of', () => {
    const section = cveExposureSection([report()]);
    expect(section).not.toBeNull();
    expect(section!.content).toContain('ghcr.io/acme/web:1.2.3');
    expect(section!.content).toContain('Deployment shop/web');
    expect(section!.content).toContain('containers:');
    expect(section!.content).toContain('app');
    expect(section!.content).toContain('scanner: Trivy 0.58.2');
  });

  it('returns no exposure section without reports', () => {
    expect(cveExposureSection([])).toBeNull();
  });

  it('builds both sections of a single vulnerability with its image context', () => {
    const { cve, exposure } = vulnerabilitySection(report(), {
      id: 'CVE-2023-44487',
      pkg: 'golang.org/x/net',
      installed: 'v0.15.0',
      fixed: '0.17.0',
      severity: 'HIGH',
      title: 'HTTP/2 rapid reset can make a server do excessive work',
      link: 'https://avd.aquasec.com/nvd/cve-2023-44487',
      score: 7.5,
      target: 'app',
      published: '2023-10-10',
    });
    expect(cve.content).toContain('package: golang.org/x/net');
    expect(cve.content).toContain('installed: v0.15.0');
    expect(cve.content).toContain('published: 2023-10-10');
    expect(exposure!.content).toContain('digest: sha256:abc');
    expect(exposure!.content).toContain('scanned object: ReplicaSet shop/web-7c9d8b6f5');
    expect(exposure!.content).toContain('other vulnerabilities in this image: 2');
  });
});
