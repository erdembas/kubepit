import { describe, expect, it } from 'vitest';
import { extractSuggestions, suggestionForCode } from './answer';

const F = '```';

/** A Markdown answer with one fence per `[lang, body]`. */
function answerWith(...blocks: [string, string][]): string {
  return [
    '**Most likely cause:** the container exits right after it starts.',
    ...blocks.map(([lang, body]) => `${F}${lang}\n${body}\n${F}`),
    'Done.',
  ].join('\n\n');
}

const deploymentPartial = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  template:
    spec:
      containers:
        - name: app
          resources:
            limits:
              memory: 1Gi`;

const secretManifest = (value: string) => `apiVersion: v1
kind: Secret
metadata:
  name: db
  namespace: shop
stringData:
  password: ${value}`;

describe('suggestions in assistant answers', () => {
  it('extracts manifests, kubectl, PromQL and LogQL fences', () => {
    const s = extractSuggestions(
      answerWith(
        ['yaml', deploymentPartial],
        ['sh', 'kubectl -n shop get pods'],
        ['promql', 'up'],
        ['logql', '{app="web"}'],
      ),
    );
    expect(s.map((x) => x.kind)).toEqual(['manifest', 'kubectl', 'promql', 'logql']);
    expect(s[0]).toMatchObject({
      kind: 'manifest',
      objects: [{ apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'shop', name: 'web' }],
      blocked: null,
      placeholders: [],
    });
    expect(s[1]).toMatchObject({ kind: 'kubectl', command: 'kubectl -n shop get pods' });
    expect(s[2]).toEqual({ kind: 'promql', query: 'up' });
    expect(s[3]).toEqual({ kind: 'logql', query: '{app="web"}' });
  });

  it('finds fences nested in lists and quotes', () => {
    const md = `1. Check the pods:\n\n   ${F}sh\n   kubectl get pods\n   ${F}\n\n> ${F}promql\n> rate(x[5m])\n> ${F}`;
    expect(extractSuggestions(md).map((s) => s.kind)).toEqual(['kubectl', 'promql']);
  });

  it('treats sh fences as kubectl only when the first command is kubectl', () => {
    expect(suggestionForCode('sh', 'helm list')).toBeNull();
    expect(
      suggestionForCode('bash', '# look first\n$ kubectl get pods -A\nkubectl top pods'),
    ).toMatchObject({
      kind: 'kubectl',
      command: 'kubectl get pods -A\nkubectl top pods',
    });
    expect(suggestionForCode('kubectl', 'kubectl describe pod web-1')).toMatchObject({
      kind: 'kubectl',
    });
    expect(suggestionForCode('python', 'print(1)')).toBeNull();
  });

  it('ignores yaml fences without apiVersion, kind and name', () => {
    expect(suggestionForCode('yaml', 'replicas: 3')).toBeNull();
    expect(suggestionForCode('yaml', 'apiVersion: v1\nkind: ConfigMap\nmetadata: {}')).toBeNull();
    expect(suggestionForCode('yaml', `${deploymentPartial}\n---\nreplicas: 3`)).toBeNull();
    expect(suggestionForCode('yaml', 'apiVersion: v1\nkind: [')).toBeNull();
    expect(
      suggestionForCode('yml', `${deploymentPartial}\n---\n${secretManifest('x')}`),
    ).toMatchObject({
      objects: [{ kind: 'Deployment' }, { kind: 'Secret' }],
    });
  });

  it('blocks manifests carrying secret or token markers', () => {
    expect(suggestionForCode('yaml', secretManifest('__SECRET__'))).toMatchObject({
      blocked: 'secret',
    });
    expect(
      suggestionForCode('sh', 'kubectl create secret generic x --from-literal=p=__TOKEN__'),
    ).toMatchObject({ blocked: 'secret' });
  });

  it('lists IP and host placeholders to restore', () => {
    const ingress = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: shop
spec:
  rules:
    - host: __HOST_1__
  tls:
    - hosts: [__HOST_1__, __HOST_2__]`;
    expect(suggestionForCode('yaml', ingress)).toMatchObject({
      blocked: null,
      placeholders: ['__HOST_1__', '__HOST_2__'],
    });
    expect(suggestionForCode('promql', 'up{instance="__IP_1__:9100"}')).toEqual({
      kind: 'promql',
      query: 'up{instance="__IP_1__:9100"}',
    });
  });

  it('skips empty queries and plain code', () => {
    expect(suggestionForCode('promql', '   ')).toBeNull();
    expect(extractSuggestions('No code here, just `inline`.')).toEqual([]);
    expect(extractSuggestions(`${F}\nkubectl get pods\n${F}`)).toEqual([]);
  });
});
