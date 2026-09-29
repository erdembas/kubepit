import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import { useState } from 'react';
import * as i18n from '@/i18n';
import type { AiReadiness } from '@/lib/ai/readiness';
import { isLocalAgent } from '@/lib/ai/localAgents';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/Button';
import { enableAssistantFor } from './enableCluster';
import { useAssistantNavigation } from './navigation';
export function NotReady({ readiness }: { readiness: Exclude<AiReadiness, { state: 'ready' }> }) {
  i18n.useLocale();
  const revealWorkbench = useAssistantNavigation();
  const [saving, setSaving] = useState(false);
  const label =
    readiness.state === 'off'
      ? i18n.t('The assistant is turned off.')
      : readiness.state === 'no-provider'
        ? i18n.t('Choose a model provider in Assistant settings.')
        : readiness.state === 'blocked'
          ? isLocalAgent(readiness.provider.kind)
            ? i18n.t(
                'This agent is unavailable or blocked by the local-only or network policy. Check its installation in Assistant settings.',
              )
            : i18n.t('This provider is blocked by the local-only or network policy.')
          : readiness.state === 'no-key'
            ? i18n.t('Set a provider API key in Assistant settings.')
            : readiness.state === 'no-model'
              ? i18n.t('Choose a model in Assistant settings.')
              : readiness.reacknowledge
                ? i18n.t(
                    'This cluster is now production. Confirm its name to enable the assistant again.',
                  )
                : i18n.t('Enable the assistant for this cluster before sending context.');
  return (
    <div className="border-border text-fg-muted m-3 space-y-3 rounded border p-3 text-[12px]">
      <p>{label}</p>
      {readiness.state === 'no-key' && readiness.keyError && (
        <p className="text-status-error break-words">{assistantErrorMessage(readiness.keyError)}</p>
      )}
      {readiness.state === 'cluster' ? (
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void enableAssistantFor(readiness.cluster).finally(() => setSaving(false));
          }}
        >
          {i18n.t('Enable for {name}', { name: readiness.cluster.name })}
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => {
            useAppStore.getState().openSettings('assistant');
            revealWorkbench();
          }}
        >
          {i18n.t('Assistant settings')}
        </Button>
      )}
    </div>
  );
}
