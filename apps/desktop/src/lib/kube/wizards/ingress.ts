import * as i18n from '@/i18n/core';
import type { KubeObject } from '@/types';
import { asArray, asNumber, asObject, asString, isObject, spec } from '../accessors';
import type { X509Certificate } from '../x509';
import { hostError, nameError, portNameError, portNumberError } from './validate';

/**
 * `kubectl create ingress`: hosts and paths to Service backends, an
 * IngressClass, TLS from an existing `kubernetes.io/tls` Secret or issued
 * by cert-manager, and optional ingress-nginx annotations.
 */

export type PathType = 'Prefix' | 'Exact' | 'ImplementationSpecific';
export const PATH_TYPES: readonly PathType[] = ['Prefix', 'Exact', 'ImplementationSpecific'];

export interface IngressPathDraft {
  path: string;
  pathType: PathType;
  service: string;
  /** Port number or port name of the Service. */
  port: string;
}

export interface IngressRuleDraft {
  host: string;
  paths: IngressPathDraft[];
}

export type TlsMode = 'none' | 'secret' | 'cert-manager';

export interface IngressTlsDraft {
  mode: TlsMode;
  /** Existing Secret (`secret`) or the Secret cert-manager writes (`cert-manager`). */
  secretName: string;
  issuerKind: 'ClusterIssuer' | 'Issuer';
  issuerName: string;
}

export interface IngressInput {
  name: string;
  namespace: string;
  /** Empty: no `ingressClassName` (the cluster default applies). */
  className: string;
  rules: IngressRuleDraft[];
  tls: IngressTlsDraft;
  /** Enabled optional annotations with their values. */
  annotations: Record<string, string>;
}

export function emptyPath(service = '', port = ''): IngressPathDraft {
  return { path: '/', pathType: 'Prefix', service, port };
}

export function ingressDefaults(
  namespace: string,
  service?: { name: string; port: string } | null,
): IngressInput {
  return {
    name: service?.name ?? '',
    namespace,
    className: '',
    rules: [{ host: '', paths: [emptyPath(service?.name ?? '', service?.port ?? '')] }],
    tls: { mode: 'none', secretName: '', issuerKind: 'ClusterIssuer', issuerName: '' },
    annotations: {},
  };
}

/** Hosts of every rule, deduplicated, empty ones left out. */
export function ruleHosts(input: IngressInput): string[] {
  return [...new Set(input.rules.map((r) => r.host.trim()).filter(Boolean))];
}

function backendPort(port: string): Record<string, unknown> {
  return /^\d+$/.test(port.trim()) ? { number: Number(port) } : { name: port.trim() };
}

export function buildIngress(input: IngressInput): Record<string, unknown> {
  const annotations: Record<string, string> = { ...input.annotations };
  if (input.tls.mode === 'cert-manager' && input.tls.issuerName.trim()) {
    const key =
      input.tls.issuerKind === 'ClusterIssuer'
        ? 'cert-manager.io/cluster-issuer'
        : 'cert-manager.io/issuer';
    annotations[key] = input.tls.issuerName.trim();
  }
  const hosts = ruleHosts(input);
  const tls =
    input.tls.mode !== 'none' && input.tls.secretName.trim()
      ? [{ ...(hosts.length ? { hosts } : {}), secretName: input.tls.secretName.trim() }]
      : [];
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      ...(Object.keys(annotations).length ? { annotations } : {}),
    },
    spec: {
      ...(input.className ? { ingressClassName: input.className } : {}),
      ...(tls.length ? { tls } : {}),
      rules: input.rules.map((rule) => ({
        ...(rule.host.trim() ? { host: rule.host.trim() } : {}),
        http: {
          paths: rule.paths.map((p) => ({
            path: p.path.trim() || '/',
            pathType: p.pathType,
            backend: { service: { name: p.service.trim(), port: backendPort(p.port) } },
          })),
        },
      })),
    },
  };
}

export interface IngressErrors {
  name: string | null;
  hosts: Array<string | null>;
  paths: Array<Array<{ path: string | null; service: string | null; port: string | null }>>;
  tls: string | null;
  general: string | null;
}

export function validateIngress(input: IngressInput): IngressErrors {
  const paths = input.rules.map((rule) =>
    rule.paths.map((p) => ({
      path:
        p.pathType !== 'ImplementationSpecific' && !p.path.trim().startsWith('/')
          ? i18n.t('Paths start with "/".')
          : null,
      service: p.service.trim()
        ? nameError(p.service.trim(), 'dns1035')
        : i18n.t('Pick a Service.'),
      port: !p.port.trim()
        ? i18n.t('A port is required.')
        : /^\d+$/.test(p.port.trim())
          ? portNumberError(p.port)
          : portNameError(p.port.trim()),
    })),
  );
  let tls: string | null = null;
  if (input.tls.mode !== 'none') {
    tls = input.tls.secretName.trim()
      ? nameError(input.tls.secretName.trim())
      : i18n.t('Name the TLS Secret.');
    if (!tls && input.tls.mode === 'cert-manager' && !input.tls.issuerName.trim())
      tls = i18n.t('Pick an issuer.');
    if (!tls && ruleHosts(input).length === 0) tls = i18n.t('TLS needs at least one host name.');
  }
  return {
    name: nameError(input.name),
    hosts: input.rules.map((r) => hostError(r.host.trim())),
    paths,
    tls,
    general: input.rules.length === 0 ? i18n.t('Add at least one rule.') : null,
  };
}

