import { describe, expect, it } from 'vitest';
import { scanHealth } from '@/lib/kube/health';
import { emptyHealthInput } from './testing';
import type { HealthKind } from './types';

const secret = (name: string, ns = 'app', extra: Record<string, unknown> = {}) => ({
  apiVersion: 'v1',
  kind: 'Secret',
  type: 'Opaque',
  metadata: { name, namespace: ns, uid: `s-${ns}-${name}`, ...extra },
});
const obj = (
  apiVersion: string,
  kind: string,
  name: string,
  ns: string | null,
  spec: unknown,
  meta: Record<string, unknown> = {},
) => ({
  apiVersion,
  kind,
  metadata: { name, ...(ns ? { namespace: ns } : {}), uid: `${kind}-${name}`, ...meta },
  spec,
});
const unused = (input: Parameters<typeof emptyHealthInput>[0]) =>
  scanHealth(emptyHealthInput(input))
    .findings.filter((f) => f.ruleId === 'secret-unused')
    .map((f) => `${f.ref.namespace}/${f.ref.name}`)
    .sort();

describe('secret-unused', () => {
  it('still reports an unreferenced Opaque secret', () => {
    expect(unused({ secrets: [secret('lonely')] })).toEqual(['app/lonely']);
  });
  it('skips secrets named by a Gateway listener certificateRef', () => {
    const gw = obj('gateway.networking.k8s.io/v1', 'Gateway', 'gw', 'app', {
      listeners: [
        {
          name: 'https',
          tls: {
            certificateRefs: [
              { name: 'gw-tls' },
              { kind: 'Secret', name: 'other', namespace: 'certs' },
            ],
          },
        },
      ],
    });
    expect(
      unused({ secrets: [secret('gw-tls'), secret('other', 'certs')], gateways: [gw] }),
    ).toEqual([]);
  });
  it('skips Issuer and ClusterIssuer secrets', () => {
    const issuer = obj('cert-manager.io/v1', 'Issuer', 'le', 'app', {
      acme: { privateKeySecretRef: { name: 'le-key' } },
    });
    const cluster = obj('cert-manager.io/v1', 'ClusterIssuer', 'ca', null, {
      ca: { secretName: 'root-ca' },
    });
    expect(
      unused({
        secrets: [secret('le-key'), secret('root-ca', 'cert-manager')],
        issuers: [issuer],
        clusterIssuers: [cluster],
      }),
    ).toEqual([]);
  });
  it('skips DNS01 solver, external account binding and Vault token secrets', () => {
    const cluster = obj('cert-manager.io/v1', 'ClusterIssuer', 'le-dns', null, {
      acme: {
        privateKeySecretRef: { name: 'le-account' },
        externalAccountBinding: { keyID: 'kid', keySecretRef: { name: 'eab', key: 'secret' } },
        solvers: [
          { dns01: { cloudflare: { apiTokenSecretRef: { name: 'cf-token', key: 'api-token' } } } },
          {
            dns01: {
              route53: {
                region: 'eu-west-1',
                accessKeyIDSecretRef: { name: 'aws-creds', key: 'id' },
                secretAccessKeySecretRef: { name: 'aws-creds', key: 'secret' },
              },
            },
          },
        ],
      },
    });
    const vault = obj('cert-manager.io/v1', 'Issuer', 'vault', 'app', {
      vault: { auth: { tokenSecretRef: { name: 'vault-token', key: 'token' } } },
    });
    expect(
      unused({
        secrets: [
          secret('le-account', 'cert-manager'),
          secret('eab', 'cert-manager'),
          secret('cf-token', 'cert-manager'),
          secret('aws-creds', 'cert-manager'),
          secret('vault-token'),
        ],
        clusterIssuers: [cluster],
        issuers: [vault],
      }),
    ).toEqual([]);
  });
  it('skips the secret named by inject-ca-from-secret on a webhook configuration', () => {
    const hook = obj(
      'admissionregistration.k8s.io/v1',
      'ValidatingWebhookConfiguration',
      'v',
      null,
      undefined,
      { annotations: { 'cert-manager.io/inject-ca-from-secret': 'webhooks/serving-ca' } },
    );
    expect(
      unused({ secrets: [secret('serving-ca', 'webhooks')], validatingWebhooks: [hook] }),
    ).toEqual([]);
  });
  it('skips Flux source, decryption and valuesFrom secrets but not ConfigMap valuesFrom', () => {
    const repo = obj('source.toolkit.fluxcd.io/v1', 'GitRepository', 'infra', 'flux-system', {
      secretRef: { name: 'git-auth' },
    });
    const ks = obj('kustomize.toolkit.fluxcd.io/v1', 'Kustomization', 'apps', 'flux-system', {
      decryption: { provider: 'sops', secretRef: { name: 'sops-age' } },
    });
    const hr = obj('helm.toolkit.fluxcd.io/v2', 'HelmRelease', 'api', 'app', {
      valuesFrom: [
        { kind: 'Secret', name: 'api-values' },
        { kind: 'ConfigMap', name: 'api-cm' },
      ],
    });
    expect(
      unused({
        secrets: [
          secret('git-auth', 'flux-system'),
          secret('sops-age', 'flux-system'),
          secret('api-values'),
          secret('api-cm'),
        ],
        gitRepositories: [repo],
        kustomizations: [ks],
        helmReleases: [hr],
      }),
    ).toEqual(['app/api-cm']);
  });
  it('skips cert-manager issued and Argo CD internal secrets', () => {
    expect(
      unused({
        secrets: [
          secret('web-tls', 'app', { annotations: { 'cert-manager.io/certificate-name': 'web' } }),
          secret('argocd-secret', 'argocd'),
          secret('extra', 'argocd', { labels: { 'app.kubernetes.io/part-of': 'argocd' } }),
        ],
      }),
    ).toEqual([]);
  });
  it('skips the rule when serviceAccounts did not load', () => {
    const input = emptyHealthInput({ secrets: [secret('lonely')] });
    const loaded = new Set(input.loaded);
    loaded.delete('serviceAccounts' as HealthKind);
    expect(
      scanHealth({ ...input, loaded }).findings.filter((f) => f.ruleId === 'secret-unused'),
    ).toEqual([]);
  });
});
