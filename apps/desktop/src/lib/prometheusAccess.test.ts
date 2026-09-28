import { describe, expect, it } from 'vitest';
import type { PrometheusAccess, PrometheusConfig } from '@/types';
import {
  RESERVED_LABELS,
  accessDraft,
  accessFromDraft,
  accessKey,
  clusterMatchers,
  labelProblem,
} from './prometheusAccess';

const auto: PrometheusConfig = { mode: 'auto' };
const http: PrometheusConfig = {
  mode: 'service',
  namespace: 'monitoring',
  service: 'prometheus-operated',
  port: 9090,
  scheme: 'http',
  path_prefix: '',
};
const https: PrometheusConfig = { ...http, scheme: 'https' };

const saved: PrometheusAccess = {
  tenant: 'team-a',
  cluster_labels: { region: 'eu', cluster: 'prod' },
  auth: { type: 'bearer', namespace: 'monitoring', secret: 'prom-auth', token_key: 'token' },
  tls: {
    ca: { kind: 'ConfigMap', namespace: 'monitoring', name: 'prom-ca', key: 'ca.crt' },
    insecure_skip_verify: false,
  },
};

describe('prometheus access drafts', () => {
  it('round-trip a saved setting', () => {
    expect(accessFromDraft(accessDraft(saved), https)).toEqual({ access: saved });
    expect(accessFromDraft(accessDraft(undefined), auto)).toEqual({
      access: { tenant: '', cluster_labels: {}, auth: null, tls: null },
    });
  });

  it('refuse reserved and malformed label names like the backend', () => {
    for (const name of RESERVED_LABELS) expect(labelProblem({ name, value: 'x' })).not.toBeNull();
    expect(labelProblem({ name: '9bad', value: 'x' })).not.toBeNull();
    expect(labelProblem({ name: 'clus-ter', value: 'x' })).not.toBeNull();
    expect(labelProblem({ name: 'cluster', value: ' ' })).not.toBeNull();
    expect(labelProblem({ name: '', value: '' })).toBeNull();
    const draft = { ...accessDraft(undefined), labels: [{ name: 'pod', value: 'x' }] };
    expect(accessFromDraft(draft, auto)).toHaveProperty('error');
    const twice = {
      ...accessDraft(undefined),
      labels: [
        { name: 'cluster', value: 'a' },
        { name: ' cluster ', value: 'b' },
      ],
    };
    expect(accessFromDraft(twice, auto)).toHaveProperty('error');
  });

  it('check the tenant and the Secret reference', () => {
    const base = accessDraft(undefined);
    expect(accessFromDraft({ ...base, tenant: 'a\nb' }, auto)).toHaveProperty('error');
    expect(accessFromDraft({ ...base, tenant: 't'.repeat(201) }, auto)).toHaveProperty('error');
    // A header value: visible ASCII only (the backend refuses the rest too).
    for (const tenant of ['tenánt', 'team a', 'team\u00a0a', 'チーム'])
      expect(accessFromDraft({ ...base, tenant }, auto)).toHaveProperty('error');
    expect(accessFromDraft({ ...base, tenant: ' team-a|b_1.{x} ' }, auto)).toEqual({
      access: { tenant: 'team-a|b_1.{x}', cluster_labels: {}, auth: null, tls: null },
    });
    const bearer = { ...base, auth: 'bearer' as const, secretName: 'prom-auth' };
    expect(accessFromDraft(bearer, http)).toEqual({
      access: {
        tenant: '',
        cluster_labels: {},
        auth: { type: 'bearer', namespace: 'monitoring', secret: 'prom-auth', token_key: 'token' },
        tls: null,
      },
    });
    expect(accessFromDraft({ ...bearer, secretName: 'Prom Auth' }, http)).toHaveProperty('error');
    expect(accessFromDraft({ ...bearer, tokenKey: 'a/b' }, http)).toHaveProperty('error');
    expect(accessFromDraft({ ...bearer, tokenKey: 'BEARER_TOKEN.txt' }, http)).not.toHaveProperty(
      'error',
    );
  });

  it('keep TLS only where it can apply', () => {
    const draft = {
      ...accessDraft(undefined),
      auth: 'basic' as const,
      secretName: 'prom-auth',
      skipVerify: true,
    };
    const tlsOf = (config: PrometheusConfig) => {
      const result = accessFromDraft(draft, config);
      return 'access' in result ? result.access.tls : 'error';
    };
    expect(tlsOf(https)).toEqual({ ca: null, insecure_skip_verify: true });
    expect(tlsOf(auto)).toEqual({ ca: null, insecure_skip_verify: true });
    expect(tlsOf(http)).toBeNull();
    const noAuth = accessFromDraft({ ...draft, auth: 'none' }, https);
    expect('access' in noAuth && noAuth.access.tls).toBeNull();
  });

  it('show the selector the backend injects', () => {
    expect(clusterMatchers(saved)).toBe('cluster="prod",region="eu"');
    expect(clusterMatchers({ ...saved, cluster_labels: { c: 'a"b' } })).toBe('c="a\\"b"');
    expect(clusterMatchers(undefined)).toBe('');
  });

  it('key caches on the access settings', () => {
    expect(accessKey(undefined)).toBe('');
    expect(accessKey({ tenant: '', cluster_labels: {}, auth: null, tls: null })).toBe('');
    expect(accessKey(saved)).not.toBe(accessKey({ ...saved, tenant: 'team-b' }));
  });
});
