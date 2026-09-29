import { useState } from 'react';
import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import type { AiMessageTool } from '@/lib/ai/reducer';
import { redactionSummary } from '@/lib/ai/format';
import { useAssistantStore } from '@/store/useAssistantStore';
import type { AiToolDecision, AiToolStatus } from '@/types';
function statusLabel(status: AiToolStatus) {
  switch (status) {
    case 'running':
      return i18n.t('Running');
    case 'pending-approval':
      return i18n.t('Awaiting send');
    case 'done':
      return i18n.t('Sent');
    case 'denied':
      return i18n.t('Not sent');
    case 'error':
      return i18n.t('Error');
  }
}
export function ToolCallCard({ tool, active }: { tool: AiMessageTool; active: boolean }) {
  i18n.useLocale();
  const [deciding, setDeciding] = useState(false);
  const decide = async (decision: AiToolDecision) => {
    setDeciding(true);
    try {
      await useAssistantStore.getState().decide(tool.id, decision);
    } finally {
      setDeciding(false);
    }
  };
  return (
    <div className="border-border/70 my-2 rounded border p-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="text-fg">{tool.name}</code>
        <span className="text-fg-dim">{statusLabel(tool.status)}</span>
      </div>
      <details className="mt-1">
        <summary className="text-fg-dim cursor-pointer">{i18n.t('Arguments')}</summary>
        <pre className="mt-1 overflow-auto break-words whitespace-pre-wrap">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
      </details>
      {tool.result_preview !== null && (
        <details className="mt-1">
          <summary className="text-fg-dim cursor-pointer">{i18n.t('Result preview')}</summary>
          <pre className="mt-1 max-h-64 overflow-auto break-words whitespace-pre-wrap">
            {tool.result_preview}
          </pre>
        </details>
      )}
      {tool.redactions && redactionSummary(tool.redactions) && (
        <p className="text-fg-dim mt-1">
          {i18n.t('Redacted: {summary}', { summary: redactionSummary(tool.redactions) })}
        </p>
      )}
      {tool.status === 'pending-approval' && active && (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button size="xs" disabled={deciding} onClick={() => void decide('send')}>
            {i18n.t('Send')}
          </Button>
          <Button size="xs" disabled={deciding} onClick={() => void decide('send-session')}>
            {i18n.t('Send for this session')}
          </Button>
          <Button size="xs" variant="ghost" disabled={deciding} onClick={() => void decide('deny')}>
            {i18n.t("Don't send")}
          </Button>
        </div>
      )}
    </div>
  );
}
