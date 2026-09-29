import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import { useAssistantStore } from '@/store/useAssistantStore';
import { sectionKindLabel, redactionSummary, formatCost } from '@/lib/ai/format';
import { BudgetBar } from './BudgetBar';
import type { AiPreview } from '@/types';
export function ContextPreview({ preview, mismatch }: { preview: AiPreview; mismatch: boolean }) {
  i18n.useLocale();
  const preparing = useAssistantStore((s) => s.preparing);
  const error = useAssistantStore((s) => s.error);
  return (
    <section
      aria-label={i18n.t('Review context')}
      className="border-border bg-surface m-2 max-h-[55vh] overflow-auto rounded border p-3 text-[12px]"
    >
      <h3 className="text-fg font-semibold">{i18n.t('Review context')}</h3>
      <p className="text-fg-dim mt-1 break-all">
        {preview.provider_id} · {preview.model}
        {preview.local ? ` · ${i18n.t('Local')}` : ''}
      </p>
      {preview.production && (
        <p className="bg-status-warning/10 text-status-warning my-2 rounded p-2">
          {i18n.t('Production cluster: {name}', { name: preview.cluster_name })}
        </p>
      )}
      <p className="text-fg-dim my-2">
        {i18n.plural(
          '{count} earlier message already sent',
          '{count} earlier messages already sent',
          preview.earlier_messages,
        )}
      </p>
      <details className="border-border/60 my-2 rounded border p-2">
        <summary className="cursor-pointer">{i18n.t('Message to send')}</summary>
        <pre className="mt-2 font-mono text-[11px] break-words whitespace-pre-wrap">
          {preview.message}
        </pre>
      </details>
      {preview.sections.map((section) => (
        <div key={section.id} className="border-border/60 my-2 rounded border p-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!section.excluded}
              disabled={preparing}
              onChange={() => void useAssistantStore.getState().excludeSection(section.id)}
              className="accent-accent"
            />
            <span className="font-medium">{sectionKindLabel(section.kind)}</span>
            <span className="text-fg-dim ml-auto">
              {i18n.t('≈{count} tokens', { count: i18n.number(section.tokens) })}
            </span>
          </label>
          <details className="mt-1">
            <summary className="text-fg-muted cursor-pointer break-all">{section.label}</summary>
            <pre className="mt-2 max-h-64 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap">
              {section.text}
            </pre>
          </details>
          {section.trimmed && (
            <p className="text-status-warning mt-1">
              {i18n.t('Trimmed from ≈{count} tokens', {
                count: i18n.number(section.original_tokens),
              })}
            </p>
          )}
          {redactionSummary(section.redactions) && (
            <p className="text-fg-dim mt-1">
              {i18n.t('Redacted: {summary}', { summary: redactionSummary(section.redactions) })}
            </p>
          )}
        </div>
      ))}
      {preview.tools.length > 0 && (
        <p className="text-fg-dim my-2 break-words">
          {i18n.t('Available read-only tools: {tools}', { tools: preview.tools.join(', ') })}
        </p>
      )}
      <BudgetBar
        used={preview.estimated_input_tokens}
        budget={preview.budget}
        window={preview.context_window}
      />
      {preview.estimated_cost !== null && (
        <p className="text-fg-dim mt-2">
          {i18n.t('Estimated input cost: {cost}', { cost: formatCost(preview.estimated_cost) })}
        </p>
      )}
      {mismatch && (
        <p role="alert" className="text-status-warning mt-2">
          {i18n.t('The selected context changed. Cancel this preview and ask again.')}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" onClick={() => useAssistantStore.getState().cancelPreview()}>
          {i18n.t('Cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={preparing || mismatch || !!error}
          onClick={() => void useAssistantStore.getState().send()}
        >
          {preparing ? i18n.t('Preparing preview…') : i18n.t('Send')}
        </Button>
      </div>
    </section>
  );
}
