import { describe, expect, it } from 'vitest';
import { trivyInstallRequest, trivyRepoPlan } from './install';

const repo = (name: string, url: string) => ({ name, url });

describe('trivyRepoPlan', () => {
  it('reuses a configured repository whatever its name', () => {
    expect(
      trivyRepoPlan([
        repo('bitnami', 'https://charts.bitnami.com/bitnami'),
        repo('aquasec', 'https://AquaSecurity.github.io/helm-charts'),
      ]),
    ).toEqual({ name: 'aquasec', add: false });
  });

  it('adds it as aqua, or under a free name when aqua points elsewhere', () => {
    expect(trivyRepoPlan([])).toEqual({ name: 'aqua', add: true });
    expect(trivyRepoPlan([repo('aqua', 'https://example.com/charts')])).toEqual({
      name: 'aquasecurity',
      add: true,
    });
    expect(
      trivyRepoPlan([
        repo('aqua', 'https://example.com/a'),
        repo('aquasecurity', 'https://example.com/b'),
        repo('aqua-2', 'https://example.com/c'),
      ]),
    ).toEqual({ name: 'aqua-3', add: true });
  });
});

describe('trivyInstallRequest', () => {
  it('matches the upstream guide and waits for the operator', () => {
    const req = trivyInstallRequest('aqua');
    expect(req).toMatchObject({
      release_name: 'trivy-operator',
      namespace: 'trivy-system',
      chart_ref: 'aqua/trivy-operator',
      version: null,
      create_namespace: true,
      wait: true,
      atomic: true,
      dry_run: false,
    });
  });
});
