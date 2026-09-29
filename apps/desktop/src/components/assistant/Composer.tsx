import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Square } from 'lucide-react';
import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useAssistantStore } from '@/store/useAssistantStore';
import { currentScope, currentScopeParts, sameScope } from '@/lib/ai/scope';
import { gatherExplainContext } from '@/lib/ai/context/gather';
import { ipc } from '@/lib/ipc';
import type { AiIntent } from '@/types';
import { ComposerPreferences } from './ComposerPreferences';
export function Composer({
  disabled,
  running,
  visible = true,
}: {
  disabled: boolean;
  running: boolean;
  visible?: boolean;
}) {
  i18n.useLocale();
  const state = useAssistantStore();
  const [gathering, setGathering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const blocked =
    disabled ||
    running ||
    gathering ||
    preferencesSaving ||
    state.preparing ||
    !!state.pendingPreview;
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const resize = () => {
      element.style.height = '0px';
      element.style.height = `${Math.max(64, Math.min(140, element.scrollHeight))}px`;
      element.style.overflowY = element.scrollHeight > 140 ? 'auto' : 'hidden';
    };
    resize();
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        resize();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [state.draft, visible]);
  const submit = async () => {
    if (blocked || !state.draft.trim()) return;
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
  // Editor and diagnosis entry points carry context that the regular modes do
  // not gather. Keep their active mode visible without offering empty variants.
  if (state.composerIntent === 'yaml') intents.push({ value: 'yaml', label: i18n.t('Write YAML') });
  else if (state.composerIntent === 'fix')
    intents.push({ value: 'fix', label: i18n.t('Suggest a fix') });
  else if (state.composerIntent === 'explain-query')
    intents.push({ value: 'explain-query', label: i18n.t('Explain query') });
  return (
    <div className="shrink-0 px-3 pt-2 pb-3">
      <div className="mx-auto w-full max-w-[860px]">
        <ComposerPreferences
          visible={visible}
          disabled={running || gathering || state.preparing || !!state.pendingPreview}
          onSavingChange={setPreferencesSaving}
        />
        <div className="border-border/60 bg-fg/[0.025] focus-within:border-accent/35 overflow-hidden rounded-xl border transition-colors">
          <textarea
            ref={input}
            aria-label={i18n.t('Message to assistant')}
            placeholder={i18n.t('Ask the assistant…')}
            value={state.draft}
            onChange={(event) => state.setDraft(event.target.value)}
            disabled={disabled || gathering}
            rows={2}
            className="text-fg placeholder:text-fg-dim block max-h-[140px] min-h-16 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-[12px] leading-5 outline-none disabled:opacity-50"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <Select
              value={state.composerIntent}
              onChange={(intent) => {
                if (intent !== state.composerIntent) state.setComposerIntent(intent);
              }}
              options={intents}
              ariaLabel={i18n.t('Assistant mode')}
              disabled={blocked}
              className="max-w-[75%] rounded-lg border-transparent bg-transparent shadow-none"
            />
            {running ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={i18n.t('Stop')}
                title={i18n.t('Stop')}
                className="h-7 w-7 rounded-lg px-0"
                onClick={() => void state.stop()}
              >
                <Square aria-hidden="true" className="h-3 w-3 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="primary"
                aria-label={gathering ? i18n.t('Gathering context…') : i18n.t('Send')}
                title={gathering ? i18n.t('Gathering context…') : i18n.t('Send')}
                disabled={blocked || !state.draft.trim()}
                className="h-7 w-7 rounded-lg px-0"
                onClick={() => void submit()}
              >
                {gathering ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUp aria-hidden="true" className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </div>
        {error && (
          <p role="alert" className="text-status-error mt-2 text-[11px]">
            {assistantErrorMessage(error)}
          </p>
        )}
      </div>
    </div>
  );
}
