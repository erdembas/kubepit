import { beforeEach, describe, expect, it } from 'vitest';
import * as i18n from '@/i18n/core';
import type { AssistantSession } from '@/store/useAssistantStore';
import { newAiMessage } from './reducer';
import { conversationIsToday, conversationSummaries } from './conversations';

function session(id: string, changes: Partial<AssistantSession> = {}): AssistantSession {
  return {
    id,
    createdAt: 100,
    updatedAt: 100,
    clusterId: 'dev',
    scope: { cluster_id: 'dev', namespace: 'checkout', object: null },
    messages: [],
    runId: null,
    busy: false,
    cancelRequested: false,
    origin: null,
    local: false,
    providerId: 'provider',
    settingsKey: '',
    model: 'demo-model',
    requests: {},
    requestUiScopes: {},
    ...changes,
  };
}

const message = (text: string, role: 'user' | 'assistant' = 'user') =>
  newAiMessage({ id: text, role, intent: 'chat', text });
const clusters = [{ id: 'dev', name: 'Development' }];

beforeEach(() => i18n.setLocale('en', false));

describe('conversation history', () => {
  it('uses the first user message as the title and latest non-empty message as the snippet', () => {
    const [row] = conversationSummaries(
      [
        session('one', {
          messages: [
            message('  Why\n is it failing?  '),
            message('Check the\n events.', 'assistant'),
            message('', 'assistant'),
          ],
        }),
      ],
      clusters,
    );
    expect(row).toMatchObject({
      title: 'Why is it failing?',
      snippet: 'Check the events.',
      clusterName: 'Development',
    });
  });

  it('provides useful labels for a preview without messages and a removed cluster', () => {
    const [empty] = conversationSummaries([session('empty')], clusters);
    expect(empty).toMatchObject({ title: 'New chat', snippet: 'No messages yet' });
    const [missing] = conversationSummaries(
      [session('missing', { clusterId: 'old-cluster' })],
      clusters,
    );
    expect(missing?.clusterName).toBe('old-cluster');
    const [unscoped] = conversationSummaries([session('unscoped', { clusterId: null })], clusters);
    expect(unscoped?.clusterName).toBe('No cluster selected');
  });

  it('sorts by last activity then creation time without mutating the input', () => {
    const input = Object.freeze([
      session('old', { createdAt: 10, updatedAt: 20 }),
      session('new', { createdAt: 30, updatedAt: 40 }),
      session('resumed', { createdAt: 5, updatedAt: 50 }),
      session('tie', { createdAt: 35, updatedAt: 40 }),
    ]);
    expect(conversationSummaries(input, clusters).map((row) => row.session.id)).toEqual([
      'resumed',
      'tie',
      'new',
      'old',
    ]);
    expect(input.map((item) => item.id)).toEqual(['old', 'new', 'resumed', 'tie']);
  });

  it('searches older messages and cluster, model and namespace metadata using every query word', () => {
    const sessions = [
      session('match', {
        messages: [
          message('Why?'),
          message('ImagePullBackOff', 'assistant'),
          message('continue'),
          message('Latest response', 'assistant'),
        ],
      }),
      session('other', { messages: [message('A healthy pod')] }),
    ];
    expect(
      conversationSummaries(sessions, clusters, 'imagepull development demo-model checkout').map(
        (row) => row.session.id,
      ),
    ).toEqual(['match']);
    expect(conversationSummaries(sessions, clusters, 'imagepull absent')).toEqual([]);
    expect(conversationSummaries(sessions, clusters, '  ')).toHaveLength(2);
  });

  it.each([
    ['İSTANBUL ödeme SIKIŞTI', 'istanbul odeme sikisti'],
    ['IĞDIR pod', 'ığdır'],
    ['ışık hatası', 'ISIK HATASI'],
  ])('finds Turkish text %s while the application is English', (text, query) => {
    expect(
      conversationSummaries(
        [session('turkish', { messages: [message(text)] })],
        clusters,
        query,
      ).map((row) => row.session.id),
    ).toEqual(['turkish']);
  });

  it('groups by local calendar day rather than the last 24 hours', () => {
    const now = new Date(2026, 8, 29, 0, 5).getTime();
    expect(conversationIsToday(new Date(2026, 8, 29, 0, 1).getTime(), now)).toBe(true);
    expect(conversationIsToday(new Date(2026, 8, 28, 23, 59).getTime(), now)).toBe(false);
  });
});
