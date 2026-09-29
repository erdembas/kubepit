import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import { useEffect, useState } from 'react';
import * as i18n from '@/i18n';
import { Button } from '@/components/ui/Button';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { useAssistantStore } from '@/store/useAssistantStore';
import { assistantReadiness } from '@/lib/ai/readiness';
import { currentScope, sameScope } from '@/lib/ai/scope';
import { ipc } from '@/lib/ipc';
import type { AiStatus } from '@/types';
import { Composer } from './Composer';
import { ContextPreview } from './ContextPreview';
import { MessageList } from './MessageList';
import { NotReady } from './NotReady';
export function AssistantPanel({ visible }: { visible: boolean }) {
  i18n.useLocale();
  const settings = useAppStore((s) => s.settings);
  const clusters = useAppStore((s) => s.clusters);
  useAppStore((s) => s.selectedClusterId);
  useWorkbenchStore((s) => s.namespaces);
  useWorkbenchStore((s) => s.selection);
  useWorkbenchStore((s) => s.activeKind);
  const state = useAssistantStore();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setStatus(null);
    setStatusError(null);
    void ipc.aiStatus().then(
      (result) => {
        if (alive) setStatus(result);
      },
      (error: unknown) => {
        if (alive) setStatusError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [visible, settings?.ai]);
  const scope = currentScope();
  const cluster = clusters.find((c) => c.id === scope.cluster_id) ?? null;
  const session = state.activeSessionId ? (state.sessions[state.activeSessionId] ?? null) : null;
  const provider = settings?.ai?.providers.find((p) => p.id === settings.ai.active_provider);
  const readiness = assistantReadiness(settings?.ai, status, cluster);
  const contextMismatch = !!session && session.clusterId !== scope.cluster_id;
  const previewMismatch = !!state.pendingUiScope && !sameScope(scope, state.pendingUiScope);
  const disabled =
    readiness.state !== 'ready' ||
    contextMismatch ||
    !!state.pendingPreview ||
    state.preparing ||
    !!session?.busy ||
    !!statusError ||
    status === null;
  return (
    <section
      className="@container flex h-full min-h-0 w-full flex-col"
      aria-label={i18n.t('Assistant')}
    >
      <header className="border-border/70 space-y-2 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-fg text-[11px] font-semibold tracking-wider uppercase">
            {i18n.t('Assistant')}
          </h2>
          <Button size="xs" onClick={state.newChat}>
            {i18n.t('New chat')}
          </Button>
        </div>
        <div className="text-fg-dim flex flex-wrap gap-1 text-[10px]">
          <span className="bg-fg/5 rounded px-1.5 py-0.5">
            {cluster?.name ?? i18n.t('No cluster selected')}
          </span>
          {scope.namespace && (
            <span className="bg-fg/5 rounded px-1.5 py-0.5">{scope.namespace}</span>
          )}
          {scope.object && (
            <span className="bg-fg/5 max-w-full truncate rounded px-1.5 py-0.5">
              {scope.object.kind}/{scope.object.name}
            </span>
          )}
        </div>
        <p className="text-fg-dim text-[11px] break-all">
          {session?.providerId ?? provider?.name} · {session?.model ?? provider?.model}
          {(session?.local || provider?.kind === 'ollama') && (
            <span className="text-accent ml-2">{i18n.t('Local')}</span>
          )}
        </p>
        {Object.keys(state.sessions).length > 0 && (
          <div className="flex min-w-0 items-center gap-1">
            <select
              aria-label={i18n.t('Conversation')}
              value={state.activeSessionId ?? ''}
              className="bg-surface border-border min-w-0 flex-1 rounded border p-1 text-[11px]"
              onChange={(event) =>
                event.target.value ? state.selectSession(event.target.value) : state.newChat()
              }
            >
              <option value="">{i18n.t('New chat')}</option>
              {Object.values(state.sessions).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.messages.find((m) => m.role === 'user')?.text.slice(0, 70) ||
                    clusters.find((c) => c.id === s.clusterId)?.name ||
                    i18n.t('New chat')}
                </option>
              ))}
            </select>
            {session && (
              <Button size="xs" variant="ghost" onClick={() => void state.closeSession(session.id)}>
                {i18n.t('Close chat')}
              </Button>
            )}
          </div>
        )}
      </header>
      {readiness.state !== 'ready' && <NotReady readiness={readiness} />}
      {contextMismatch && (
        <p className="text-status-warning m-3 text-[12px]">
          {i18n.t(
            'This conversation belongs to another cluster. Start a new chat to continue here.',
          )}
        </p>
      )}
      {(state.error || statusError) && (
        <p
          role="alert"
          className="text-status-error m-3 text-[12px] break-words whitespace-pre-wrap"
        >
          {assistantErrorMessage(state.error || statusError || '')}
        </p>
      )}
      <MessageList session={session} disabled={disabled} />
      {state.preparing && !state.pendingPreview && (
        <p role="status" className="text-fg-dim p-3 text-[11px]">
          {i18n.t('Preparing preview…')}
        </p>
      )}
      {state.pendingPreview && (
        <ContextPreview
          preview={state.pendingPreview}
          mismatch={previewMismatch || readiness.state !== 'ready'}
        />
      )}
      <Composer disabled={disabled && !session?.busy} running={!!session?.busy} />
    </section>
  );
}
