import { useState } from 'react';
import { MessageSquare, Search, X } from 'lucide-react';
import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { conversationIsToday, conversationSummaries } from '@/lib/ai/conversations';
import type { AssistantSession } from '@/store/useAssistantStore';
import type { ClusterDef } from '@/types';

interface Props {
  sessions: AssistantSession[];
  activeSessionId: string | null;
  clusters: ClusterDef[];
  onSelect: (id: string) => void;
  onCloseSession: (id: string) => void;
  onDismiss: () => void;
}

export function ConversationHistory({
  sessions,
  activeSessionId,
  clusters,
  onSelect,
  onCloseSession,
  onDismiss,
}: Props) {
  i18n.useLocale();
  const [query, setQuery] = useState('');
  const rows = conversationSummaries(sessions, clusters, query);
  const now = Date.now();
  const groups = [
    {
      title: i18n.t('Today'),
      rows: rows.filter(({ session }) => conversationIsToday(session.updatedAt, now)),
    },
    {
      title: i18n.t('Earlier'),
      rows: rows.filter(({ session }) => !conversationIsToday(session.updatedAt, now)),
    },
  ];
  return (
    <section
      id="assistant-chat-history"
      aria-label={i18n.t('Chats in this window')}
      className="bg-surface-muted/40 flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }
      }}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-2">
        <h3 className="text-fg-dim text-[11px] font-semibold tracking-wider uppercase">
          {i18n.t('Chats in this window')}
        </h3>
        <Button
          size="xs"
          variant="ghost"
          className="hover:bg-fg/5 h-6 w-6 p-0"
          aria-label={i18n.t('Close history')}
          title={i18n.t('Close history')}
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      <div className="relative mx-3 my-2">
        <Search
          className="text-fg-dim pointer-events-none absolute top-2 left-2 h-3.5 w-3.5"
          aria-hidden="true"
        />
        <Input
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={i18n.t('Search chats…')}
          aria-label={i18n.t('Search chats…')}
          className="bg-surface h-8 pl-7"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2">
        {rows.length === 0 ? (
          <div className="text-fg-dim px-4 py-6 text-center">
            <MessageSquare className="mx-auto mb-2 h-5 w-5 opacity-60" aria-hidden="true" />
            <p className="text-fg-muted text-[12px] font-medium">
              {sessions.length === 0 ? i18n.t('No chats yet') : i18n.t('No matching chats')}
            </p>
            <p className="mt-1 text-[11px]">
              {sessions.length === 0
                ? i18n.t('Your conversations will appear here until you close this window.')
                : i18n.t('Try a different search.')}
            </p>
          </div>
        ) : (
          groups.map(
            (group) =>
              group.rows.length > 0 && (
                <div key={group.title}>
                  <p className="text-fg-dim px-2 pt-2 pb-1 text-[11px] font-medium tracking-wider uppercase">
                    {group.title}
                  </p>
                  <ul>
                    {group.rows.map(({ session, title, snippet, clusterName }) => {
                      const active = session.id === activeSessionId;
                      return (
                        <li
                          key={session.id}
                          className={cn(
                            'group rounded-app-sm relative flex items-start',
                            active ? 'bg-accent/8' : 'hover:bg-fg/5',
                          )}
                        >
                          {active && (
                            <span
                              className="bg-accent absolute inset-y-2 left-0 w-0.5 rounded-full"
                              aria-hidden="true"
                            />
                          )}
                          <button
                            type="button"
                            aria-current={active ? 'true' : undefined}
                            className="focus-visible:ring-accent rounded-app-sm min-w-0 flex-1 px-3 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset"
                            onClick={() => {
                              onSelect(session.id);
                              onDismiss();
                            }}
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span
                                className="text-fg min-w-0 flex-1 truncate text-[12px] font-medium"
                                title={title}
                              >
                                {title}
                              </span>
                              {session.busy && (
                                <span
                                  className="bg-accent h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                                  role="status"
                                  aria-label={i18n.t('Responding…')}
                                />
                              )}
                            </span>
                            <span className="text-fg-muted mt-0.5 block truncate text-[11px]">
                              {snippet}
                            </span>
                            <span className="text-fg-dim mt-1 flex min-w-0 items-center gap-1.5 text-[11px]">
                              <span className="min-w-0 truncate" title={clusterName}>
                                {clusterName}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="min-w-0 truncate" title={session.model}>
                                {session.model}
                              </span>
                              <time
                                className="ml-auto shrink-0 tabular-nums"
                                dateTime={new Date(session.updatedAt).toISOString()}
                                title={i18n.date(session.updatedAt, {
                                  dateStyle: 'medium',
                                  timeStyle: 'short',
                                })}
                              >
                                {i18n.date(
                                  session.updatedAt,
                                  conversationIsToday(session.updatedAt, now)
                                    ? { hour: '2-digit', minute: '2-digit' }
                                    : { month: 'short', day: 'numeric' },
                                )}
                              </time>
                            </span>
                          </button>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="hover:bg-fg/10 mt-1.5 mr-1 h-6 w-6 p-0 opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label={i18n.t('Close chat: {title}', { title })}
                            title={i18n.t('Close chat')}
                            onClick={() => onCloseSession(session.id)}
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ),
          )
        )}
      </div>
    </section>
  );
}
