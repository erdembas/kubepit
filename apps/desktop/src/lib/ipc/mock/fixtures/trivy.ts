import { buildRbacIndex, roleRisks, type RiskId, type RoleInfo } from '@/lib/kube/rbac';
import type { KubeObject } from '@/types';
import type { CrdInput } from './crds';
import { list, put, type ClusterDb } from './db';
import { DAY, HOUR, MIN, ago, hashString, meta, obj } from './util';

/**
 * Trivy Operator demo data: CRDs and reports as the operator writes them
 * (labels `trivy-operator.resource.*`, owner references to the scanned
 * object), derived from the demo workloads so reports match what runs.
 * Vulnerabilities come from a small catalog of real CVEs chosen per image
 * deterministically, so one image looks the same everywhere.
 */

export const TRIVY_CLUSTERS = new Set(['c-prod-eu', 'c-staging', 'c-dev']);

export function hasTrivy(db: ClusterDb): boolean {
  return TRIVY_CLUSTERS.has(db.profile.id);
}

const GROUP = 'aquasecurity.github.io';
const API = `${GROUP}/v1alpha1`;
const SCANNER = { name: 'Trivy', vendor: 'Aqua Security', version: '0.58.2' };

// ---------------------------------------------------------------------------
// CRDs
// ---------------------------------------------------------------------------

function crd(kind: string, plural: string, namespaced: boolean, shortNames: string[]): CrdInput {
  return {
    group: GROUP,
    kind,
    plural,
    singular: kind.toLowerCase(),
    shortNames,
    scope: namespaced ? 'Namespaced' : 'Cluster',
    versions: ['v1alpha1'],
    categories: ['all'],
    age: 60 * DAY,
  };
}

export function trivyCrds(db: ClusterDb): CrdInput[] {
  if (!hasTrivy(db)) return [];
  return [
    crd('VulnerabilityReport', 'vulnerabilityreports', true, ['vuln', 'vulns']),
    crd('ClusterVulnerabilityReport', 'clustervulnerabilityreports', false, ['clustervuln']),
    crd('ConfigAuditReport', 'configauditreports', true, ['configaudit', 'configaudits']),
    crd('ClusterConfigAuditReport', 'clusterconfigauditreports', false, ['clusterconfigaudit']),
    crd('ExposedSecretReport', 'exposedsecretreports', true, ['exposedsecret', 'exposedsecrets']),
    crd('RbacAssessmentReport', 'rbacassessmentreports', true, ['rbacassessment']),
    crd('ClusterRbacAssessmentReport', 'clusterrbacassessmentreports', false, [
      'clusterrbacassessment',
    ]),
    crd('InfraAssessmentReport', 'infraassessmentreports', true, ['infraassessment']),
    crd('ClusterInfraAssessmentReport', 'clusterinfraassessmentreports', false, [
      'clusterinfraassessment',
    ]),
    crd('ClusterComplianceReport', 'clustercompliancereports', false, ['compliance']),
    crd('SbomReport', 'sbomreports', true, ['sbom', 'sboms']),
    crd('ClusterSbomReport', 'clustersbomreports', false, ['clustersbom']),
  ];
}

// ---------------------------------------------------------------------------
// Vulnerability catalog
// ---------------------------------------------------------------------------

type Sev = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
/** [id, package, installed, fixed, severity, title, score] */
type Cve = [string, string, string, string, Sev, string, number];

const GO: Cve[] = [
  [
    'CVE-2023-44487',
    'golang.org/x/net',
    'v0.15.0',
    '0.17.0',
    'HIGH',
    'HTTP/2 rapid reset can make a server do excessive work',
    7.5,
  ],
  [
    'CVE-2023-39325',
    'golang.org/x/net',
    'v0.15.0',
    '0.17.0',
    'HIGH',
    'HTTP/2 stream resets can exhaust server resources',
    7.5,
  ],
  [
    'CVE-2024-45337',
    'golang.org/x/crypto',
    'v0.21.0',
    '0.31.0',
    'CRITICAL',
    'Misuse of PublicKeyCallback may lead to an authorization bypass',
    9.1,
  ],
  [
    'CVE-2024-24790',
    'stdlib',
    'v1.21.8',
    '1.21.11, 1.22.4',
    'CRITICAL',
    'net/netip: IPv4-mapped IPv6 addresses misclassified',
    9.8,
  ],
  [
    'CVE-2024-34156',
    'stdlib',
    'v1.21.8',
    '1.22.7, 1.23.1',
    'HIGH',
    'encoding/gob: stack exhaustion on deeply nested input',
    7.5,
  ],
  [
    'CVE-2024-24791',
    'stdlib',
    'v1.21.8',
    '1.21.12, 1.22.5',
    'MEDIUM',
    'net/http: denial of service through Expect: 100-continue',
    5.9,
  ],
  [
    'CVE-2023-45288',
    'golang.org/x/net',
    'v0.17.0',
    '0.23.0',
    'MEDIUM',
    'HTTP/2 CONTINUATION frames can exhaust memory',
    5.3,
  ],
  [
    'CVE-2024-28180',
    'github.com/go-jose/go-jose/v3',
    'v3.0.1',
    '3.0.3',
    'MEDIUM',
    'Decompression bomb when decrypting JWE',
    4.3,
  ],
  [
    'CVE-2025-22868',
    'golang.org/x/oauth2',
    'v0.15.0',
    '0.27.0',
    'HIGH',
    'Malformed tokens can cause unexpected memory use',
    7.5,
  ],
  [
    'CVE-2024-21626',
    'github.com/opencontainers/runc',
    'v1.1.5',
    '1.1.12',
    'HIGH',
    'Leaked file descriptors allow a container breakout',
    8.6,
  ],
  [
    'CVE-2025-27144',
    'github.com/go-jose/go-jose/v4',
    'v4.0.1',
    '4.0.5',
    'MEDIUM',
    'Excessive memory use when parsing compact JWS',
    6.6,
  ],
];

