import { beforeEach, describe, expect, it, vi } from 'vitest';

// The dock store pulls in window-bound modules (Vitest runs in the node
// environment), so it is mocked; so is the clipboard.
vi.mock('@/store/useDockStore', () => ({
  dock: { create: vi.fn(() => 't1'), promql: vi.fn(() => 't2'), loki: vi.fn(() => 't3') },
}));

import { dock } from '@/store/useDockStore';
import { openSuggestion } from './actions';
import { suggestionForCode } from './answer';

const writeText = vi.fn(async (_text: string) => undefined);

const secretManifest = (value: string) => `apiVersion: v1
kind: Secret
metadata:
  name: db
  namespace: shop
stringData:
  password: ${value}`;

const ingressFor = (host: string) => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: shop
spec:
  rules:
    - host: ${host}`;

beforeEach(() => {
  vi.mocked(dock.create).mockClear();
  vi.mocked(dock.promql).mockClear();
  vi.mocked(dock.loki).mockClear();
  writeText.mockClear();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
});

describe('openSuggestion', () => {
  it('never opens the review for blocked manifests and restores placeholders first', async () => {
    const spy = vi.mocked(dock.create);
    expect(
      await openSuggestion('c1', suggestionForCode('yaml', secretManifest('__SECRET__'))!, {}),
    ).toEqual({ ok: false, reason: 'secret' });
    expect(spy).not.toHaveBeenCalled();
    expect(
      await openSuggestion('c1', suggestionForCode('yaml', ingressFor('__HOST_1__'))!, {
        __HOST_1__: 'shop.acme.io',
      }),
    ).toEqual({ ok: true });
    expect(spy.mock.calls[0]![0]).toBe('c1');
    expect(spy.mock.calls[0]![1]).toBe('shop');
    expect(spy.mock.calls[0]![2]).toContain('shop.acme.io');
    expect(spy.mock.calls[0]![2]).not.toContain('__HOST_1__');
    expect(spy.mock.calls[0]![3]).toEqual({ reviewMode: 'apply' });
  });

  it('refuses manifests whose placeholders cannot be restored', async () => {
    expect(
      await openSuggestion('c1', suggestionForCode('yaml', ingressFor('__HOST_2__'))!, {
        __HOST_1__: 'shop.acme.io',
      }),
    ).toEqual({ ok: false, reason: 'missing-placeholder' });
    expect(dock.create).not.toHaveBeenCalled();
  });

  it('opens cluster-scoped manifests without a namespace', async () => {
    const ns = suggestionForCode(
      'yaml',
      'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop',
    )!;
    await openSuggestion('c1', ns, {});
    expect(vi.mocked(dock.create).mock.calls[0]![1]).toBeNull();
  });

  it('copies kubectl commands with placeholders restored, never with secret markers', async () => {
    const cmd = suggestionForCode('sh', 'kubectl -n shop exec web-1 -- curl http://__IP_1__:8080')!;
    expect(await openSuggestion('c1', cmd, { __IP_1__: '10.0.0.7' })).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith(
      'kubectl -n shop exec web-1 -- curl http://10.0.0.7:8080',
    );
    const secret = suggestionForCode(
      'sh',
      'kubectl create secret generic x --from-literal=p=__SECRET__',
    )!;
    expect(await openSuggestion('c1', secret, {})).toEqual({ ok: false, reason: 'secret' });
    expect(await openSuggestion('c1', cmd, {})).toEqual({
      ok: false,
      reason: 'missing-placeholder',
    });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('opens PromQL and LogQL in their tabs', async () => {
    await openSuggestion(
      'c1',
      { kind: 'promql', query: 'up{instance="__IP_1__:9100"}' },
      { __IP_1__: '10.0.0.7' },
    );
    expect(dock.promql).toHaveBeenCalledWith('c1', 'up{instance="10.0.0.7:9100"}');
    await openSuggestion('c1', { kind: 'logql', query: '{app="web"} |= "error"' }, {});
    expect(dock.loki).toHaveBeenCalledWith('c1', { query: '{app="web"} |= "error"' });
  });
});
