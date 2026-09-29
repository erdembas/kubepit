import * as i18n from '@/i18n/core';
import type { AssistantSession } from '@/store/useAssistantStore';
import type { ClusterDef } from '@/types';

export interface ConversationSummary {
  session: AssistantSession;
  title: string;
  snippet: string;
  clusterName: string;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Search is forgiving of Turkish dotted/dotless I even while the UI is English. */
function searchText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i');
}

export function conversationSummaries(
  sessions: readonly AssistantSession[],
  clusters: readonly Pick<ClusterDef, 'id' | 'name'>[],
  query = '',
): ConversationSummary[] {
  const names = new Map(clusters.map((cluster) => [cluster.id, cluster.name]));
  const words = searchText(query).trim().split(/\s+/).filter(Boolean);
  return sessions
    .map((session) => {
      const title =
        oneLine(session.messages.find((message) => message.role === 'user')?.text ?? '') ||
        i18n.t('New chat');
      const latest = [...session.messages].reverse().find((message) => message.text.trim());
      return {
        session,
        title,
        snippet: latest ? oneLine(latest.text) : i18n.t('No messages yet'),
        clusterName: session.clusterId
          ? (names.get(session.clusterId) ?? session.clusterId)
          : i18n.t('No cluster selected'),
      };
    })
    .filter(({ session, title, clusterName }) => {
      const text = searchText(
        [
          title,
          clusterName,
          session.model,
          session.scope.namespace ?? '',
          ...session.messages.map((m) => m.text),
        ].join(' '),
      );
      return words.every((word) => text.includes(word));
    })
    .sort(
      (a, b) =>
        b.session.updatedAt - a.session.updatedAt ||
        b.session.createdAt - a.session.createdAt ||
        a.session.id.localeCompare(b.session.id),
    );
}

export function conversationIsToday(timestamp: number, now = Date.now()): boolean {
  const date = new Date(timestamp);
  const today = new Date(now);
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}