const DEBIAN: Cve[] = [
  [
    'CVE-2023-4911',
    'libc6',
    '2.36-9',
    '2.36-9+deb12u3',
    'HIGH',
    'Buffer overflow in the dynamic loader via GLIBC_TUNABLES',
    7.8,
  ],
  [
    'CVE-2024-2961',
    'libc6',
    '2.36-9',
    '2.36-9+deb12u7',
    'HIGH',
    'Out-of-bounds write in iconv ISO-2022-CN-EXT',
    7.3,
  ],
  [
    'CVE-2023-38545',
    'curl',
    '7.88.1-10',
    '7.88.1-10+deb12u4',
    'CRITICAL',
    'Heap overflow in the SOCKS5 proxy handshake',
    9.8,
  ],
  [
    'CVE-2023-38546',
    'libcurl4',
    '7.88.1-10',
    '7.88.1-10+deb12u4',
    'LOW',
    'Cookie injection when duplicating easy handles',
    3.7,
  ],
  [
    'CVE-2024-6387',
    'openssh-client',
    '1:9.2p1-2',
    '1:9.2p1-2+deb12u3',
    'HIGH',
    'Signal handler race in sshd (regreSSHion)',
    8.1,
  ],
  [
    'CVE-2023-5363',
    'libssl3',
    '3.0.11-1',
    '3.0.11-1~deb12u2',
    'HIGH',
    'Key and IV lengths processed incorrectly',
    7.5,
  ],
  [
    'CVE-2024-5535',
    'libssl3',
    '3.0.11-1',
    '3.0.14-1~deb12u1',
    'CRITICAL',
    'Buffer over-read in SSL_select_next_proto',
    9.1,
  ],
  [
    'CVE-2023-45853',
    'zlib1g',
    '1:1.2.13.dfsg-1',
    '',
    'CRITICAL',
    'Integer overflow in minizip zipOpenNewFileInZip4_64',
    9.8,
  ],
  [
    'CVE-2023-52425',
    'libexpat1',
    '2.5.0-1',
    '2.5.0-1+deb12u1',
    'HIGH',
    'Denial of service with very large tokens',
    7.5,
  ],
  [
    'CVE-2024-45490',
    'libexpat1',
    '2.5.0-1',
    '2.5.0-1+deb12u1',
    'CRITICAL',
    'Negative length passed to XML_ParseBuffer',
    9.8,
  ],
  [
    'CVE-2023-29491',
    'ncurses-base',
    '6.4-4',
    '',
    'MEDIUM',
    'Memory corruption through malformed terminfo data',
    7.8,
  ],
  [
    'CVE-2022-4899',
    'libzstd1',
    '1.5.4+dfsg2-5',
    '',
    'LOW',
    'Buffer overrun with empty string arguments',
    7.5,
  ],
  [
    'CVE-2023-31484',
    'perl-base',
    '5.36.0-7',
    '5.36.0-7+deb12u1',
    'HIGH',
    'CPAN.pm does not verify TLS certificates',
    8.1,
  ],
  ['CVE-2011-3374', 'apt', '2.6.1', '', 'LOW', 'Weak key validation in apt-key', 3.7],
  [
    'CVE-2022-0563',
    'util-linux',
    '2.38.1-5',
    '',
    'LOW',
    'Partial file disclosure through chfn and chsh',
    5.5,
  ],
  [
    'CVE-2024-26461',
    'libkrb5-3',
    '1.20.1-2',
    '',
    'MEDIUM',
    'Memory leak in GSS message token handling',
    5.7,
  ],
  ['CVE-2023-50495', 'ncurses-bin', '6.4-4', '', 'MEDIUM', 'Crash through _nc_wrap_entry', 6.5],
  [
    'CVE-2023-4641',
    'passwd',
    '1:4.13+dfsg1-1',
    '',
    'MEDIUM',
    'gpasswd may leak the password to memory',
    4.7,
  ],
];

const ALPINE: Cve[] = [
  [
    'CVE-2022-48174',
    'busybox',
    '1.36.0-r0',
    '1.36.1-r1',
    'CRITICAL',
    'Stack overflow in the ash shell',
    9.8,
  ],
  ['CVE-2023-42363', 'busybox', '1.36.0-r0', '1.36.1-r4', 'MEDIUM', 'Use-after-free in awk', 5.5],
  [
    'CVE-2023-42364',
    'busybox',
    '1.36.0-r0',
    '1.36.1-r6',
    'MEDIUM',
    'Use-after-free in awk expression evaluation',
    5.5,
  ],
  [
    'CVE-2024-4741',
    'libcrypto3',
    '3.1.4-r5',
    '3.1.5-r0',
    'HIGH',
    'Use after free in SSL_free_buffers',
    7.5,
  ],
  [
    'CVE-2024-0727',
    'libssl3',
    '3.1.4-r2',
    '3.1.4-r5',
    'MEDIUM',
    'NULL dereference with malformed PKCS12 files',
    5.5,
  ],
  [
    'CVE-2023-6237',
    'libcrypto3',
    '3.1.4-r2',
    '3.1.4-r4',
    'MEDIUM',
    'Slow checks of invalid RSA public keys',
    5.9,
  ],
  [
    'CVE-2024-9143',
    'libcrypto3',
    '3.1.4-r5',
    '3.1.7-r1',
    'LOW',
    'Out-of-bounds access in GF(2^m) curve APIs',
    4.3,
  ],
  [
    'CVE-2024-28182',
    'nghttp2-libs',
    '1.57.0-r0',
    '1.58.0-r0',
    'MEDIUM',
    'Unbounded CONTINUATION frames exhaust CPU',
    5.3,
  ],
];

const NODE: Cve[] = [
  [
    'CVE-2024-21538',
    'cross-spawn',
    '7.0.3',
    '7.0.5, 6.0.6',
    'HIGH',
    'Regular expression denial of service',
    7.5,
  ],
  [
    'CVE-2024-4068',
    'braces',
    '3.0.2',
    '3.0.3',
    'HIGH',
    'Uncontrolled resource consumption with unbalanced braces',
    7.5,
  ],
  [
    'CVE-2024-37890',
    'ws',
    '8.13.0',
    '8.17.1',
    'HIGH',
    'Denial of service with many HTTP headers',
    7.5,
  ],
  [
    'CVE-2024-29041',
    'express',
    '4.18.2',
    '4.19.2',
    'MEDIUM',
    'Open redirect with malformed URLs',
    6.1,
  ],
  [
    'CVE-2023-26136',
    'tough-cookie',
    '4.1.2',
    '4.1.3',
    'MEDIUM',
    'Prototype pollution in cookie jars',
    6.5,
  ],
  [
    'CVE-2024-45296',
    'path-to-regexp',
    '0.1.7',
    '0.1.10',
    'HIGH',
    'Backtracking regular expressions cause ReDoS',
    7.5,
  ],
];

