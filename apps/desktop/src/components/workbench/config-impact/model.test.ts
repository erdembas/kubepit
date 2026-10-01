import { describe, expect, it } from 'vitest';
import type { KubeObject } from '@/types';
import {
  buildConfigImpact,
  configUses,
  MAX_IMPACT_CONSUMERS,
  MAX_USES_PER_OBJECT,
  restartPatch,
  type ConfigReference,
} from './model';

const target: ConfigReference = { kind: 'ConfigMap', namespace: 'shop', name: 'app-config' };
const changes = [
  { key: 'url', operation: 'changed' as const },
  { key: 'mode', operation: 'removed' as const },
];
function deployment(podSpec: unknown, kind = 'Deployment'): KubeObject {
  return {
    apiVersion: kind === 'Pod' ? 'v1' : kind === 'CronJob' ? 'batch/v1' : 'apps/v1',
    kind,
    metadata: { name: 'app', namespace: 'shop', uid: 'workload-1', resourceVersion: '12' },
    spec:
      kind === 'Pod'
        ? podSpec
        : kind === 'CronJob'
          ? { jobTemplate: { spec: { template: { spec: podSpec } } } }
          : { template: { spec: podSpec } },
  };
}

describe('key-level configuration references', () => {
  it('shows empty whole-object consumers and missing-key references only in the consumer browser', () => {
    const obj = deployment({
      containers: [
        {
          name: 'api',
          env: [
            {
              name: 'URL',
              valueFrom: { configMapKeyRef: { name: target.name, key: 'missing-url' } },
            },
          ],
          envFrom: [{ configMapRef: { name: target.name } }],
          volumeMounts: [
            { name: 'whole', mountPath: '/all' },
            { name: 'mapped', mountPath: '/one', subPath: 'url.conf' },
          ],
        },
      ],
      volumes: [
        { name: 'whole', configMap: { name: target.name } },
        {
          name: 'mapped',
          projected: {
            sources: [
              {
                configMap: { name: target.name, items: [{ key: 'missing-url', path: 'url.conf' }] },
              },
            ],
          },
        },
      ],
    });
    const view = buildConfigImpact(target, [], [obj], 'all-references');
    expect(view.consumers).toHaveLength(1);
    expect(view.consumers[0]?.uses.map((use) => use.mode)).toEqual([
      'env',
      'envFrom',
      'volume',
      'subPath',
    ]);
    expect(view.consumers[0]?.uses[0]).toMatchObject({
      keys: ['missing-url'],
      missingKeys: ['missing-url'],
    });
    expect(view.consumers[0]?.uses[1]).toMatchObject({ keys: [], allKeys: true });
    expect(view.consumers[0]?.uses[2]).toMatchObject({ keys: [], allKeys: true });
    expect(view.consumers[0]?.uses[3]).toMatchObject({
      keys: ['missing-url'],
      missingKeys: ['missing-url'],
    });
    expect(buildConfigImpact(target, [], [obj]).consumers).toEqual([]);
    expect(configUses(obj, target, ['unrelated']).uses.map((use) => use.mode)).toEqual([
      'envFrom',
      'volume',
    ]);
    const secret = { ...target, kind: 'Secret' as const };
    const pull = deployment({ containers: [], imagePullSecrets: [{ name: target.name }] });
    expect(configUses(pull, secret, [], 'all-references').uses[0]).toMatchObject({
      mode: 'imagePullSecret',
      keys: [],
      allKeys: true,
    });
    expect(configUses(pull, secret, []).uses).toEqual([]);
  });

  it('keeps env, envFrom and mounted file uses distinct without retaining literal values', () => {
    const obj = deployment({
      containers: [
        {
          name: 'api',
          env: [
            { name: 'URL', valueFrom: { configMapKeyRef: { name: target.name, key: 'url' } } },
            { name: 'PASSWORD', value: 'never-copy-this-value' },
            {
              name: 'IGNORED',
              valueFrom: { configMapKeyRef: { name: target.name, key: 'unmodified' } },
            },
          ],
          envFrom: [{ prefix: 'APP_', configMapRef: { name: target.name, optional: true } }],
          volumeMounts: [{ name: 'config', mountPath: '/etc/app' }],
        },
      ],
      volumes: [{ name: 'config', configMap: { name: target.name } }],
    });
    const result = configUses(
      obj,
      target,
      changes.map((c) => c.key),
    );
    expect(result.uses.map((use) => [use.mode, use.refresh, use.keys])).toEqual([
      ['env', 'replace', ['url']],
      ['envFrom', 'replace', ['url', 'mode']],
      ['volume', 'application', ['url', 'mode']],
    ]);
    expect(result.uses[1]).toMatchObject({ optional: true, container: 'api', binding: 'APP_' });
    expect(JSON.stringify(result)).not.toContain('never-copy-this-value');
    expect(
      configUses({ ...obj, metadata: { ...obj.metadata, namespace: 'another' } }, target, ['url'])
        .uses,
    ).toEqual([]);
  });

  it('maps projected keys to static subpaths and flags dynamic subpaths conservatively', () => {
    const obj = deployment({
      containers: [
        {
          name: 'app',
          volumeMounts: [
            { name: 'shared', mountPath: '/one', subPath: 'directory/url.conf' },
            { name: 'shared', mountPath: '/other', subPath: 'directory/mode.conf' },
            { name: 'shared', mountPath: '/dynamic', subPathExpr: '$(CONFIG_PATH)' },
          ],
        },
      ],
      volumes: [
        {
          name: 'shared',
          projected: {
            sources: [
              {
                configMap: {
                  name: target.name,
                  items: [
                    { key: 'url', path: 'directory/url.conf' },
                    { key: 'mode', path: 'directory/mode.conf' },
                  ],
                },
              },
              { secret: { name: 'unrelated' } },
            ],
          },
        },
      ],
    });
    const result = configUses(obj, target, ['url']);
    expect(result.uses).toHaveLength(2);
    expect(result.uses[0]).toMatchObject({ mode: 'subPath', keys: ['url'], uncertain: false });
    expect(result.uses[1]).toMatchObject({ mode: 'subPath', keys: ['url'], uncertain: true });
  });

  it('recognizes Secret references in init, ephemeral, projected and image-pull contexts', () => {
    const secret = { ...target, kind: 'Secret' as const, name: 'credentials' };
    const obj = deployment(
      {
        initContainers: [
          {
            name: 'init',
            env: [
              {
                name: 'TOKEN',
                valueFrom: { secretKeyRef: { name: secret.name, key: 'token', optional: true } },
              },
            ],
          },
        ],
        ephemeralContainers: [{ name: 'debug', envFrom: [{ secretRef: { name: secret.name } }] }],
        containers: [{ name: 'api', volumeMounts: [{ name: 'auth', mountPath: '/auth' }] }],
        volumes: [
          {
            name: 'auth',
            projected: {
              sources: [
                { secret: { name: secret.name, items: [{ key: 'token', path: 'auth.txt' }] } },
              ],
            },
          },
        ],
        imagePullSecrets: [{ name: secret.name }],
      },
      'Pod',
    );
    Object.defineProperty(obj, 'data', {
      get() {
        throw new Error('Secret values must not be inspected');
      },
    });
    const result = configUses(obj, secret, ['token']);
    expect(result.uses.map((use) => use.mode)).toEqual([
      'projected',
      'env',
      'envFrom',
      'imagePullSecret',
    ]);
    expect(result.uses[1]?.containerType).toBe('initContainers');
    expect(result.uses[2]?.containerType).toBe('ephemeralContainers');
    expect(result.uses[3]?.refresh).toBe('pull');
  });

  it('reports CronJob templates and owners as evidence, without treating them as restartable', () => {
    const obj = deployment(
      { containers: [{ name: 'job', envFrom: [{ configMapRef: { name: target.name } }] }] },
      'CronJob',
    );
    obj.metadata.ownerReferences = [
      {
        kind: 'CustomController',
        apiVersion: 'example/v1',
        name: 'owner',
        uid: 'owner',
        controller: true,
      },
    ];
    const result = buildConfigImpact(target, changes, [obj]);
    expect(result.consumers[0]).toMatchObject({
      restartable: false,
      restartRequired: true,
      owner: { kind: 'CustomController', name: 'owner' },
    });
    expect(restartPatch(obj, '2026-10-01')).toBeNull();
  });

  it('bounds reference and consumer output and never reports a limited scan as complete', () => {
    const obj = deployment({
      containers: [
        {
          name: 'app',
          envFrom: Array.from({ length: MAX_USES_PER_OBJECT + 1 }, () => ({
            configMapRef: { name: target.name },
          })),
        },
      ],
    });
    const result = configUses(obj, target, ['url']);
    expect(result.uses).toHaveLength(MAX_USES_PER_OBJECT);
    expect(result.truncated).toBe(true);
    const many = Array.from({ length: MAX_IMPACT_CONSUMERS + 1 }, (_, index) => ({
      ...obj,
      metadata: { ...obj.metadata, uid: String(index), name: `app-${index}` },
    }));
    const impact = buildConfigImpact(target, changes, many);
    expect(impact.consumers).toHaveLength(MAX_IMPACT_CONSUMERS);
    expect(impact.truncated).toBe(true);
  });
});
