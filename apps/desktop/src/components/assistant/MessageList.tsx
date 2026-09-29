import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Sparkles } from 'lucide-react';
import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
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
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const jumpToLatest = useCallback(() => {
    atBottom.current = true;
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    setShowLatest(false);
  }, []);
  useLayoutEffect(() => {
    jumpToLatest();
  }, [session?.id, jumpToLatest]);
  useLayoutEffect(() => {
    if (atBottom.current) jumpToLatest();
  }, [session?.messages, jumpToLatest]);
  useLayoutEffect(() => {
    const viewport = scroll.current;
    const body = content.current;
    if (!viewport || !body) return;
    // Reflowing a wide/fullscreen conversation must not pull a reader away
    // from an older message. Only a conversation already pinned follows it.
    const observer = new ResizeObserver(() => {
      if (atBottom.current) viewport.scrollTop = viewport.scrollHeight;
      setShowLatest(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight >= 60);
    });
    observer.observe(viewport);
    observer.observe(body);
    return () => observer.disconnect();
  }, [session?.id]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroll}
        onScroll={() => {
          const e = scroll.current;
          if (!e) return;
          atBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight < 60;
          setShowLatest(!atBottom.current);
        }}
        className="overlay-scroll min-h-0 flex-1 overflow-auto overscroll-contain"
        role="log"
        aria-label={i18n.t('Assistant conversation')}
      >
        <div ref={content} className="mx-auto w-full max-w-[860px] space-y-7 px-4 py-6">
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
            <div className="mx-auto flex max-w-[300px] flex-col items-center py-12 text-center">
              <span className="bg-accent/10 text-accent mb-4 flex h-10 w-10 items-center justify-center rounded-2xl">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="text-fg text-[13px] font-medium">{i18n.t('Explore your cluster')}</p>
              <p className="text-fg-dim mt-2 text-[12px] leading-relaxed">
                {i18n.t('Ask about your cluster, explain a selection, or draft a query.')}
              </p>
            </div>
          )}
        </div>
      </div>
      {showLatest && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            size="sm"
            variant="ghost"
            className="bg-surface-raised border-border/70 pointer-events-auto rounded-full border px-3 shadow-sm"
            leftIcon={<ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />}
            onClick={jumpToLatest}
          >
            {i18n.t('Jump to latest')}
          </Button>
        </div>
      )}
    </div>
  );
}