const JAVA: Cve[] = [
  [
    'CVE-2021-44228',
    'org.apache.logging.log4j:log4j-core',
    '2.14.1',
    '2.15.0',
    'CRITICAL',
    'Remote code execution through JNDI lookups (Log4Shell)',
    10,
  ],
  [
    'CVE-2021-45046',
    'org.apache.logging.log4j:log4j-core',
    '2.14.1',
    '2.16.0',
    'CRITICAL',
    'Incomplete Log4Shell fix in some configurations',
    9,
  ],
  [
    'CVE-2022-22965',
    'org.springframework:spring-beans',
    '5.3.15',
    '5.3.18',
    'CRITICAL',
    'Remote code execution through data binding (Spring4Shell)',
    9.8,
  ],
  [
    'CVE-2024-22259',
    'org.springframework:spring-web',
    '5.3.15',
    '5.3.33',
    'HIGH',
    'Host validation bypass in URL parsing',
    8.1,
  ],
  [
    'CVE-2023-34462',
    'io.netty:netty-handler',
    '4.1.86.Final',
    '4.1.94.Final',
    'MEDIUM',
    'SniHandler may allocate up to 16 MB of heap',
    6.5,
  ],
  [
    'CVE-2022-42003',
    'com.fasterxml.jackson.core:jackson-databind',
    '2.13.1',
    '2.13.4.2',
    'HIGH',
    'Resource exhaustion with deeply nested arrays',
    7.5,
  ],
];

const MODERN_JAVA: Cve[] = [
  [
    'CVE-2024-22259',
    'org.springframework:spring-web',
    '6.1.4',
    '6.1.5',
    'HIGH',
    'Host validation bypass in URL parsing',
    8.1,
  ],
  [
    'CVE-2023-34462',
    'io.netty:netty-handler',
    '4.1.86.Final',
    '4.1.94.Final',
    'MEDIUM',
    'SniHandler may allocate up to 16 MB of heap',
    6.5,
  ],
  [
    'CVE-2024-38808',
    'org.springframework:spring-expression',
    '6.1.4',
    '6.1.12',
    'MEDIUM',
    'Denial of service through crafted SpEL expressions',
    4.3,
  ],
];

const PYTHON: Cve[] = [
  [
    'CVE-2022-40897',
    'setuptools',
    '58.1.0',
    '65.5.1',
    'MEDIUM',
    'Regular expression denial of service in package_index',
    5.9,
  ],
  [
    'CVE-2024-6345',
    'setuptools',
    '58.1.0',
    '70.0.0',
    'HIGH',
    'Remote code execution in package_index download functions',
    8.8,
  ],
  [
    'CVE-2024-35195',
    'requests',
    '2.31.0',
    '2.32.0',
    'MEDIUM',
    'verify=False persists for the whole session',
    5.6,
  ],
  [
    'CVE-2023-43804',
    'urllib3',
    '1.26.16',
    '1.26.17, 2.0.6',
    'MEDIUM',
    'Cookie header kept on cross-origin redirects',
    8.1,
  ],
];

interface ImageProfile {
  os: { family: string; name: string } | null;
  catalogs: Cve[][];
  /** Share (0–100) of catalog entries the image carries. */
  share: number;
}

function profileOf(image: string): ImageProfile {
  const img = image.toLowerCase();
  const old = /:latest$|nginx:1\.21|legacy|:[0-9]+\.[0-9]+$/.test(img) || !img.includes(':');
  if (img.includes('legacy-shop'))
    return { os: { family: 'debian', name: '11.6' }, catalogs: [DEBIAN, JAVA], share: 85 };
  if (img.includes('payment-api') || img.includes('keycloak'))
    return { os: { family: 'debian', name: '12.4' }, catalogs: [DEBIAN, MODERN_JAVA], share: 40 };
  if (/storefront|checkout-web|image-resizer|cart-service/.test(img))
    return { os: { family: 'debian', name: '12.5' }, catalogs: [DEBIAN, NODE], share: 45 };
  if (/etl-worker|report-generator|metrics-rollup|order-sync/.test(img))
    return { os: { family: 'debian', name: '12.5' }, catalogs: [DEBIAN, PYTHON], share: 50 };
  if (/busybox|alpine/.test(img))
    return { os: { family: 'alpine', name: '3.18.4' }, catalogs: [ALPINE], share: old ? 90 : 60 };
  if (/bitnami|debian|postgres|nginx|redis|mysql|wordpress/.test(img))
    return { os: { family: 'debian', name: '12.8' }, catalogs: [DEBIAN], share: old ? 80 : 45 };
  return { os: null, catalogs: [GO], share: img.startsWith('registry.k8s.io') ? 30 : 45 };
}

function splitRef(image: string): { registry: string; repository: string; tag: string } {
  const at = image.indexOf('@');
  const base = at >= 0 ? image.slice(0, at) : image;
  const m = /^(.*?)(?::([^/:]+))?$/.exec(base);
  const name = m?.[1] ?? base;
  const tag = at >= 0 ? '' : (m?.[2] ?? 'latest');
  const parts = name.split('/');
  const hasRegistry = parts.length > 1 && /[.:]/.test(parts[0]!);
  const registry = hasRegistry ? parts[0]! : 'index.docker.io';
  let repository = hasRegistry ? parts.slice(1).join('/') : name;
  if (!hasRegistry && !repository.includes('/')) repository = `library/${repository}`;
  return { registry, repository, tag };
}

function digestOf(image: string): string {
  let hex = '';
  for (let i = 0; hex.length < 64; i++)
    hex += hashString(`${image}#${i}`).toString(16).padStart(8, '0');
  return `sha256:${hex.slice(0, 64)}`;
}

interface Vuln {
  vulnerabilityID: string;
  resource: string;
  installedVersion: string;
  fixedVersion: string;
  severity: Sev;
  title: string;
  score: number;
  primaryLink: string;
  links: string[];
  target: string;
  publishedDate: string;
  lastModifiedDate: string;
}

