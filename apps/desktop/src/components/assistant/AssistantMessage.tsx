import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import * as i18n from '@/i18n';
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
    <article className="border-border/40 border-b px-3 py-3 last:border-0">
      <p className="text-fg-dim mb-1 text-[10px] font-semibold tracking-wider uppercase">
        {message.role === 'user' ? i18n.t('You') : i18n.t('Assistant')}
      </p>
      {message.role === 'user' ? (
        <p className="text-fg text-[12px] break-words whitespace-pre-wrap">{message.text}</p>
      ) : (
        <Markdown
          source={message.text}
          variant="chat"
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
              className="bg-fg/5 text-fg-dim rounded px-1.5 py-0.5 text-[10px]"
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
        <p role="status" className="text-fg-dim mt-2 text-[11px]">
          {message.thinking ? i18n.t('Thinking…') : i18n.t('Responding…')}
        </p>
      )}
      {message.error && (
        <p
          role="alert"
          className="text-status-error mt-2 text-[12px] break-words whitespace-pre-wrap"
        >
          {assistantErrorMessage(message.error)}
        </p>
      )}
      {message.role === 'assistant' && <UsageLine message={message} local={session.local} />}
      {message.role === 'assistant' && message.stop && message.retryable && (
        <Button
          size="xs"
          className="mt-2"
          disabled={disabled}
          onClick={() => void useAssistantStore.getState().retry(message.id)}
        >
          {i18n.t('Retry')}
        </Button>
      )}
      {message.role === 'assistant' && message.intent === 'explain' && message.stop === 'end' && (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button size="xs" disabled={disabled} onClick={() => ask('fix', i18n.t('Suggest a fix'))}>
            {i18n.t('Suggest a fix')}
          </Button>
          <Button size="xs" disabled={disabled} onClick={() => ask('chat', i18n.t('Explain more'))}>
            {i18n.t('Explain more')}
          </Button>
        </div>
      )}
    </article>
  );
}
