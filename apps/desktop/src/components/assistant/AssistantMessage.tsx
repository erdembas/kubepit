import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import { Sparkles } from 'lucide-react';
import * as i18n from '@/i18n';
import { cn } from '@/lib/cn';
import { Markdown } from '@/components/workbench/common/Markdown';
import { Button } from '@/components/ui/Button';
import { useAssistantStore, type AssistantSession } from '@/store/useAssistantStore';
import type { AiMessage } from '@/lib/ai/reducer';
import { sectionKindLabel } from '@/lib/ai/format';
import { ToolCallCard } from './ToolCallCard';
import { SuggestionActions } from './SuggestionActions';
import { UsageLine } from './UsageLine';
export function AssistantMessage({
  message,
  session,
  disabled,
}: {
  message: AiMessage;
  session: AssistantSession;
  disabled: boolean;
}) {
  i18n.useLocale();
  const ask = (intent: 'fix' | 'chat', text: string) =>
    void useAssistantStore
      .getState()
      .ask({ intent, message: text, sections: [], scope: session.scope });
  return (
    <article
      className={cn(
        'min-w-0',
        message.role === 'user'
          ? 'bg-fg/5 ml-auto w-fit max-w-[90%] rounded-2xl rounded-tr-md px-3.5 py-3'
          : 'w-full',
      )}
    >
      <p
        className={cn(
          'text-fg-dim mb-2 flex items-center gap-2 text-[11px] font-medium tracking-wider uppercase',
          message.role === 'user' && 'sr-only',
        )}
      >
        {message.role === 'assistant' && (
          <Sparkles className="text-accent h-3.5 w-3.5" aria-hidden="true" />
        )}
        {message.role === 'user' ? i18n.t('You') : i18n.t('Assistant')}
      </p>
      {message.role === 'user' ? (
        <p className="text-fg text-[13px] leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
          {message.text}
        </p>
      ) : (
        <Markdown
          source={message.text}
          variant="chat"
          className="text-[13px] leading-[1.75] [overflow-wrap:anywhere] [&>p:first-child]:mt-0 [&>p:last-child]:mb-0"
          renderCode={(lang, text) => (
            <SuggestionActions
              lang={lang}
              text={text}
              message={message}
              clusterId={session.clusterId}
              namespace={session.scope.namespace}
              origin={session.origin}
            />
          )}
        />
      )}
      {message.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {message.attachments.map((s, index) => (
            <span
              key={index}
              className="bg-fg/5 text-fg-muted max-w-full truncate rounded-md px-1.5 py-0.5 text-[11px]"
              title={s.label}
            >
              {sectionKindLabel(s.kind)}
            </span>
          ))}
        </div>
      )}
      {message.tools.map((tool) => (
        <ToolCallCard
          key={tool.id}
          tool={tool}
          active={message.stop === null && session.busy && !session.cancelRequested}
        />
      ))}
      {message.status === 'streaming' && !message.stop && (
        <p role="status" className="text-fg-dim mt-3 flex items-center gap-2 text-[11px]">
          <span className="bg-accent h-1.5 w-1.5 rounded-full motion-safe:animate-pulse" />
          {message.thinking ? i18n.t('Thinking…') : i18n.t('Responding…')}
        </p>
      )}
      {message.error && (
        <p
          role="alert"
          className="border-status-error/20 bg-status-error/5 text-status-error mt-3 rounded-lg border px-3 py-2 text-[12px] leading-relaxed break-words whitespace-pre-wrap"
        >
          {assistantErrorMessage(message.error)}
        </p>
      )}
      {message.role === 'assistant' && <UsageLine message={message} local={session.local} />}
      {message.role === 'assistant' && message.stop && message.retryable && (
        <Button
          size="xs"
          variant="ghost"
          className="hover:bg-fg/5 mt-3"
          disabled={disabled}
          onClick={() => void useAssistantStore.getState().retry(message.id)}
        >
          {i18n.t('Retry')}
        </Button>
      )}
      {message.role === 'assistant' && message.intent === 'explain' && message.stop === 'end' && (
        <div className="mt-3 flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="ghost"
            className="bg-fg/[0.03] hover:bg-fg/5"
            disabled={disabled}
            onClick={() => ask('fix', i18n.t('Suggest a fix'))}
          >
            {i18n.t('Suggest a fix')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="bg-fg/[0.03] hover:bg-fg/5"
            disabled={disabled}
            onClick={() => ask('chat', i18n.t('Explain more'))}
          >
            {i18n.t('Explain more')}
          </Button>
        </div>
      )}
    </article>
  );
}
