import { useEffect, useRef } from 'react';
import * as i18n from '@/i18n';
import type { AssistantSession } from '@/store/useAssistantStore';
import { AssistantMessage } from './AssistantMessage';
export function MessageList({
  session,
  disabled,
}: {
  session: AssistantSession | null;
  disabled: boolean;
}) {
  i18n.useLocale();
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    atBottom.current = true;
  }, [session?.id]);
  useEffect(() => {
    if (atBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [session?.messages]);
  return (
    <div
      ref={scroll}
      onScroll={() => {
        const e = scroll.current;
        if (e) atBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight < 60;
      }}
      className="min-h-0 flex-1 overflow-auto"
      role="log"
      aria-label={i18n.t('Assistant conversation')}
    >
      {session?.messages.length ? (
        session.messages.map((message) => (
          <AssistantMessage
            key={message.id}
            message={message}
            session={session}
            disabled={disabled}
          />
        ))
      ) : (
        <p className="text-fg-dim px-4 py-8 text-center text-[12px]">
          {i18n.t('Ask about your cluster, explain a selection, or draft a query.')}
        </p>
      )}
    </div>
  );
}
