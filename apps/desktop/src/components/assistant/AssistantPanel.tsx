import { assistantErrorMessage } from '@/lib/ai/errorMessage';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, History, Maximize2, Minimize2, Plus, Sparkles, X } from 'lucide-react';
import * as i18n from '@/i18n';
import { IconButton } from '@/components/ui/IconButton';
import { useAppStore } from '@/store/useAppStore';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { useAssistantStore } from '@/store/useAssistantStore';
import { assistantReadiness } from '@/lib/ai/readiness';
import { currentScope, sameScope } from '@/lib/ai/scope';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/cn';
import type { AiStatus } from '@/types';
import { Composer } from './Composer';
import { ContextPreview } from './ContextPreview';
import { MessageList } from './MessageList';
import { NotReady } from './NotReady';
import { ConversationHistory } from './ConversationHistory';
import { AssistantNavigationContext } from './navigation';
export function AssistantPanel({
  visible,
  expanded,
  onToggleExpanded,
  onExitExpanded,
}: {
  visible: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onExitExpanded: () => void;
}) {
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const dismissHistory = () => {
    setHistoryOpen(false);
    historyButton.current?.focus();
  };
  useEffect(() => {
    if (!visible || state.preparing) setHistoryOpen(false);
  }, [visible, state.preparing]);
  useEffect(() => {
    // Palette/editor entry points must reveal the draft or context they opened.
    setHistoryOpen(false);
  }, [state.composerIntent, state.composerSections, state.composerScope, state.composerOrigin]);
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
  const title =
    session?.messages.find((message) => message.role === 'user')?.text || i18n.t('New chat');
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
    <AssistantNavigationContext.Provider value={onExitExpanded}>
      <section
        className="@container flex h-full min-h-0 w-full flex-col"
        aria-label={i18n.t('Assistant')}
      >
        <header className="border-border/50 shrink-0 border-b px-3 py-2.5 @min-[720px]:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="bg-accent/8 text-accent flex h-8 w-8 shrink-0 items-center justify-center rounded-xl">
              <Sparkles size={15} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-fg text-[11px] font-semibold tracking-wider uppercase">
                {i18n.t('Assistant')}
              </h2>
              <p className="text-fg-muted mt-0.5 truncate text-[12px]" title={title}>
                {title}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton
                label={i18n.t('AI capabilities')}
                icon={<BookOpen />}
                onClick={() => {
                  useAppStore.getState().openMainTab({ kind: 'ai-guide' });
                  onExitExpanded();
                }}
              />
              <IconButton
                ref={historyButton}
                label={i18n.t('Chat history')}
                icon={<History />}
                aria-expanded={historyOpen}
                aria-controls="assistant-chat-history"
                className={historyOpen ? 'bg-accent/10 text-accent' : undefined}
                onClick={() => setHistoryOpen((value) => !value)}
              />
              <IconButton
                label={i18n.t('New chat')}
                icon={<Plus />}
                onClick={() => {
                  state.newChat();
                  setHistoryOpen(false);
                }}
              />
              <IconButton
                data-assistant-expand
                label={expanded ? i18n.t('Exit full screen') : i18n.t('Full screen')}
                icon={expanded ? <Minimize2 /> : <Maximize2 />}
                onClick={onToggleExpanded}
              />
              <IconButton
                label={i18n.t('Close assistant')}
                icon={<X />}
                onClick={() => useAppStore.setState({ rightPanel: null })}
              />
            </div>
          </div>
          <div className="text-fg-dim mt-2 flex min-w-0 items-center gap-1.5 text-[11px]">
            <span
              className="bg-fg/4 max-w-[50%] shrink-0 truncate rounded-md px-1.5 py-0.5"
              title={cluster?.name}
            >
              {cluster?.name ?? i18n.t('No cluster selected')}
            </span>
            {scope.namespace && (
              <span className="min-w-0 truncate" title={scope.namespace}>
                {scope.namespace}
              </span>
            )}
            {scope.object && (
              <span
                className="min-w-0 truncate"
                title={`${scope.object.kind}/${scope.object.name}`}
              >
                {scope.object.kind}/{scope.object.name}
              </span>
            )}
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1">
          {historyOpen && (
            <div
              className={cn(
                'bg-surface-raised border-border/60 min-h-0',
                expanded
                  ? 'absolute inset-0 z-20 @min-[720px]:relative @min-[720px]:z-auto @min-[720px]:w-72 @min-[720px]:shrink-0 @min-[720px]:border-r'
                  : 'absolute inset-0 z-20',
              )}
            >
              <ConversationHistory
                sessions={Object.values(state.sessions)}
                activeSessionId={state.activeSessionId}
                clusters={clusters}
                onSelect={state.selectSession}
                onCloseSession={(id) => void state.closeSession(id)}
                onDismiss={dismissHistory}
              />
            </div>
          )}
          <div
            className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col',
              historyOpen && (expanded ? 'invisible @min-[720px]:visible' : 'invisible'),
            )}
          >
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
            <Composer
              disabled={disabled && !session?.busy}
              running={!!session?.busy}
              visible={visible}
            />
          </div>
        </div>
      </section>
    </AssistantNavigationContext.Provider>
  );
}
