import { create } from 'zustand';
import * as i18n from '@/i18n/core';
import { ipc } from '@/lib/ipc';
import { applyAiEvent, newAiMessage, type AiMessage } from '@/lib/ai/reducer';
import { currentScope, sameScope } from '@/lib/ai/scope';
import { useAppStore } from './useAppStore';
import type {
  AiContextSection,
  AiIntent,
  AiPreview,
  AiRequest,
  AiScope,
  AiToolDecision,
  ClusterId,
} from '@/types';

export type AiOrigin = { kind: 'editor'; clusterId: ClusterId; tabId: string };
export interface AskInput {
  intent: AiIntent;
  message: string;
  sections: AiContextSection[];
  scope?: AiScope;
  origin?: AiOrigin;
}
export interface AssistantSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  clusterId: ClusterId | null;
  scope: AiScope;
  messages: AiMessage[];
  runId: string | null;
  busy: boolean;
  cancelRequested: boolean;
  origin: AiOrigin | null;
  local: boolean;
  providerId: string;
  settingsKey: string;
  model: string;
  requests: Record<string, AiRequest>;
  requestUiScopes: Record<string, AiScope>;
}
interface AssistantState {
  sessions: Record<string, AssistantSession>;
  activeSessionId: string | null;
  pendingPreview: AiPreview | null;
  pendingIntent: AiIntent | null;
  pendingRequest: AiRequest | null;
  preparing: boolean;
  pendingUiScope: AiScope | null;
  composerIntent: AiIntent;
  draft: string;
  composerSections: AiContextSection[];
  composerScope: AiScope | null;
  composerOrigin: AiOrigin | null;
  openComposer: (
    intent: AiIntent,
    sections?: AiContextSection[],
    scope?: AiScope,
    origin?: AiOrigin,
  ) => void;
  setDraft: (draft: string) => void;
  setComposerIntent: (intent: AiIntent) => void;
  error: string | null;
  ask: (input: AskInput) => Promise<void>;
  excludeSection: (id: string) => Promise<void>;
  send: () => Promise<void>;
  cancelPreview: () => void;
  stop: () => Promise<void>;
  cancelAll: () => Promise<void>;
  decide: (callId: string, decision: AiToolDecision) => Promise<void>;
  retry: (messageId: string) => Promise<void>;
  newChat: () => void;
  selectSession: (id: string) => void;
  closeSession: (id: string) => Promise<void>;
}
let generation = 0;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

