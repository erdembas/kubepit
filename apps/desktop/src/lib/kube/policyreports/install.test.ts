import { describe, expect, it } from 'vitest';
import {
  KYVERNO_CHART,
  KYVERNO_HELM_INSTALL,
  KYVERNO_INSTALL_ACCESS,
  KYVERNO_NAMESPACE,
  KYVERNO_RELEASE,
  kyvernoInstallRequest,
  kyvernoRepoPlan,
} from './install';

const repo = (name: string, url: string) => ({ name, url });

describe('kyvernoRepoPlan', () => {
  it('reuses a configured repository whatever its name', () => {
    expect(
      kyvernoRepoPlan([
        repo('bitnami', 'https://charts.bitnami.com/bitnami'),
        repo('policies', 'https://kyverno.github.io/kyverno/'),
      ]),
    ).toEqual({ name: 'policies', add: false });
  });

  it('adds it as kyverno, or under a free name when kyverno points elsewhere', () => {
    expect(kyvernoRepoPlan([])).toEqual({ name: 'kyverno', add: true });
    expect(kyvernoRepoPlan([repo('kyverno', 'https://example.com/charts')])).toEqual({
      name: 'kyverno-2',
      add: true,
    });
    expect(
      kyvernoRepoPlan([
        repo('kyverno', 'https://example.com/a'),
        repo('kyverno-2', 'https://example.com/b'),
      ]),
    ).toEqual({ name: 'kyverno-3', add: true });
  });
});

describe('kyvernoInstallRequest', () => {
  it('matches the upstream guide and waits for the operator', () => {
    const req = kyvernoInstallRequest('kyverno');
    expect(req).toMatchObject({
      release_name: KYVERNO_RELEASE,
      namespace: KYVERNO_NAMESPACE,
      chart_ref: `kyverno/${KYVERNO_CHART}`,
      version: null,
      create_namespace: true,
      wait: true,
      atomic: true,
      timeout_secs: 600,
      dry_run: false,
    });
  });

  it('keeps the helm command and the request the same install', () => {
    expect(KYVERNO_HELM_INSTALL).toContain(`helm repo add kyverno https://kyverno.github.io/kyverno`);
    expect(KYVERNO_HELM_INSTALL).toContain(`helm install ${KYVERNO_RELEASE} kyverno/${KYVERNO_CHART}`);
    expect(KYVERNO_HELM_INSTALL).toContain(`--namespace ${KYVERNO_NAMESPACE} --create-namespace`);
  });
});

describe('KYVERNO_INSTALL_ACCESS', () => {
  it('covers the cluster-wide objects the chart creates', () => {
    expect(KYVERNO_INSTALL_ACCESS).toEqual(
      expect.arrayContaining([
        { verb: 'create', group: 'apiextensions.k8s.io', resource: 'customresourcedefinitions' },
        { verb: 'create', group: 'admissionregistration.k8s.io', resource: 'validatingwebhookconfigurations' },
      ]),
    );
  });
});