function vulnsOf(image: string): Vuln[] {
  const p = profileOf(image);
  const out: Vuln[] = [];
  for (const catalog of p.catalogs)
    for (const [id, pkg, installed, fixed, severity, title, score] of catalog) {
      if (hashString(`${image}|${id}`) % 100 >= p.share) continue;
      const year = Number(id.slice(4, 8));
      out.push({
        vulnerabilityID: id,
        resource: pkg,
        installedVersion: installed,
        fixedVersion: fixed,
        severity,
        title,
        score,
        primaryLink: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
        links: [`https://nvd.nist.gov/vuln/detail/${id}`],
        target:
          catalog === GO
            ? 'usr/local/bin/app'
            : catalog === DEBIAN || catalog === ALPINE
              ? `${image} (${p.os?.family ?? 'linux'})`
              : 'app',
        publishedDate: `${year}-0${1 + (hashString(id) % 9)}-1${hashString(id) % 9}T00:00:00Z`,
        lastModifiedDate: `${Math.min(2026, year + 1)}-02-01T00:00:00Z`,
      });
    }
  return out;
}

function summary(counts: Record<Sev, number>) {
  return {
    criticalCount: counts.CRITICAL,
    highCount: counts.HIGH,
    mediumCount: counts.MEDIUM,
    lowCount: counts.LOW,
    unknownCount: counts.UNKNOWN,
  };
}

function countSev<T extends { severity: Sev }>(items: readonly T[]): Record<Sev, number> {
  const c: Record<Sev, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const i of items) c[i.severity]++;
  return c;
}

// ---------------------------------------------------------------------------
// Scanned objects
// ---------------------------------------------------------------------------

interface Target {
  owner: KubeObject;
  kind: string;
  name: string;
  namespace: string;
  containers: Array<{ name: string; image: string }>;
  spec: Record<string, unknown>;
}

function templateSpec(o: KubeObject): Record<string, unknown> | null {
  const spec = o.spec as Record<string, unknown> | undefined;
  if (!spec) return null;
  if (o.kind === 'Pod') return spec;
  if (o.kind === 'CronJob')
    return (
      (
        ((spec.jobTemplate as Record<string, unknown>)?.spec as Record<string, unknown>)
          ?.template as {
          spec?: Record<string, unknown>;
        }
      )?.spec ?? null
    );
  return (spec.template as { spec?: Record<string, unknown> } | undefined)?.spec ?? null;
}

function targets(db: ClusterDb): Target[] {
  const out: Target[] = [];
  const add = (o: KubeObject) => {
    const spec = templateSpec(o);
    if (!spec || !o.metadata.namespace) return;
    const containers = [
      ...((spec.initContainers as Array<{ name: string; image: string }>) ?? []),
      ...((spec.containers as Array<{ name: string; image: string }>) ?? []),
    ].map((c) => ({ name: c.name, image: c.image }));
    out.push({
      owner: o,
      kind: o.kind,
      name: o.metadata.name,
      namespace: o.metadata.namespace,
      containers,
      spec,
    });
  };
  // Trivy scans the current ReplicaSet of a Deployment, not the Deployment.
  for (const rs of list(db, 'replicasets.apps')) if (Number(rs.spec?.replicas ?? 0) > 0) add(rs);
  for (const key of ['statefulsets.apps', 'daemonsets.apps', 'cronjobs.batch'])
    for (const o of list(db, key)) add(o);
  for (const job of list(db, 'jobs.batch')) if (!job.metadata.ownerReferences?.length) add(job);
  for (const pod of list(db, 'pods')) if (!pod.metadata.ownerReferences?.length) add(pod);
  return out;
}

function ownerRef(o: KubeObject) {
  return [
    {
      apiVersion: o.apiVersion,
      kind: o.kind,
      name: o.metadata.name,
      uid: o.metadata.uid,
      controller: true,
    },
  ];
}

function labelsFor(t: Pick<Target, 'kind' | 'name' | 'namespace'>, container?: string) {
  return {
    'trivy-operator.resource.kind': t.kind,
    'trivy-operator.resource.name': t.name,
    'trivy-operator.resource.namespace': t.namespace,
    ...(container ? { 'trivy-operator.container.name': container } : {}),
    'resource-spec-hash': (hashString(`${t.kind}/${t.name}`) % 0xffffffff).toString(16),
  };
}

function reportName(kind: string, name: string, container?: string) {
  const base = `${kind.toLowerCase()}-${name}${container ? `-${container}` : ''}`;
  return base.length > 63
    ? `${base.slice(0, 54)}-${hashString(base).toString(16).slice(0, 8)}`
    : base;
}

// ---------------------------------------------------------------------------
// Config audit checks (evaluated on the pod template)
// ---------------------------------------------------------------------------

interface Check {
  checkID: string;
  title: string;
  description: string;
  severity: Sev;
  category: string;
  success: boolean;
  messages: string[];
  remediation: string;
}

type Sc = Record<string, unknown>;

