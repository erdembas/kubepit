import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import { useState } from 'react';
import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import { useAssistantStore } from '@/store/useAssistantStore';
import { currentScope, currentScopeParts, sameScope } from '@/lib/ai/scope';
import { gatherExplainContext } from '@/lib/ai/context/gather';
import { ipc } from '@/lib/ipc';
import type { AiIntent } from '@/types';
export function Composer({ disabled, running }: { disabled: boolean; running: boolean }) {
  i18n.useLocale();
  const state = useAssistantStore();
  const [gathering, setGathering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (disabled || running || gathering || !state.draft.trim()) return;
    const guard = currentScope();
    setError(null);
    setGathering(true);
    try {
      let sections = state.composerSections;
      const scope = state.composerScope ?? guard;
      if (state.composerIntent === 'explain' && !sections.length) {
        const parts = currentScopeParts();
        if (!parts.clusterId || !parts.selection) {
          setError(i18n.t('Select an object to explain.'));
          return;
        }
        const { gvk, namespace, name } = parts.selection;
        const object = await ipc.resourceGet(parts.clusterId, gvk, namespace, name);
        sections = await gatherExplainContext(parts.clusterId, gvk, object);
      } else if (
        !sections.length &&
        ['kubectl', 'promql', 'logql'].includes(state.composerIntent)
      ) {
        sections = [
          {
            id: 'scope',
            kind: 'scope',
            label: scope.object?.name ?? scope.cluster_id ?? 'scope',
            priority: 0,
            format: 'text',
            content: JSON.stringify(scope),
          },
        ];
      }
      if (!sameScope(guard, currentScope())) {
        setError(i18n.t('The selected context changed. Start a new chat to continue.'));
        return;
      }
      await useAssistantStore.getState().ask({
        intent: state.composerIntent,
        message: state.draft,
        sections,
        scope,
        origin: state.composerOrigin ?? undefined,
      });
      if (!useAssistantStore.getState().error) useAssistantStore.getState().setDraft('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGathering(false);
    }
  };
  const intents: { value: AiIntent; label: string }[] = [
    { value: 'chat', label: i18n.t('Ask') },
    { value: 'explain', label: i18n.t('Explain selection') },
    { value: 'kubectl', label: 'kubectl' },
    { value: 'promql', label: 'PromQL' },
    { value: 'logql', label: 'LogQL' },
  ];
  return (
    <div className="border-border/70 border-t p-3">
      <div className="mb-2 flex flex-wrap gap-1">
        {intents.map((intent) => (
          <button
            key={intent.value}
            disabled={disabled || running || gathering}
            type="button"
            aria-pressed={state.composerIntent === intent.value}
            onClick={() => state.setComposerIntent(intent.value)}
            className={`rounded px-1.5 py-1 text-[10px] disabled:opacity-50 ${state.composerIntent === intent.value ? 'bg-accent/15 text-accent' : 'bg-fg/5 text-fg-dim hover:bg-fg/10'}`}
          >
            {intent.label}
          </button>
        ))}
      </div>
      <textarea
        aria-label={i18n.t('Message to assistant')}
        placeholder={i18n.t('Ask the assistant…')}
        value={state.draft}
        onChange={(event) => state.setDraft(event.target.value)}
        disabled={disabled || gathering}
        rows={3}
        className="border-border bg-surface text-fg focus:border-accent w-full resize-y rounded border p-2 text-[12px] outline-none disabled:opacity-50"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {error && (
        <p role="alert" className="text-status-error mt-1 text-[11px]">
          {assistantErrorMessage(error)}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        {running ? (
          <Button size="sm" onClick={() => void state.stop()}>
            {i18n.t('Stop')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={disabled || gathering || !state.draft.trim()}
            onClick={() => void submit()}
          >
            {gathering ? i18n.t('Gathering context…') : i18n.t('Send')}
          </Button>
        )}
      </div>
    </div>
  );
}
