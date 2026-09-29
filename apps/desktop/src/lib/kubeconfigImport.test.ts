import { afterEach, describe, expect, it } from 'vitest';
import * as i18n from '@/i18n/core';
import type { ClusterDef, KubeconfigSource } from '@/types';
import {
  initialKubeconfigChoice,
  kubeconfigChoiceProblem,
  kubeconfigErrorMessage,
  sourcePathOf,
} from './kubeconfigImport';
import { pendingNotice } from './kubeconfigNotice';

const source = (changes: Partial<KubeconfigSource> = {}): KubeconfigSource => ({
  path: '/fixture/source.yaml',
  current_context: 'missing',
  error: null,
  clusters: [
    { name: 'east', server: 'https://east.example.invalid' },
    { name: 'west', server: 'https://west.example.invalid' },
  ],
  users: ['reader', 'admin'],
  contexts: [],
  ...changes,
});
afterEach(() => i18n.setLocale('en', false));

describe('kubeconfig connection choices', () => {
  it('uses an available valid context when current-context and the saved context are stale', () => {
    const config = source({
      contexts: [
        { name: 'broken', cluster: 'gone', user: 'reader', namespace: null, server: null },
        {
          name: 'valid',
          cluster: 'east',
          user: 'reader',
          namespace: 'team',
          server: 'https://east.example.invalid',
        },
      ],
    });
    expect(initialKubeconfigChoice(config, 'old-context')).toMatchObject({
      create: false,
      context: 'valid',
    });
    expect(kubeconfigChoiceProblem(config, initialKubeconfigChoice(config))).toBeNull();
  });
  it('retains a missing current-context as the suggested new name without guessing a cluster or user', () => {
    const config = source();
    const choice = initialKubeconfigChoice(config);
    expect(choice).toEqual({ create: true, context: 'missing', cluster: '', user: null });
    expect(kubeconfigChoiceProblem(config, choice)).toContain('Choose a cluster');
    expect(kubeconfigChoiceProblem(config, { ...choice, cluster: 'west' })).toContain(
      'Choose a user',
    );
    expect(
      kubeconfigChoiceProblem(config, { ...choice, cluster: 'west', user: 'reader' }),
    ).toBeNull();
    expect(kubeconfigChoiceProblem(config, { ...choice, cluster: 'west', user: '' })).toBeNull();
  });
  it('supports anonymous connection when no users exist and avoids overwriting a broken context', () => {
    const config = source({
      current_context: 'east',
      clusters: [{ name: 'east', server: 'https://east.example.invalid' }],
      users: [],
      contexts: [{ name: 'east', cluster: 'gone', user: '', server: null, namespace: null }],
    });
    const choice = initialKubeconfigChoice(config);
    expect(choice).toEqual({ create: true, context: 'east-2', cluster: 'east', user: '' });
    expect(kubeconfigChoiceProblem(config, choice)).toBeNull();
    expect(kubeconfigChoiceProblem(config, { ...choice, context: ' east ' })).toContain(
      'already exists',
    );
  });
  it('rejects missing server, user and context references before importing', () => {
    const config = source();
    const choice = { create: true, context: 'mine', cluster: 'west', user: 'reader' };
    expect(
      kubeconfigChoiceProblem(source({ clusters: [{ name: 'west', server: null }] }), choice),
    ).toContain('no API server');
    expect(kubeconfigChoiceProblem(config, { ...choice, user: 'removed' })).toContain(
      'Choose a user from',
    );
    expect(kubeconfigChoiceProblem(config, { ...choice, create: false })).toContain(
      'Choose a kubeconfig context',
    );
    expect(kubeconfigChoiceProblem(config, { ...choice, context: '  ' })).toContain(
      'Give the context a name',
    );
  });
  it('suppresses discovery notices using original-file provenance after a managed import', () => {
    const registered = {
      id: 'fixture',
      context: 'ctx',
      managed: true,
      kubeconfig_path: '/managed/copy.yaml',
      source_kubeconfig_path: '/fixture/source.yaml',
    } as ClusterDef;
    expect(sourcePathOf(registered)).toBe('/fixture/source.yaml');
    expect(sourcePathOf({ kubeconfig_path: '/legacy/source.yaml' })).toBe('/legacy/source.yaml');
    const notice = pendingNotice(
      {
        paths: ['/fixture/source.yaml'],
        reconnect: [],
        new_contexts: [
          { path: '/fixture/source.yaml', context: 'ctx', server: null },
          { path: '/fixture/source.yaml', context: 'other', server: null },
        ],
      },
      [registered],
      {},
    );
    expect(notice.newContexts.map((c) => c.context)).toEqual(['other']);
  });
});

describe('localized kubeconfig failures', () => {
  it('translates owned diagnostics while preserving context names and technical errors', () => {
    const raw = 'context "musteri-prod" not found: the kubeconfig defines no contexts';
    expect(kubeconfigErrorMessage(raw)).toContain('Context "musteri-prod" was not found');
    i18n.setLocale('tr', false);
    expect(kubeconfigErrorMessage(new Error('invalid kubeconfig YAML'))).toBe(
      'Kubeconfig YAML içeriği geçersiz.',
    );
    expect(kubeconfigErrorMessage(raw)).toContain('"musteri-prod" bağlamı bulunamadı');
    expect(kubeconfigErrorMessage('system I/O error: EACCES /fixture/example.yaml')).toBe(
      'system I/O error: EACCES /fixture/example.yaml',
    );
  });
});
