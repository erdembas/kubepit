import { describe, expect, it } from 'vitest';
import { importedKubeconfigSource, parseKubeconfigText } from './kubeconfig';

const fixture = `apiVersion: v1
kind: Config
current-context: missing
clusters:
- name: east
  cluster: {server: https://east.example.invalid, certificate-authority-data: private-ca}
- name: west
  cluster: {server: https://west.example.invalid}
users:
- name: reader
  user: {token: private-reader-token}
- name: admin
  user: {password: private-password}
contexts: []
`;

describe('demo kubeconfig import metadata', () => {
  it('accepts contextless files and exposes names/server metadata, never credentials', () => {
    const source = parseKubeconfigText(fixture);
    expect(source.error).toBeNull();
    expect(source.contexts).toEqual([]);
    expect(source.users).toEqual(['reader', 'admin']);
    expect(source.clusters).toHaveLength(2);
    expect(JSON.stringify(source)).not.toContain('private-');
  });
  it('does not echo YAML or secret fragments when parsing fails', () => {
    const source = parseKubeconfigText('users: [{name: identity, user: {token: PRIVATE-SECRET}');
    expect(source.error).toBe('The kubeconfig YAML is invalid.');
    expect(JSON.stringify(source)).not.toContain('PRIVATE-SECRET');
  });
  it('creates an isolated selected connection and keeps the source unchanged', () => {
    const source = parseKubeconfigText(fixture);
    const before = structuredClone(source);
    const copied = importedKubeconfigSource(
      source,
      {
        context: 'my-connection',
        create_context: { cluster: 'west', user: 'reader', namespace: 'team-b' },
      },
      '/managed/fixture.yaml',
    );
    expect(copied).toEqual({
      path: '/managed/fixture.yaml',
      current_context: 'my-connection',
      error: null,
      contexts: [
        {
          name: 'my-connection',
          cluster: 'west',
          user: 'reader',
          namespace: 'team-b',
          server: 'https://west.example.invalid',
        },
      ],
      clusters: [{ name: 'west', server: 'https://west.example.invalid' }],
      users: ['reader'],
    });
    expect(source).toEqual(before);
  });
  it('copies one existing context and supports anonymous new contexts', () => {
    const source = parseKubeconfigText(
      fixture.replace(
        'contexts: []',
        'contexts: [{name: selected, context: {cluster: east, user: admin}}, {name: other, context: {cluster: west, user: reader}}]',
      ),
    );
    const copy = importedKubeconfigSource(
      source,
      { context: 'selected' },
      '/managed/existing.yaml',
    );
    expect(copy.contexts.map((c) => c.name)).toEqual(['selected']);
    expect(copy.users).toEqual(['admin']);
    expect(copy.clusters.map((c) => c.name)).toEqual(['east']);
    const anonymous = importedKubeconfigSource(
      source,
      { context: 'anonymous', create_context: { cluster: 'west', user: null, namespace: null } },
      '/managed/anonymous.yaml',
    );
    expect(anonymous.users).toEqual([]);
    expect(() =>
      importedKubeconfigSource(
        source,
        { context: 'selected', create_context: { cluster: 'east', user: null, namespace: null } },
        '/managed/invalid.yaml',
      ),
    ).toThrow('already exists');
  });
});