function auditChecks(t: Target): Check[] {
  const spec = t.spec;
  const podSc = (spec.securityContext as Sc) ?? {};
  const containers = [
    ...((spec.initContainers as Sc[]) ?? []),
    ...((spec.containers as Sc[]) ?? []),
  ];
  const sc = (c: Sc) => (c.securityContext as Sc) ?? {};
  const res = (c: Sc) => (c.resources as { requests?: Sc; limits?: Sc }) ?? {};
  const where = (c: Sc) => `Container '${String(c.name)}' of ${t.kind} '${t.name}'`;
  const category = 'Kubernetes Security Check';
  const check = (
    id: string,
    title: string,
    severity: Sev,
    description: string,
    remediation: string,
    failing: Sc[],
    message: (c: Sc) => string,
  ): Check => ({
    checkID: id,
    title,
    description,
    severity,
    category,
    success: failing.length === 0,
    messages: failing.map(message),
    remediation,
  });
  const podLevel = (
    id: string,
    title: string,
    severity: Sev,
    description: string,
    remediation: string,
    fail: boolean,
    message: string,
  ): Check => ({
    checkID: id,
    title,
    description,
    severity,
    category,
    success: !fail,
    messages: fail ? [message] : [],
    remediation,
  });
  const volumes = (spec.volumes as Sc[]) ?? [];
  return [
    check(
      'KSV001',
      'Process can elevate its own privileges',
      'MEDIUM',
      'A program inside the container can elevate its own privileges and run as root, which might give it control over the container and node.',
      "Set 'set containers[].securityContext.allowPrivilegeEscalation' to 'false'.",
      containers.filter((c) => sc(c).allowPrivilegeEscalation !== false),
      (c) => `${where(c)} should set 'securityContext.allowPrivilegeEscalation' to false`,
    ),
    check(
      'KSV003',
      'Default capabilities not dropped',
      'LOW',
      'The container should drop all default capabilities and add only those that are needed for its execution.',
      "Add 'ALL' to containers[].securityContext.capabilities.drop.",
      containers.filter(
        (c) => !(((sc(c).capabilities as Sc)?.drop as string[]) ?? []).includes('ALL'),
      ),
      (c) => `${where(c)} should add 'ALL' to 'securityContext.capabilities.drop'`,
    ),
    check(
      'KSV011',
      'CPU not limited',
      'LOW',
      'Enforcing CPU limits prevents DoS via resource exhaustion.',
      "Set a limit value under 'containers[].resources.limits.cpu'.",
      containers.filter((c) => !res(c).limits?.cpu),
      (c) => `${where(c)} should set 'resources.limits.cpu'`,
    ),
    check(
      'KSV012',
      'Runs as root user',
      'MEDIUM',
      'Force the running image to run as a non-root user to ensure least privileges.',
      "Set 'containers[].securityContext.runAsNonRoot' to true.",
      podSc.runAsNonRoot === true
        ? containers.filter((c) => sc(c).runAsNonRoot === false)
        : containers.filter((c) => sc(c).runAsNonRoot !== true),
      (c) => `${where(c)} should set 'securityContext.runAsNonRoot' to true`,
    ),
    check(
      'KSV014',
      'Root file system is not read-only',
      'HIGH',
      'An immutable root file system prevents applications from writing to their local disk.',
      "Change 'containers[].securityContext.readOnlyRootFilesystem' to 'true'.",
      containers.filter((c) => sc(c).readOnlyRootFilesystem !== true),
      (c) => `${where(c)} should set 'securityContext.readOnlyRootFilesystem' to true`,
    ),
    check(
      'KSV015',
      'CPU requests not specified',
      'LOW',
      'When containers have resource requests specified, the scheduler can make better decisions about which nodes to place pods on.',
      "Set 'containers[].resources.requests.cpu'.",
      containers.filter((c) => !res(c).requests?.cpu && !res(c).limits?.cpu),
      (c) => `${where(c)} should set 'resources.requests.cpu'`,
    ),
    check(
      'KSV016',
      'Memory requests not specified',
      'LOW',
      'When containers have memory requests specified, the scheduler can make better decisions about which nodes to place pods on.',
      "Set 'containers[].resources.requests.memory'.",
      containers.filter((c) => !res(c).requests?.memory && !res(c).limits?.memory),
      (c) => `${where(c)} should set 'resources.requests.memory'`,
    ),
    check(
      'KSV017',
      'Privileged container',
      'HIGH',
      'Privileged containers share namespaces with the host system and do not offer any security.',
      "Change 'containers[].securityContext.privileged' to 'false'.",
      containers.filter((c) => sc(c).privileged === true),
      (c) => `${where(c)} should set 'securityContext.privileged' to false`,
    ),
    check(
      'KSV018',
      'Memory not limited',
      'LOW',
      'Enforcing memory limits prevents DoS via resource exhaustion.',
      "Set a limit value under 'containers[].resources.limits.memory'.",
      containers.filter((c) => !res(c).limits?.memory),
      (c) => `${where(c)} should set 'resources.limits.memory'`,
    ),
    check(
      'KSV020',
      'Runs with UID <= 10000',
      'LOW',
      'Force the container to run with user ID > 10000 to avoid conflicts with the host’s user table.',
      "Set 'containers[].securityContext.runAsUser' to an integer > 10000.",
      containers.filter((c) => Number(sc(c).runAsUser ?? podSc.runAsUser ?? 0) <= 10000),
      (c) => `${where(c)} should set 'securityContext.runAsUser' > 10000`,
    ),
    check(
      'KSV104',
      'Seccomp policies disabled',
      'MEDIUM',
      'A program inside the container can bypass Seccomp protection policies.',
      'Specify seccomp either by annotation or by seccomp profile type having allowed values as per pod security standards.',
      (podSc.seccompProfile as Sc)?.type
        ? []
        : containers.filter((c) => !(sc(c).seccompProfile as Sc)?.type),
      (c) => `${where(c)} should specify a seccomp profile`,
    ),
    check(
      'KSV023',
      'hostPath volumes mounted',
      'MEDIUM',
      'According to pod security standard "HostPath Volumes", HostPath volumes must be forbidden.',
      "Do not set 'spec.volumes[*].hostPath'.",
      volumes.filter((v) => v.hostPath),
      (v) =>
        `${t.kind} '${t.name}' should not set 'spec.template.volumes.hostPath' (volume '${String(v.name)}')`,
    ),
    podLevel(
      'KSV009',
      'Access to host network',
      'HIGH',
      'Sharing the host’s network namespace permits processes in the pod to communicate with processes bound to the host’s loopback adapter.',
      "Do not set 'spec.template.spec.hostNetwork' to true.",
      spec.hostNetwork === true,
      `${t.kind} '${t.name}' should not set 'spec.template.spec.hostNetwork' to true`,
    ),
    podLevel(
      'KSV010',
      'Access to host PID',
      'HIGH',
      'Sharing the host’s PID namespace allows visibility on host processes, potentially leaking information such as environment variables and configuration.',
      "Do not set 'spec.template.spec.hostPID' to true.",
      spec.hostPID === true,
      `${t.kind} '${t.name}' should not set 'spec.template.spec.hostPID' to true`,
    ),
    podLevel(
      'KSV110',
      'Workloads in the default namespace',
      'LOW',
      'Namespaces isolate resources; workloads in the default namespace are easy to overlook.',
      'Create the workload in a dedicated namespace.',
      t.namespace === 'default',
      `${t.kind} '${t.name}' should not be created in the 'default' namespace`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// RBAC assessment (derived from the role's risky grants)
// ---------------------------------------------------------------------------

function rbacChecks(role: RoleInfo, risks: Map<RiskId, number[]>): Check[] {
  const admin = risks.has('cluster-admin');
  const has = (r: RiskId) => admin || risks.has(r);
  const target = `${role.kind} '${role.name}'`;
  const c = (
    id: string,
    title: string,
    severity: Sev,
    fail: boolean,
    message: string,
    remediation: string,
  ): Check => ({
    checkID: id,
    title,
    description: title,
    severity,
    category: 'Kubernetes Security Check',
    success: !fail,
    messages: fail ? [message] : [],
    remediation,
  });
  return [
    c(
      'KSV041',
      'Do not allow management of secrets',
      'CRITICAL',
      has('secrets'),
      `${target} shouldn't have access to manage secrets`,
      "Manage secrets are not allowed. Remove resource 'secrets' from the role.",
    ),
    c(
      'KSV044',
      'No wildcard verb and resource roles',
      'CRITICAL',
      admin,
      `${target} shouldn't have access to manage all resources`,
      "Remove '*' from 'rules.verbs' and 'rules.resources'.",
    ),
    c(
      'KSV045',
      'No wildcard verb roles',
      'CRITICAL',
      has('wildcard'),
      `${target} shouldn't grant wildcard verbs`,
      "Create a role that specifies the verbs it needs instead of '*'.",
    ),
    c(
      'KSV046',
      'Do not allow management of all resources',
      'CRITICAL',
      admin,
      `${target} shouldn't manage all resources`,
      "Remove '*' from 'rules.resources'.",
    ),
    c(
      'KSV047',
      'Do not allow privilege escalation from node proxy',
      'HIGH',
      has('nodes-proxy'),
      `${target} should not have access to resource 'nodes/proxy' for verbs ["get", "create"]`,
      "Remove 'nodes/proxy' from the resources of the role.",
    ),
    c(
      'KSV048',
      'Do not allow update/create of a malicious pod',
      'MEDIUM',
      has('create-pods'),
      `${target} should not have access to resources ["pods", "deployments", "jobs", "cronjobs", "statefulsets", "daemonsets", "replicasets", "replicationcontrollers"] for verbs ["create", "update", "patch", "delete", "deletecollection", "impersonate", "*"]`,
      'Create a role that does not grant the creation of workloads.',
    ),
    c(
      'KSV050',
      'Do not allow management of RBAC resources',
      'CRITICAL',
      has('escalate') || has('bind'),
      `${target} should not have access to resources ["roles", "rolebindings"] for verbs ["create", "update", "patch", "delete", "deletecollection", "impersonate", "*"]`,
      'Remove write permission verbs for RBAC resources.',
    ),
    c(
      'KSV043',
      'Do not allow impersonation of privileged groups',
      'CRITICAL',
      has('impersonate'),
      `${target} should not have access to resource 'groups' for verb 'impersonate'`,
      "Remove 'impersonate' from the verbs of the role.",
    ),
    c(
      'KSV053',
      'Do not allow getting shell on pods',
      'HIGH',
      has('exec'),
      `${target} should not have access to resource 'pods/exec' for verbs ["create", "update", "patch", "delete", "deletecollection", "impersonate", "*"]`,
      "Remove 'pods/exec' from the resources of the role.",
    ),
  ];
}

// ---------------------------------------------------------------------------
// Exposed secrets (the `match` line is redacted by Trivy; the UI never shows it)
// ---------------------------------------------------------------------------

const SECRET_FINDINGS: Array<
  [
    RegExp,
    Array<{
      target: string;
      ruleID: string;
      title: string;
      category: string;
      severity: Sev;
      match: string;
    }>,
  ]
> = [
  [
    /legacy-shop/,
    [
      {
        target: '/app/config/application.properties',
        ruleID: 'aws-access-key-id',
        title: 'AWS Access Key ID',
        category: 'AWS',
        severity: 'CRITICAL',
        match: 'aws.accessKeyId=********************',
      },
      {
        target: '/app/keys/server.key',
        ruleID: 'private-key',
        title: 'Asymmetric Private Key',
        category: 'AsymmetricPrivateKey',
        severity: 'HIGH',
        match: '-----BEGIN RSA PRIVATE KEY-----*****',
      },
    ],
  ],
  [
    /report-generator/,
    [
      {
        target: '/root/.git-credentials',
        ruleID: 'github-pat',
        title: 'GitHub Personal Access Token',
        category: 'GitHub',
        severity: 'CRITICAL',
        match: 'https://acme-ci:****************************************@github.com',
      },
    ],
  ],
  [
    /image-resizer/,
    [
      {
        target: '/app/.env',
        ruleID: 'slack-web-hook',
        title: 'Slack Webhook',
        category: 'Slack',
        severity: 'MEDIUM',
        match: 'SLACK_WEBHOOK=https://hooks.slack.com/services/*****************',
      },
    ],
  ],
];

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildTrivy(db: ClusterDb) {
  if (!hasTrivy(db)) return;
  const scanned = targets(db);
  const failedAudit = new Map<string, number>();
  const updated = (seed: string) =>
    ago(((hashString(seed) % 20) + 1) * HOUR + (hashString(seed) % 50) * MIN);

  for (const t of scanned) {
    for (const c of t.containers) {
      const ref = splitRef(c.image);
      const image = c.image;
      const vulns = vulnsOf(image);
      const counts = countSev(vulns);
      const profile = profileOf(image);
      put(
        db,
        obj(
          API,
          'VulnerabilityReport',
          {
            ...meta({
              name: reportName(t.kind, t.name, c.name),
              namespace: t.namespace,
              age: 3 * DAY,
              labels: labelsFor(t, c.name),
            }),
            ownerReferences: ownerRef(t.owner),
          },
          {
            report: {
              updateTimestamp: updated(image + t.name),
              scanner: SCANNER,
              registry: { server: ref.registry },
              artifact: { repository: ref.repository, tag: ref.tag, digest: digestOf(image) },
              ...(profile.os ? { os: profile.os } : {}),
              summary: { ...summary(counts), noneCount: 0 },
              vulnerabilities: vulns,
            },
          },
        ),
      );
      for (const [pattern, findings] of SECRET_FINDINGS) {
        if (!pattern.test(image)) continue;
        put(
          db,
          obj(
            API,
            'ExposedSecretReport',
            {
              ...meta({
                name: reportName(t.kind, t.name, c.name),
                namespace: t.namespace,
                age: 3 * DAY,
                labels: labelsFor(t, c.name),
              }),
              ownerReferences: ownerRef(t.owner),
            },
            {
              report: {
                updateTimestamp: updated(`secret|${image}`),
                scanner: SCANNER,
                registry: { server: ref.registry },
                artifact: { repository: ref.repository, tag: ref.tag, digest: digestOf(image) },
                summary: summary(countSev(findings)),
                secrets: findings,
              },
            },
          ),
        );
      }
    }
    const checks = auditChecks(t);
    for (const ch of checks)
      if (!ch.success) failedAudit.set(ch.checkID, (failedAudit.get(ch.checkID) ?? 0) + 1);
    put(
      db,
      obj(
        API,
        'ConfigAuditReport',
        {
          ...meta({
            name: reportName(t.kind, t.name),
            namespace: t.namespace,
            age: 3 * DAY,
            labels: labelsFor(t),
          }),
          ownerReferences: ownerRef(t.owner),
        },
        {
          report: {
            updateTimestamp: updated(`audit|${t.name}`),
            scanner: SCANNER,
            summary: summary(countSev(checks.filter((x) => !x.success))),
            checks,
          },
        },
      ),
    );
  }

  // SBOMs of the team's own images.
  for (const t of scanned)
    for (const c of t.containers) {
      if (!c.image.includes('ghcr.io/acme/')) continue;
      const ref = splitRef(c.image);
      const components = vulnsOf(c.image)
        .filter((v, i, all) => all.findIndex((x) => x.resource === v.resource) === i)
        .map((v) => ({
          'bom-ref': `pkg:generic/${v.resource}@${v.installedVersion}`,
          type: 'library',
          name: v.resource,
          version: v.installedVersion,
          purl: `pkg:generic/${v.resource}@${v.installedVersion}`,
          licenses: [{ license: { id: hashString(v.resource) % 3 ? 'Apache-2.0' : 'MIT' } }],
        }));
      put(
        db,
        obj(
          API,
          'SbomReport',
          {
            ...meta({
              name: reportName(t.kind, t.name, c.name),
              namespace: t.namespace,
              age: 3 * DAY,
              labels: labelsFor(t, c.name),
            }),
            ownerReferences: ownerRef(t.owner),
          },
          {
            report: {
              updateTimestamp: updated(`sbom|${c.image}`),
              scanner: SCANNER,
              registry: { server: ref.registry },
              artifact: { repository: ref.repository, tag: ref.tag, digest: digestOf(c.image) },
              summary: {
                componentsCount: components.length,
                dependenciesCount: Math.max(0, components.length - 1),
              },
              components: {
                bomFormat: 'CycloneDX',
                specVersion: '1.5',
                version: 1,
                components,
              },
            },
          },
        ),
      );
    }

  // RBAC assessments of roles with risky grants.
  const index = buildRbacIndex({
    roles: list(db, 'roles.rbac.authorization.k8s.io'),
    clusterRoles: list(db, 'clusterroles.rbac.authorization.k8s.io'),
    roleBindings: [],
    clusterRoleBindings: [],
  });
  const assess = (role: RoleInfo, source: KubeObject) => {
    const risks = roleRisks(role, role.kind === 'ClusterRole' ? 'cluster' : 'namespace');
    const checks = rbacChecks(role, risks);
    const t = { kind: role.kind, name: role.name, namespace: role.namespace ?? '' };
    const labels = labelsFor(t);
    if (!role.namespace)
      delete (labels as Record<string, string>)['trivy-operator.resource.namespace'];
    put(
      db,
      obj(
        API,
        role.kind === 'Role' ? 'RbacAssessmentReport' : 'ClusterRbacAssessmentReport',
        {
          ...meta({
            name: reportName(role.kind, role.name.replace(/:/g, '-')),
            namespace: role.namespace,
            age: 3 * DAY,
            labels,
          }),
          ownerReferences: ownerRef(source),
        },
        {
          report: {
            updateTimestamp: updated(`rbac|${role.name}`),
            scanner: SCANNER,
            summary: summary(countSev(checks.filter((x) => !x.success))),
            checks,
          },
        },
      ),
    );
  };
  for (const r of list(db, 'clusterroles.rbac.authorization.k8s.io')) {
    const info = index.clusterRoles.get(r.metadata.name);
    if (info && !info.name.startsWith('system:')) assess(info, r);
  }
  for (const r of list(db, 'roles.rbac.authorization.k8s.io')) {
    const info = index.roles.get(`${r.metadata.namespace}/${r.metadata.name}`);
    if (info) assess(info, r);
  }

  // Node infrastructure assessments (kubelet configuration).
  list(db, 'nodes')
    .slice(0, 6)
    .forEach((node, i) => {
      const fail = (n: number) => (hashString(`${node.metadata.name}|${n}`) + i) % 5 === 0;
      const checks: Check[] = [
        ['KCV0079', 'Ensure that the --anonymous-auth argument is set to false', 'CRITICAL'],
        [
          'KCV0080',
          'Ensure that the --authorization-mode argument is not set to AlwaysAllow',
          'CRITICAL',
        ],
        ['KCV0082', 'Ensure that the --read-only-port argument is set to 0', 'HIGH'],
        [
          'KCV0083',
          'Ensure that the --streaming-connection-idle-timeout argument is not set to 0',
          'HIGH',
        ],
        ['KCV0086', 'Ensure that the --rotate-certificates argument is not set to false', 'HIGH'],
        [
          'KCV0088',
          'Ensure that the kubelet only makes use of strong cryptographic ciphers',
          'CRITICAL',
        ],
      ].map(([id, title, severity], n) => ({
        checkID: id!,
        title: title!,
        description: title!,
        severity: severity as Sev,
        category: 'Kubernetes Security Check',
        success: !(n >= 2 && fail(n)),
        messages: n >= 2 && fail(n) ? [`Node '${node.metadata.name}': ${title}`] : [],
        remediation: 'Edit the kubelet configuration file on the node and restart the kubelet.',
      }));
      put(
        db,
        obj(
          API,
          'ClusterInfraAssessmentReport',
          {
            ...meta({
              name: `node-${node.metadata.name}`,
              age: 5 * DAY,
              labels: {
                'trivy-operator.resource.kind': 'Node',
                'trivy-operator.resource.name': node.metadata.name,
              },
            }),
            ownerReferences: ownerRef(node),
          },
          {
            report: {
              updateTimestamp: updated(`infra|${node.metadata.name}`),
              scanner: SCANNER,
              summary: summary(countSev(checks.filter((x) => !x.success))),
              checks,
            },
          },
        ),
      );
    });

  // Compliance reports summarising the audits above.
  const fails = (...ids: string[]) => ids.reduce((s, id) => s + (failedAudit.get(id) ?? 0), 0);
  const compliance = (
    name: string,
    title: string,
    version: string,
    description: string,
    controls: Array<[string, string, Sev, number]>,
  ) => {
    const failCount = controls.filter(([, , , n]) => n > 0).length;
    put(
      db,
      obj(
        API,
        'ClusterComplianceReport',
        meta({ name, age: 30 * DAY, labels: { 'app.kubernetes.io/managed-by': 'trivy-operator' } }),
        {
          spec: {
            cron: '0 */6 * * *',
            reportType: 'summary',
            compliance: {
              id: name,
              title,
              version,
              description,
              platform: 'k8s',
              type: name.includes('cis') ? 'cis' : name.includes('nsa') ? 'nsa' : 'pss',
              relatedResources: [],
              controls: controls.map(([id, cname, severity]) => ({
                id,
                name: cname,
                description: cname,
                severity,
                checks: [],
              })),
            },
          },
          status: {
            updateTimestamp: updated(`compliance|${name}`),
            summary: { passCount: controls.length - failCount, failCount },
            summaryReport: {
              id: name,
              title,
              controlCheck: controls.map(([id, cname, severity, totalFail]) => ({
                id,
                name: cname,
                severity,
                totalFail,
              })),
            },
          },
        },
      ),
    );
  };
  compliance(
    'k8s-pss-baseline-0.1',
    'Kubernetes Pod Security Standards - Baseline',
    '0.1',
    'Kubernetes Pod Security Standards - Baseline',
    [
      ['1', 'HostProcess', 'HIGH', 0],
      ['2', 'Host Namespaces', 'HIGH', fails('KSV009', 'KSV010')],
      ['3', 'Privileged Containers', 'HIGH', fails('KSV017')],
      ['4', 'Capabilities', 'MEDIUM', 0],
      ['5', 'HostPath Volumes', 'MEDIUM', fails('KSV023')],
      ['6', 'host ports', 'HIGH', 0],
      ['7', 'AppArmor', 'HIGH', 0],
      ['8', 'SELinux', 'MEDIUM', 0],
      ['9', '/proc Mount Type', 'MEDIUM', 0],
      ['10', 'Seccomp', 'MEDIUM', 0],
      ['11', 'Sysctls', 'MEDIUM', 0],
    ],
  );
  compliance(
    'k8s-pss-restricted-0.1',
    'Kubernetes Pod Security Standards - Restricted',
    '0.1',
    'Kubernetes Pod Security Standards - Restricted',
    [
      ['1', 'HostProcess', 'HIGH', 0],
      ['2', 'Host Namespaces', 'HIGH', fails('KSV009', 'KSV010')],
      ['3', 'Privileged Containers', 'HIGH', fails('KSV017')],
      ['12', 'Volume Types', 'LOW', fails('KSV023')],
      ['13', 'Privilege Escalation', 'MEDIUM', fails('KSV001')],
      ['14', 'Running as Non-root', 'MEDIUM', fails('KSV012')],
      ['15', 'Running as Non-root user', 'MEDIUM', fails('KSV020')],
      ['16', 'Seccomp', 'LOW', fails('KSV104')],
      ['17', 'Capabilities', 'LOW', fails('KSV003')],
    ],
  );
  compliance(
    'k8s-nsa-1.0',
    'National Security Agency - Kubernetes Hardening Guidance v1.0',
    '1.0',
    'National Security Agency - Kubernetes Hardening Guidance',
    [
      ['1.0', 'Non-root containers', 'MEDIUM', fails('KSV012')],
      ['1.1', 'Immutable container file systems', 'LOW', fails('KSV014')],
      ['1.2', 'Preventing privileged containers', 'HIGH', fails('KSV017')],
      ['1.3', 'Share containers process namespaces', 'HIGH', fails('KSV010')],
      ['1.5', 'Share host network namespaces', 'HIGH', fails('KSV009')],
      ['1.6', 'Run with root privileges or with root group membership', 'LOW', fails('KSV020')],
      ['1.7', 'Restricts escalation to root privileges', 'MEDIUM', fails('KSV001')],
      ['1.8', 'Sets the SELinux options', 'MEDIUM', 0],
      ['1.10', 'Seccomp policies', 'MEDIUM', fails('KSV104')],
      ['2.0', 'Pod and/or namespace selectors', 'MEDIUM', 0],
      ['4.0', 'Use CPU/memory limits', 'LOW', fails('KSV011', 'KSV018')],
    ],
  );
  compliance(
    'k8s-cis-1.23',
    'CIS Kubernetes Benchmarks v1.23',
    '1.23',
    'CIS Kubernetes Benchmarks',
    [
      ['5.1.1', 'Ensure that the cluster-admin role is only used where required', 'HIGH', 1],
      ['5.1.2', 'Minimize access to secrets', 'HIGH', 3],
      ['5.1.3', 'Minimize wildcard use in Roles and ClusterRoles', 'HIGH', 2],
      ['5.2.2', 'Minimize the admission of privileged containers', 'HIGH', fails('KSV017')],
      [
        '5.2.3',
        'Minimize the admission of containers wishing to share the host process ID namespace',
        'HIGH',
        fails('KSV010'),
      ],
      [
        '5.2.5',
        'Minimize the admission of containers wishing to share the host network namespace',
        'HIGH',
        fails('KSV009'),
      ],
      [
        '5.2.6',
        'Minimize the admission of containers with allowPrivilegeEscalation',
        'HIGH',
        fails('KSV001'),
      ],
      ['5.2.7', 'Minimize the admission of root containers', 'MEDIUM', fails('KSV012')],
      [
        '5.2.9',
        'Minimize the admission of containers with added capabilities',
        'LOW',
        fails('KSV003'),
      ],
      [
        '5.7.2',
        'Ensure that the seccomp profile is set to docker/default in your pod definitions',
        'MEDIUM',
        fails('KSV104'),
      ],
      ['5.7.4', 'The default namespace should not be used', 'MEDIUM', fails('KSV110')],
    ],
  );
}
