import { useState } from 'react';
import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/workbench/details/primitives';
import { suggestionForCode } from '@/lib/ai/answer';
import { validateGenerated, type GeneratedValidation } from '@/lib/ai/validateGenerated';
import { openSuggestion } from '@/lib/ai/actions';
import { restorePlaceholders, unrestorableMarkers } from '@/lib/ai/placeholders';
import type { AiMessage } from '@/lib/ai/reducer';
import type { AiOrigin } from '@/store/useAssistantStore';
import { getEditorDraft, setEditorDraft, reviewEditorReplacement } from '@/lib/ai/editorDrafts';
import type { ConfirmRequest } from '@/store/types';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore } from '@/store/useDockStore';
import type { ClusterId } from '@/types';
import { useAssistantNavigation } from './navigation';
export function SuggestionActions({
  lang,
  text,
  message,
  clusterId,
  namespace = null,
  origin = null,
}: {
  lang: string;
  text: string;
  message: AiMessage;
  clusterId: ClusterId | null;
  namespace?: string | null;
  origin?: AiOrigin | null;
}) {
  i18n.useLocale();
  const revealWorkbench = useAssistantNavigation();
  const clusters = useAppStore((s) => s.clusters);
  const [notice, setNotice] = useState<string | null>(null);
  const [validation, setValidation] = useState<GeneratedValidation | null>(null);
  const [working, setWorking] = useState(false);
  const suggestion = suggestionForCode(lang, text);
  const restored = restorePlaceholders(text, message.placeholders);
  const blocked =
    unrestorableMarkers(text).length > 0 ||
    (suggestion && 'blocked' in suggestion && suggestion.blocked);
  const reason = blocked
    ? i18n.t('This suggestion contains secret values or redaction markers and cannot be used.')
    : restored.missing.length
      ? i18n.t('Some redacted addresses could not be restored. This suggestion cannot be used.')
      : null;
  const apply = async () => {
    if (!suggestion || !clusterId) return;
    setWorking(true);
    setNotice(null);
    try {
      const result = await openSuggestion(clusterId, suggestion, message.placeholders, namespace);
      if (!result.ok)
        setNotice(result.reason === 'clipboard' ? i18n.t('Could not copy to clipboard.') : reason);
      else if (suggestion.kind === 'kubectl') setNotice(i18n.t('Copied'));
      else revealWorkbench();
    } finally {
      setWorking(false);
    }
  };
  const useInEditor = async () => {
    if (!origin || reason) return;
    setWorking(true);
    setNotice(null);
    try {
      const outcome = await reviewEditorReplacement({
        validate: async () =>
          setValidation(await validateGenerated(origin.clusterId, restored.text)),
        read: () => {
          const dock = useDockStore.getState();
          const tab = dock.docks[origin.clusterId]?.tabs.find((t) => t.id === origin.tabId);
          if (!tab || tab.kind !== 'editor' || tab.mode !== 'create') return null;
          const latestText = getEditorDraft(origin.tabId) ?? tab.yaml;
          return { text: latestText, dirty: !!dock.dirty[origin.tabId] || latestText !== tab.yaml };
        },
        confirm: () =>
          new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (answer: boolean) => {
              if (!settled) {
                settled = true;
                unsubscribe();
                resolve(answer);
              }
            };
            const request: ConfirmRequest = {
              title: i18n.t('Replace editor contents?'),
              message: i18n.t(
                'This editor has unsaved changes. Replace them with the assistant suggestion?',
              ),
              confirmLabel: i18n.t('Replace'),
              onConfirm: () => finish(true),
            };
            const unsubscribe = useAppStore.subscribe((state) => {
              if (state.confirm !== request) finish(false);
            });
            useAppStore.getState().requestConfirm(request);
          }),
        replace: () => {
          const dock = useDockStore.getState();
          setEditorDraft(origin.tabId, restored.text);
          const tab = dock.docks[origin.clusterId]?.tabs.find((t) => t.id === origin.tabId);
          const revision =
            tab?.kind === 'editor' && tab.mode === 'create' ? (tab.assistantRevision ?? 0) : 0;
          dock.updateTab(origin.clusterId, origin.tabId, {
            yaml: restored.text,
            assistantRevision: revision + 1,
          });
          dock.setActive(origin.clusterId, origin.tabId);
          dock.setOpen(origin.clusterId, true);
        },
      });
      if (outcome === 'closed')
        setNotice(i18n.t('The original editor is closed. Open a new review instead.'));
      else if (outcome === 'changed')
        setNotice(
          i18n.t('The editor changed while you were reviewing. Review the suggestion again.'),
        );
      else if (outcome === 'replaced') {
        setNotice(i18n.t('Suggestion added to the editor. Review validation before applying.'));
        revealWorkbench();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="min-w-0">
      <CodeBlock text={text} maxHeight="max-h-[360px]" />
      {suggestion && (
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              className="bg-fg/[0.03] hover:bg-fg/5"
              disabled={!!reason || !clusterId || !message.stop || working}
              onClick={() => void apply()}
            >
              {suggestion.kind === 'manifest'
                ? i18n.t('Review & apply')
                : suggestion.kind === 'kubectl'
                  ? i18n.t('Copy')
                  : suggestion.kind === 'promql'
                    ? i18n.t('Open in PromQL tab')
                    : i18n.t('Open in Loki tab')}
            </Button>
            {origin && suggestion.kind === 'manifest' && (
              <Button
                size="xs"
                variant="ghost"
                className="bg-fg/[0.03] hover:bg-fg/5"
                disabled={!!reason || !message.stop || working}
                onClick={() => void useInEditor()}
              >
                {i18n.t('Use in editor')}
              </Button>
            )}
          </div>
          {reason && <p className="text-status-warning text-[11px]">{reason}</p>}
          {suggestion.kind === 'manifest' &&
            clusters.find((c) => c.id === clusterId)?.read_only && (
              <p className="text-fg-dim text-[11px]">
                {i18n.t('Read-only cluster: review is available; applying is disabled.')}
              </p>
            )}
          {validation && (
            <div className="text-fg-dim space-y-1 text-[11px]">
              <p>
                {i18n.plural(
                  '{count} validation issue',
                  '{count} validation issues',
                  validation.issues.length,
                )}
              </p>
              {validation.issues.map((issue, index) => (
                <p key={index}>
                  {i18n.t('Document {document}, line {line}: {message}', {
                    document: issue.document,
                    line: issue.line,
                    message: issue.message,
                  })}
                </p>
              ))}
              {validation.unresolved.length > 0 && (
                <p>
                  {i18n.t('Schema unavailable for: {kinds}', {
                    kinds: validation.unresolved.join(', '),
                  })}
                </p>
              )}
            </div>
          )}
          {notice && (
            <p role="status" className="text-fg-dim text-[11px]">
              {notice}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
