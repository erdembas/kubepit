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
      suggestionForCode('bash', '# look first\nkubectl get pods -A\nkubectl top pods'),
    ).toMatchObject({
      kind: 'kubectl',
      command: '# look first\nkubectl get pods -A\nkubectl top pods',
    });
    // A `$ ` prompt anywhere makes it a console transcript: unprompted lines are output.
    expect(
      suggestionForCode('bash', '# look first\n$ kubectl get pods -A\nNAME   READY\nweb-1  1/1'),
    ).toMatchObject({ command: 'kubectl get pods -A' });
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
      blocked: 'secret',
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

  it('never throws on unresolved aliases, cross-document merge keys or alias bombs', () => {
    const unresolved = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: *nope\n';
    const merge = `apiVersion: v1\nkind: ConfigMap\nmetadata: &common\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  <<: *common\n`;
    const levels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const bomb = [
      'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      ...levels.slice(1).map((l, i) => `${l}: &${l} [${Array(9).fill(`*${levels[i]}`).join(',')}]`),
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  name: boom',
    ].join('\n');
    for (const text of [unresolved, merge, bomb]) {
      expect(() => suggestionForCode('yaml', text)).not.toThrow();
      expect(suggestionForCode('yaml', text)).toBeNull();
      expect(() => extractSuggestions(`${F}yaml\n${text}\n${F}`)).not.toThrow();
      expect(extractSuggestions(`${F}yaml\n${text}\n${F}`)).toEqual([]);
    }
    const started = performance.now();
    suggestionForCode('yaml', bomb);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('blocks numbered, lower-case and base64-encoded secret markers', () => {
    expect(suggestionForCode('yaml', secretManifest('__SECRET_1__'))).toMatchObject({
      blocked: 'secret',
    });
    expect(
      suggestionForCode('sh', 'kubectl -n shop exec web-1 -- env TOKEN=__token_2__ ./run'),
    ).toMatchObject({ blocked: 'secret' });
    const encoded = `apiVersion: v1
kind: Secret
metadata:
  name: db
  namespace: shop
data:
  password: X19TRUNSRVRfXw==`;
    expect(suggestionForCode('yaml', encoded)).toMatchObject({ blocked: 'secret' });
  });

  it('refuses Secret-like manifests that carry any values, which the model never saw', () => {
    const sealed = `apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db
  namespace: shop
spec:
  encryptedData:
    password: AgBy3i4OJSWK+PiTySYZZA==`;
    expect(suggestionForCode('yaml', secretManifest('s3cr3t-guess'))).toMatchObject({
      blocked: 'secret',
    });
    expect(suggestionForCode('yaml', sealed)).toMatchObject({ blocked: 'secret' });
    const labelsOnly =
      'apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  labels:\n    app: web\ntype: Opaque';
    expect(suggestionForCode('yaml', labelsOnly)).toMatchObject({ blocked: null });
    const configMap =
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  mode: fast';
    expect(suggestionForCode('yaml', configMap)).toMatchObject({ blocked: null });
  });

  it('copies the command as written: heredocs kept, prompts and console output dropped', () => {
    const heredoc = `kubectl apply -f - <<'EOF'
#!/bin/sh
# keep this comment

echo "done"
EOF`;
    expect(suggestionForCode('sh', heredoc)).toMatchObject({ kind: 'kubectl', command: heredoc });
    const session = [
      '$ kubectl -n shop get pods',
      'NAME    READY   STATUS',
      'web-1   1/1     Running',
      '$ kubectl -n shop logs web-1 \\',
      '    --previous',
    ].join('\n');
    expect(suggestionForCode('console', session)).toMatchObject({
      command: 'kubectl -n shop get pods\nkubectl -n shop logs web-1 \\\n    --previous',
    });
    expect(suggestionForCode('sh', '$ kubectl get ns\n$ kubectl get pods')).toMatchObject({
      command: 'kubectl get ns\nkubectl get pods',
    });
    expect(suggestionForCode('console', 'NAME  READY\nweb-1 1/1')).toBeNull();
  });

  it('strips `> ` from console continuations and heredocs, and never takes a here-string for a heredoc', () => {
    const transcript = [
      '$ kubectl apply -f - <<EOF',
      '> apiVersion: v1',
      '> kind: Namespace',
      '> EOF',
      'namespace/shop created',
      '$ kubectl -n shop logs web-1 \\',
      '> --previous',
    ].join('\n');
    expect(suggestionForCode('console', transcript)).toMatchObject({
      command:
        'kubectl apply -f - <<EOF\napiVersion: v1\nkind: Namespace\nEOF\nkubectl -n shop logs web-1 \\\n--previous',
    });
    const hereString = [
      '$ kubectl apply -f - <<< manifest',
      'configmap/x created',
      '$ kubectl get pods',
    ].join('\n');
    expect(suggestionForCode('sh', hereString)).toMatchObject({
      command: 'kubectl apply -f - <<< manifest\nkubectl get pods',
    });
  });

  it('stays linear on long whitespace runs and refuses oversized fences', () => {
    const started = performance.now();
    suggestionForCode('sh', `kubectl get${' '.repeat(60_000)}pods`);
    expect(performance.now() - started).toBeLessThan(50);
    const huge = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: big\ndata:\n  blob: "${'x'.repeat(70_000)}"`;
    expect(suggestionForCode('yaml', huge)).toBeNull();
  });

  it('refuses documents with more than 50 aliases, bomb or not', () => {
    const withAliases = (n: number) =>
      [
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        '  name: cfg',
        '  labels: &l { app: web }',
        'data:',
        ...Array.from({ length: n }, (_, i) => `  k${i}: *l`),
      ].join('\n');
    expect(suggestionForCode('yaml', withAliases(10))).toMatchObject({ kind: 'manifest' });
    expect(suggestionForCode('yaml', withAliases(51))).toBeNull();
  });

  it('checks the items of lists and blocks Secret-like objects by any value, refs excepted', () => {
    const secretItem = `apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Service
    metadata:
      name: web
      namespace: shop
  - apiVersion: v1
    kind: Secret
    metadata:
      name: db
      namespace: shop
    data:
      password: aHVudGVyMg==`;
    expect(suggestionForCode('yaml', secretItem)).toMatchObject({
      objects: [
        { kind: 'Service', name: 'web' },
        { kind: 'Secret', name: 'db' },
      ],
      blocked: 'secret',
    });
    const typedList = `apiVersion: v1
kind: SecretList
metadata:
  name: all
items:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: db
    stringData:
      password: guess`;
    expect(suggestionForCode('yaml', typedList)).toMatchObject({ blocked: 'secret' });
    const sealedTemplate = `apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db
spec:
  template:
    type: kubernetes.io/basic-auth`;
    expect(suggestionForCode('yaml', sealedTemplate)).toMatchObject({ blocked: 'secret' });
    for (const kind of ['ExternalSecret', 'ClusterExternalSecret', 'PushSecret']) {
      const refs = `apiVersion: external-secrets.io/v1beta1
kind: ${kind}
metadata:
  name: db
spec:
  secretStoreRef:
    name: vault
  data:
    - secretKey: password
      remoteRef:
        key: shop/db`;
      expect(suggestionForCode('yaml', refs)).toMatchObject({ blocked: null });
    }
  });

  it('skips empty queries and plain code', () => {
    expect(suggestionForCode('promql', '   ')).toBeNull();
    expect(extractSuggestions('No code here, just `inline`.')).toEqual([]);
    expect(extractSuggestions(`${F}\nkubectl get pods\n${F}`)).toEqual([]);
  });
});