export function ingressBlocked(errors: IngressErrors): boolean {
  return (
    !!errors.name ||
    !!errors.tls ||
    !!errors.general ||
    errors.hosts.some(Boolean) ||
    errors.paths.some((rule) => rule.some((p) => p.path || p.service || p.port))
  );
}

// ---------------------------------------------------------------------------
// Cluster data
// ---------------------------------------------------------------------------

export interface ServicePortOption {
  /** Number as text, or the port name for named references. */
  value: string;
  port: number;
  name: string;
  protocol: string;
}

/** Ports an Ingress can route to (TCP ports of a Service). */
export function servicePorts(service: KubeObject): ServicePortOption[] {
  return asArray(spec(service).ports)
    .filter(isObject)
    .filter((p) => (asString(p.protocol) || 'TCP') === 'TCP')
    .map((p) => ({
      value: String(asNumber(p.port)),
      port: asNumber(p.port),
      name: asString(p.name),
      protocol: asString(p.protocol) || 'TCP',
    }));
}

export type IngressController = 'nginx' | 'traefik' | 'alb' | 'gce' | 'haproxy' | 'other';

export function ingressController(cls: KubeObject | null | undefined): IngressController {
  const controller = asString(asObject(cls?.spec).controller);
  if (controller === 'k8s.io/ingress-nginx') return 'nginx';
  if (controller.includes('traefik')) return 'traefik';
  if (controller === 'ingress.k8s.aws/alb') return 'alb';
  if (controller.includes('gce')) return 'gce';
  if (controller.includes('haproxy')) return 'haproxy';
  return 'other';
}

export function isDefaultClass(cls: KubeObject): boolean {
  return cls.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true';
}

export interface NginxOption {
  id: string;
  annotation: string;
  /** Value written when the toggle is on and the user typed nothing. */
  defaultValue: string;
  /** A fixed value (a pure toggle) or one the user edits. */
  editable: boolean;
  label: () => string;
  hint: () => string;
}

/** Common ingress-nginx annotations offered as optional toggles. */
export const NGINX_OPTIONS: readonly NginxOption[] = [
  {
    id: 'force-ssl-redirect',
    annotation: 'nginx.ingress.kubernetes.io/force-ssl-redirect',
    defaultValue: 'true',
    editable: false,
    label: () => i18n.t('Redirect HTTP to HTTPS'),
    hint: () => i18n.t('Also when TLS terminates in front of the controller.'),
  },
  {
    id: 'proxy-body-size',
    annotation: 'nginx.ingress.kubernetes.io/proxy-body-size',
    defaultValue: '16m',
    editable: true,
    label: () => i18n.t('Maximum request body size'),
    hint: () => i18n.t('Uploads larger than this are rejected (default 1m).'),
  },
  {
    id: 'proxy-read-timeout',
    annotation: 'nginx.ingress.kubernetes.io/proxy-read-timeout',
    defaultValue: '120',
    editable: true,
    label: () => i18n.t('Backend read timeout (seconds)'),
    hint: () => i18n.t('For slow responses and long polling (default 60).'),
  },
  {
    id: 'backend-protocol',
    annotation: 'nginx.ingress.kubernetes.io/backend-protocol',
    defaultValue: 'HTTPS',
    editable: true,
    label: () => i18n.t('Backend protocol'),
    hint: () => i18n.t('HTTP, HTTPS, GRPC or GRPCS towards the Service.'),
  },
  {
    id: 'rewrite-target',
    annotation: 'nginx.ingress.kubernetes.io/rewrite-target',
    defaultValue: '/',
    editable: true,
    label: () => i18n.t('Rewrite target'),
    hint: () => i18n.t('Replaces the matched path before proxying.'),
  },
  {
    id: 'whitelist-source-range',
    annotation: 'nginx.ingress.kubernetes.io/whitelist-source-range',
    defaultValue: '10.0.0.0/8',
    editable: true,
    label: () => i18n.t('Allowed source ranges'),
    hint: () => i18n.t('Comma-separated CIDRs; other clients get 403.'),
  },
  {
    id: 'enable-cors',
    annotation: 'nginx.ingress.kubernetes.io/enable-cors',
    defaultValue: 'true',
    editable: false,
    label: () => i18n.t('Enable CORS'),
    hint: () => i18n.t('Answers preflight requests with permissive CORS headers.'),
  },
];

/** Does `cert` cover `host` (SAN DNS names, one wildcard label)? */
export function certCoversHost(cert: X509Certificate, host: string): boolean {
  const names = cert.sans.length ? cert.sans : cert.subject.cn ? [cert.subject.cn] : [];
  const h = host.toLowerCase();
  return names.some((raw) => {
    const n = raw.toLowerCase();
    if (n === h) return true;
    if (n.startsWith('*.')) {
      const suffix = n.slice(1);
      return h.endsWith(suffix) && !h.slice(0, -suffix.length).includes('.');
    }
    if (h.startsWith('*.') && n.startsWith('*.')) return n === h;
    return false;
  });
}
