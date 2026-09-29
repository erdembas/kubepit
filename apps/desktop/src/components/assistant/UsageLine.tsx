import * as i18n from '@/i18n';
import { TriangleAlert } from 'lucide-react';
import type { AiMessage } from '@/lib/ai/reducer';
import { usageSummary } from '@/lib/ai/format';
export function UsageLine({ message, local }: { message: AiMessage; local: boolean }) {
  i18n.useLocale();
  const { stop } = message;
  const warning =
    stop === 'refusal'
      ? i18n.t('Declined by the model')
      : stop === 'max-tokens'
        ? i18n.t('Answer truncated')
        : stop === 'tool-limit'
          ? i18n.t('Read-only tool limit reached')
          : null;
  return (
    <div className="text-fg-dim mt-3 space-y-1.5 text-[11px] leading-relaxed">
      {message.usage && (
        <p className="tabular-nums">{usageSummary(message.usage, message.cost, local)}</p>
      )}
      {stop === 'cancelled' && <p>{i18n.t('Stopped')}</p>}
      {warning && (
        <p className="bg-tone-warning/10 text-tone-warning-fg flex w-fit items-center gap-1.5 rounded-md px-2 py-1">
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
          {warning}
        </p>
      )}
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