export const useAssistantStore = create<AssistantState>((set, get) => {
  const updateSession = (id: string, update: (session: AssistantSession) => AssistantSession) =>
    set((state) =>
      state.sessions[id]
        ? { sessions: { ...state.sessions, [id]: update(state.sessions[id]!) } }
        : {},
    );

  const cancelSession = async (id: string | null) => {
    if (!id || !get().sessions[id]?.busy) return;
    updateSession(id, (session) => ({ ...session, cancelRequested: true }));
    const runId = get().sessions[id]?.runId;
    if (runId)
      try {
        await ipc.aiCancel(runId);
      } catch (error) {
        set({ error: errorText(error) });
      }
  };

  const preview = async (
    request: AiRequest,
    origin: AiOrigin | null,
    autoSend: boolean,
    uiScope: AiScope,
  ) => {
    const ticket = ++generation;
    const settingsKey = JSON.stringify([useAppStore.getState().settings?.ai, request.locale]);
    set({ preparing: true, error: null });
    try {
      const result = await ipc.aiPreview(request);
      if (ticket !== generation) {
        // A newly created session that never reached the UI must not leak.
        if (!get().sessions[result.session_id])
          void ipc.aiSessionEnd(result.session_id).catch(() => {});
        return;
      }
      const now = Date.now();
      set((state) => ({
        sessions: {
          ...state.sessions,
          [result.session_id]: state.sessions[result.session_id] ?? {
            id: result.session_id,
            createdAt: now,
            updatedAt: now,
            clusterId: request.scope.cluster_id,
            scope: request.scope,
            messages: [],
            runId: null,
            busy: false,
            cancelRequested: false,
            origin,
            local: result.local,
            providerId: result.provider_id,
            settingsKey,
            model: result.model,
            requests: {},
            requestUiScopes: {},
          },
        },
        activeSessionId: result.session_id,
        pendingPreview: result,
        pendingRequest: { ...request, session_id: result.session_id },
        pendingIntent: request.intent,
        pendingUiScope: uiScope,
        preparing: false,
      }));
      if (autoSend && !result.sections.some((section) => !section.excluded)) await get().send();
    } catch (error) {
      if (ticket === generation) set({ preparing: false, error: errorText(error) });
    }
  };

  return {
    sessions: {},
    activeSessionId: null,
    pendingPreview: null,
    pendingIntent: null,
    pendingRequest: null,
    preparing: false,
    error: null,
    pendingUiScope: null,
    composerIntent: 'chat',
    draft: '',
    composerSections: [],
    composerScope: null,
    composerOrigin: null,
    setDraft: (draft) => set({ draft }),
    setComposerIntent: (composerIntent) =>
      set({ composerIntent, composerSections: [], composerScope: null, composerOrigin: null }),
    openComposer: (composerIntent, composerSections = [], composerScope, composerOrigin) => {
      useAppStore.setState({ rightPanel: 'assistant' });
      set({
        composerIntent,
        composerSections,
        composerScope: composerScope ?? null,
        composerOrigin: composerOrigin ?? null,
      });
    },
    ask: async (input) => {
      useAppStore.setState({ rightPanel: 'assistant' });
      if (get().preparing || get().pendingPreview) return;
      const scope = input.scope ?? currentScope();
      const active = get().activeSessionId;
      const session = active ? get().sessions[active] : null;
      if (session?.busy) return;
      const ai = useAppStore.getState().settings?.ai;
      const provider = ai?.active_provider;
      const locale = ai?.response_language ?? i18n.getLocale();
      // Cluster and provider are fixed by the backend for a session.
      const compatible =
        session &&
        sameScope(session.scope, scope) &&
        session.providerId === provider &&
        (!input.origin || JSON.stringify(input.origin) === JSON.stringify(session.origin)) &&
        session.settingsKey === JSON.stringify([ai, locale]);
      await preview(
        {
          session_id: compatible ? session.id : null,
          intent: input.intent,
          message: input.message,
          sections: input.sections,
          scope,
          excluded: [],
          locale,
        },
        input.origin ?? (compatible ? session.origin : null),
        true,
        currentScope(),
      );
    },
    excludeSection: async (id) => {
      const { pendingRequest, pendingPreview, preparing } = get();
      if (
        !pendingRequest ||
        !pendingPreview ||
        preparing ||
        !pendingPreview.sections.some((s) => s.id === id)
      )
        return;
      const excluded = pendingRequest.excluded.includes(id)
        ? pendingRequest.excluded.filter((key) => key !== id)
        : [...pendingRequest.excluded, id];
      await preview(
        { ...pendingRequest, excluded },
        get().sessions[pendingPreview.session_id]?.origin ?? null,
        false,
        get().pendingUiScope ?? currentScope(),
      );
    },
    send: async () => {
      const {
        pendingPreview: reviewed,
        pendingRequest: request,
        pendingUiScope: uiScope,
        preparing,
      } = get();
      if (!reviewed || !request || preparing) return;
      if (uiScope && !sameScope(currentScope(), uiScope)) {
        set({ error: i18n.t('The selected context changed. Cancel this preview and ask again.') });
        return;
      }
      if (reviewed.expires_at <= Date.now()) {
        set({ error: i18n.t('This preview expired. Cancel it and ask again.') });
        return;
      }
      const sessionId = reviewed.session_id;
      const session = get().sessions[sessionId];
      if (!session || session.busy) return;
      const messageId = crypto.randomUUID();
      const user = newAiMessage({
        id: crypto.randomUUID(),
        role: 'user',
        intent: request.intent,
        text: reviewed.message,
        status: 'done',
        attachments: reviewed.sections
          .filter((s) => !s.excluded)
          .map((s) => ({ kind: s.kind, label: s.label, tokens: s.tokens })),
      });
      const assistant = newAiMessage({ id: messageId, role: 'assistant', intent: request.intent });
      assistant.placeholders = reviewed.placeholders;
      updateSession(sessionId, (s) => ({
        ...s,
        updatedAt: Date.now(),
        scope: request.scope,
        busy: true,
        cancelRequested: false,
        messages: [...s.messages, user, assistant],
        requests: { ...s.requests, [messageId]: request },
        requestUiScopes: { ...s.requestUiScopes, [messageId]: uiScope ?? currentScope() },
      }));
      set({
        pendingPreview: null,
        pendingRequest: null,
        pendingIntent: null,
        pendingUiScope: null,
        error: null,
      });
      try {
        const runId = await ipc.aiSend(reviewed.preview_id, (event) => {
          updateSession(sessionId, (s) => ({
            ...s,
            updatedAt:
              event.type === 'done' && s.messages.some((m) => m.id === messageId && m.stop === null)
                ? Date.now()
                : s.updatedAt,
            runId: event.type === 'started' ? event.run_id : event.type === 'done' ? null : s.runId,
            busy: event.type === 'done' ? false : s.busy,
            messages: s.messages.map((m) => (m.id === messageId ? applyAiEvent(m, event) : m)),
          }));
          if (event.type === 'started' && get().sessions[sessionId]?.cancelRequested)
            void ipc.aiCancel(event.run_id).catch((error) => set({ error: errorText(error) }));
        });
        // Some adapters resolve before started; some after done. Never resurrect a finished run.
        const live = get().sessions[sessionId];
        if (!live) {
          await ipc.aiCancel(runId);
          return;
        }
        if (live.busy) {
          updateSession(sessionId, (s) => ({ ...s, runId }));
          if (live.cancelRequested) await ipc.aiCancel(runId);
        }
      } catch (error) {
        updateSession(sessionId, (s) => ({
          ...s,
          updatedAt: s.messages.some((m) => m.id === messageId && m.stop === null)
            ? Date.now()
            : s.updatedAt,
          busy: false,
          runId: null,
          messages: s.messages.map((m) =>
            m.id === messageId && m.stop === null
              ? applyAiEvent(
                  applyAiEvent(m, { type: 'error', message: errorText(error), retryable: true }),
                  {
                    type: 'done',
                    stop: 'error',
                    usage: m.usage ?? zeroUsage,
                    cost: null,
                    placeholders: m.placeholders,
                  },
                )
              : m,
          ),
        }));
      }
    },
    cancelPreview: () => {
      ++generation;
      set({
        pendingPreview: null,
        pendingRequest: null,
        pendingIntent: null,
        pendingUiScope: null,
        preparing: false,
        error: null,
      });
    },
    stop: () => cancelSession(get().activeSessionId),
    cancelAll: async () => {
      get().cancelPreview();
      await Promise.all(Object.keys(get().sessions).map(cancelSession));
    },
    decide: async (callId, decision) => {
      const id = get().activeSessionId;
      const session = id ? get().sessions[id] : null;
      if (!session?.runId || !session.busy || session.cancelRequested) return;
      try {
        await ipc.aiToolDecision(session.runId, callId, decision);
      } catch (error) {
        set({ error: errorText(error) });
      }
    },
    retry: async (messageId) => {
      const id = get().activeSessionId;
      const session = id ? get().sessions[id] : null;
      const request = session?.requests[messageId];
      if (!session || !request || session.busy || get().pendingPreview || get().preparing) return;
      if (!sameScope(currentScope(), session.requestUiScopes[messageId] ?? request.scope)) {
        set({ error: i18n.t('The selected context changed. Start a new chat to continue.') });
        return;
      }
      const ai = useAppStore.getState().settings?.ai;
      const locale = ai?.response_language ?? i18n.getLocale();
      const settingsKey = JSON.stringify([ai, locale]);
      await preview(
        { ...request, locale, session_id: session.settingsKey === settingsKey ? session.id : null },
        session.origin,
        true,
        currentScope(),
      );
    },
    newChat: () => {
      get().cancelPreview();
      void cancelSession(get().activeSessionId);
      set({
        activeSessionId: null,
        composerIntent: 'chat',
        draft: '',
        composerSections: [],
        composerScope: null,
        composerOrigin: null,
      });
    },
    selectSession: (id) => {
      if (get().sessions[id]) {
        get().cancelPreview();
        set({ activeSessionId: id });
      }
    },
    closeSession: async (id) => {
      const session = get().sessions[id];
      if (!session) return;
      if (get().activeSessionId === id) {
        get().cancelPreview();
        set({ activeSessionId: null });
      }
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[id];
        return { sessions };
      });
      try {
        if (session.runId) await ipc.aiCancel(session.runId);
        await ipc.aiSessionEnd(id);
      } catch (error) {
        set({ error: errorText(error) });
      }
    },
  };
});

// The panel stays mounted while hidden. Cancel synchronously at the store boundary,
// before a late preview can auto-send, without clearing the draft or conversation.
useAppStore.subscribe((state, previous) => {
  if (previous.rightPanel === 'assistant' && state.rightPanel !== 'assistant')
    void useAssistantStore.getState().cancelAll();
});
