import * as i18n from '@/i18n';
import type { AiMessage } from '@/lib/ai/reducer';
import { usageSummary } from '@/lib/ai/format';
export function UsageLine({ message, local }: { message: AiMessage; local: boolean }) {
  i18n.useLocale();
  const { stop } = message;
  return (
    <div className="text-fg-dim mt-2 space-y-1 text-[11px]">
      {message.usage && <p>{usageSummary(message.usage, message.cost, local)}</p>}
      {stop === 'cancelled' && <p>{i18n.t('Stopped')}</p>}
      {stop === 'refusal' && <p>{i18n.t('Declined by the model')}</p>}
      {stop === 'max-tokens' && <p>{i18n.t('Answer truncated')}</p>}
      {stop === 'tool-limit' && <p>{i18n.t('Read-only tool limit reached')}</p>}
      {message.fallback && <p>{i18n.t('Answered by {model}', { model: message.fallback.to })}</p>}
      {message.retry && !stop && (
        <p>
          {i18n.t('Retry {attempt} after {seconds} seconds', {
            attempt: i18n.number(message.retry.attempt),
            seconds: i18n.number(message.retry.delay_ms / 1000),
          })}
        </p>
      )}
    </div>
  );
}
