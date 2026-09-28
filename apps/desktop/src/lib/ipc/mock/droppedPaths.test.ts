import { describe, expect, it } from 'vitest';
import { droppedPaths } from './droppedPaths';

// The same cases as `change_journal::diff` tests of `dropped_paths` (Rust).
describe('droppedPaths', () => {
  it('is old render minus new render, still live', () => {
    const env = (...names: string[]) => names.map((name) => ({ name, value: '1' }));
    const before = {
      metadata: { annotations: { a: '1', keep: 'x' } },
      spec: { template: { spec: { containers: [{ name: 'api', env: env('DEBUG', 'LOG') }] } } },
    };
    const after = {
      metadata: { annotations: { keep: 'x' } },
      spec: { template: { spec: { containers: [{ name: 'api', env: env('LOG') }] } } },
    };
    const live = {
      metadata: { annotations: { a: '1', keep: 'x', server: 'y' } },
      spec: {
        replicas: 2,
        template: { spec: { containers: [{ name: 'api', env: env('DEBUG', 'LOG') }] } },
      },
    };
    expect(droppedPaths(before, after, live)).toEqual([
      'metadata.annotations.a',
      'spec.template.spec.containers[api].env[DEBUG]',
    ]);
  });

  it('skips fields already gone live', () => {
    expect(droppedPaths({ spec: { paused: true } }, { spec: {} }, { spec: {} })).toEqual([]);
  });

  it('finds live items by key and reports whole subtrees', () => {
    const mounts = (...paths: string[]) =>
      paths.map((mountPath) => ({ name: 'config', mountPath }));
    expect(
      droppedPaths(
        { volumeMounts: mounts('/etc/a', '/etc/b'), nodeSelector: { disk: 'ssd' } },
        { volumeMounts: mounts('/etc/a') },
        { volumeMounts: mounts('/var/run', '/etc/b', '/etc/a'), nodeSelector: { disk: 'ssd' } },
      ),
    ).toEqual(['nodeSelector', 'volumeMounts[/etc/b]']);
    // Matched by key, not position: live has two items, but not `/etc/b`.
    expect(
      droppedPaths(
        { volumeMounts: mounts('/etc/a', '/etc/b') },
        { volumeMounts: mounts('/etc/a') },
        { volumeMounts: mounts('/var/run', '/etc/a') },
      ),
    ).toEqual([]);
    expect(
      droppedPaths(
        { spec: { replicas: 2, paused: true } },
        { spec: { replicas: 3 } },
        { spec: { replicas: 2, paused: null } },
      ),
    ).toEqual([]);
  });

  it('skips empty maps and lists', () => {
    // The API server keeps `resources: {}`; only the env list really goes.
    const before = {
      containers: [
        { name: 'api', image: 'a', resources: {}, args: [], env: [{ name: 'DEBUG', value: '1' }] },
      ],
    };
    const after = { containers: [{ name: 'api', image: 'a' }] };
    expect(droppedPaths(before, after, before)).toEqual(['containers[api].env']);
  });

  it('quotes keys that are not plain', () => {
    expect(
      droppedPaths(
        { metadata: { annotations: { 'example.com/legacy': 'on', team: 'shop' } } },
        { metadata: { annotations: { team: 'shop' } } },
        { metadata: { annotations: { 'example.com/legacy': 'on' } } },
      ),
    ).toEqual(['metadata.annotations["example.com/legacy"]']);
  });
});
