import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiEvent, AiLocale, AiPreview, AiRequest, AiScope } from '@/types';
import * as i18n from '@/i18n/core';
const mocks = vi.hoisted(() => ({
  uiScope: { cluster_id: 'c1', namespace: 'shop', object: null } as AiScope,
  app: {
    settings: {
      ai: {
        active_provider: 'p1',
        providers: [{ id: 'p1', model: 'm1' }],
        response_language: null as AiLocale | null | undefined,
      },
    },
    rightPanel: null as string | null,
  },
  appListeners: new Set<
    (state: { rightPanel: string | null }, previous: { rightPanel: string | null }) => void
  >(),
  ipc: {
    aiPreview: vi.fn(),
    aiSend: vi.fn(),
    aiCancel: vi.fn(),
    aiSessionEnd: vi.fn(),
    aiToolDecision: vi.fn(),
  },
}));
vi.mock('@/lib/ipc', () => ({ ipc: mocks.ipc }));
vi.mock('@/store/useAppStore', () => ({
  useAppStore: {
    getState: () => mocks.app,
    setState: (patch: object) => {
      const previous = { ...mocks.app };
      Object.assign(mocks.app, patch);
      for (const listener of mocks.appListeners) listener(mocks.app, previous);
    },
    subscribe: (
      listener: (
        state: { rightPanel: string | null },
        previous: { rightPanel: string | null },
      ) => void,
    ) => {
      mocks.appListeners.add(listener);
      return () => mocks.appListeners.delete(listener);
    },
  },
}));
vi.mock('@/lib/ai/scope', () => ({
  currentScope: () => structuredClone(mocks.uiScope),
  sameScope: (a: AiScope, b: AiScope) => JSON.stringify(a) === JSON.stringify(b),
}));
import { useAssistantStore } from './useAssistantStore';
import { useAppStore } from './useAppStore';
const store = () => useAssistantStore.getState();
const section = {
  id: 'object',
  kind: 'object' as const,
  label: 'pod/web',
  format: 'json' as const,
  priority: 0,
  content: '{}',
};
const usage = { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 };
function preview(request: AiRequest, id = 's1'): AiPreview {
  return {
    preview_id: 'preview-' + id,
    session_id: request.session_id ?? id,
    provider_id: 'p1',
    provider_kind: 'anthropic',
    model: 'm1',
    local: false,
    production: false,
    cluster_name: 'Development',
    message: request.message.replace('secret', '__TOKEN__'),
    sections: request.sections.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      text: 'REDACTED EXACT TEXT',
      tokens: 4,
      original_tokens: 4,
      trimmed: false,
      excluded: request.excluded.includes(s.id),
      redactions: { secrets: 1, tokens: 0, ips: 0, hostnames: 0 },
    })),
    earlier_messages: 0,
    system_tokens: 10,
    tools: [],
    estimated_input_tokens: 20,
    context_window: 1000,
    budget: 100,
    estimated_cost: null,
    placeholders: {},
    expires_at: Date.now() + 60000,
  };
}
const ask = (message = 'why secret', sections = [section]) =>
  store().ask({ intent: 'explain', message, sections });
const done: AiEvent = { type: 'done', stop: 'end', usage, cost: 0.01, placeholders: {} };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  store().cancelPreview();
  useAssistantStore.setState(useAssistantStore.getInitialState(), true);
  vi.clearAllMocks();
  mocks.app.rightPanel = null;
  mocks.app.settings.ai.providers[0]!.model = 'm1';
  mocks.app.settings.ai.response_language = null;
  i18n.setLocale('en', false);
  mocks.uiScope = { cluster_id: 'c1', namespace: 'shop', object: null };
  mocks.ipc.aiPreview.mockImplementation(async (request: AiRequest) => preview(request));
  mocks.ipc.aiSend.mockImplementation(async (_id: string, emit: (event: AiEvent) => void) => {
    emit({ type: 'started', run_id: 'r1', model: 'm1' });
    emit({ type: 'text', delta: 'Answer' });
    emit(done);
    return 'r1';
  });
  mocks.ipc.aiCancel.mockResolvedValue(true);
  mocks.ipc.aiSessionEnd.mockResolvedValue(undefined);
  mocks.ipc.aiToolDecision.mockResolvedValue(undefined);
});
describe('assistant session state machine', () => {
  it('timestamps creation and completed activity without reordering history on every streamed event', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    let emit!: (event: AiEvent) => void;
    mocks.ipc.aiSend.mockImplementation(async (_id, callback) => {
      emit = callback;
      callback({ type: 'started', run_id: 'r1', model: 'm1' });
      return 'r1';
    });
    try {
      await ask();
      expect(store().sessions.s1).toMatchObject({ createdAt: 1000, updatedAt: 1000 });
      now.mockReturnValue(2000);
      await store().send();
      expect(store().sessions.s1).toMatchObject({ createdAt: 1000, updatedAt: 2000 });
      now.mockReturnValue(3000);
      emit({ type: 'text', delta: 'first chunk' });
      emit({ type: 'usage', usage });
      expect(store().sessions.s1?.updatedAt).toBe(2000);
      now.mockReturnValue(4000);
      emit(done);
      expect(store().sessions.s1).toMatchObject({ createdAt: 1000, updatedAt: 4000 });
      now.mockReturnValue(5000);
      emit(done);
      expect(store().sessions.s1?.updatedAt).toBe(4000);
    } finally {
      now.mockRestore();
    }
  });

  it('retains completed chats and their activity when starting and selecting another chat', async () => {
    await ask('first conversation', []);
    const first = store().sessions.s1;
    store().newChat();
    expect(store().activeSessionId).toBeNull();
    expect(store().sessions.s1).toEqual(first);
    mocks.ipc.aiPreview.mockImplementation(async (request: AiRequest) => preview(request, 's2'));
    await ask('second conversation', []);
    expect(Object.keys(store().sessions)).toEqual(['s1', 's2']);
    store().selectSession('s1');
    expect(store().activeSessionId).toBe('s1');
    expect(store().sessions.s1).toEqual(first);
    expect(mocks.ipc.aiSessionEnd).not.toHaveBeenCalled();
  });

  it('shows exact redacted preview, sends its id once and never raw request text', async () => {
    await ask();
    expect(mocks.ipc.aiSend).not.toHaveBeenCalled();
    expect(store().pendingPreview?.message).toBe('why __TOKEN__');
    await Promise.all([store().send(), store().send()]);
    expect(mocks.ipc.aiSend).toHaveBeenCalledTimes(1);
    expect(mocks.ipc.aiSend.mock.calls[0]![0]).toBe('preview-s1');
    expect(store().sessions.s1?.messages.map((m) => m.text)).toEqual(['why __TOKEN__', 'Answer']);
    expect(store().sessions.s1).toMatchObject({ busy: false, runId: null });
  });
  it('sends a typed-only follow-up automatically', async () => {
    await ask('follow up', []);
    expect(mocks.ipc.aiSend).toHaveBeenCalledTimes(1);
    await ask('another', []);
    expect(mocks.ipc.aiPreview.mock.calls[1]![0].session_id).toBe('s1');
  });
  it('re-previews excluded sections and still requires send after all are excluded', async () => {
    await ask();
    await store().excludeSection('object');
    expect(store().pendingPreview?.sections[0]?.excluded).toBe(true);
    expect(mocks.ipc.aiSend).not.toHaveBeenCalled();
    expect(mocks.ipc.aiPreview.mock.calls[1]![0].excluded).toEqual(['object']);
    await store().excludeSection('object');
    expect(store().pendingPreview?.sections[0]?.excluded).toBe(false);
  });
  it('permits explicitly scoped context menu requests but refuses changed UI context', async () => {
    const explicit = {
      ...mocks.uiScope,
      object: { api_version: 'v1', kind: 'Pod', namespace: 'shop', name: 'other' },
    };
    await store().ask({
      intent: 'explain',
      message: 'explain',
      sections: [section],
      scope: explicit,
    });
    await store().send();
    expect(mocks.ipc.aiSend).toHaveBeenCalledTimes(1);
    await ask();
    mocks.uiScope.namespace = 'production';
    await store().send();
    expect(mocks.ipc.aiSend).toHaveBeenCalledTimes(1);
    expect(store().error).toContain('context changed');
  });
  it('rejects expired previews without provider calls', async () => {
    await ask();
    store().pendingPreview!.expires_at = Date.now() - 1;
    await store().send();
    expect(mocks.ipc.aiSend).not.toHaveBeenCalled();
    expect(store().error).toContain('expired');
  });
  it('discards and ends a new session when cancelled while previewing', async () => {
    const pending = deferred<AiPreview>();
    let request!: AiRequest;
    mocks.ipc.aiPreview.mockImplementation((r: AiRequest) => {
      request = r;
      return pending.promise;
    });
    const asking = ask();
    store().cancelPreview();
    pending.resolve(preview(request));
    await asking;
    expect(store().pendingPreview).toBeNull();
    expect(store().activeSessionId).toBeNull();
    expect(mocks.ipc.aiSessionEnd).toHaveBeenCalledWith('s1');
  });
  it('does not let an old preview overwrite a later request', async () => {
    const first = deferred<AiPreview>();
    let request!: AiRequest;
    mocks.ipc.aiPreview.mockImplementationOnce((r: AiRequest) => {
      request = r;
      return first.promise;
    });
    const old = ask('old');
    store().newChat();
    await ask('new');
    first.resolve(preview(request, 'old-session'));
    await old;
    expect(store().pendingPreview?.message).toBe('new');
    expect(mocks.ipc.aiSessionEnd).toHaveBeenCalledWith('old-session');
  });
  it.each(['stop', 'close', 'new-chat'])(
    'cancels a pending send as soon as started arrives after %s',
    async (action) => {
      const pending = deferred<string>();
      let emit!: (event: AiEvent) => void;
      mocks.ipc.aiSend.mockImplementation((_id, callback) => {
        emit = callback;
        return pending.promise;
      });
      await ask();
      const sending = store().send();
      if (action === 'stop') await store().stop();
      else if (action === 'close') useAppStore.setState({ rightPanel: null });
      else store().newChat();
      expect(store().sessions.s1?.cancelRequested).toBe(true);
      emit({ type: 'started', run_id: 'slow', model: 'm1' });
      expect(mocks.ipc.aiCancel).toHaveBeenCalledWith('slow');
      emit({ ...done, stop: 'cancelled' });
      pending.resolve('slow');
      await sending;
      expect(store().sessions.s1).toMatchObject({ busy: false, runId: null });
      expect(store().sessions.s1?.messages[1]?.status).toBe('cancelled');
    },
  );
  it('cancels New chat while retaining late deltas only in the original conversation', async () => {
    let emit!: (event: AiEvent) => void;
    mocks.ipc.aiSend.mockImplementation(async (_id, callback) => {
      emit = callback;
      callback({ type: 'started', run_id: 'r1', model: 'm1' });
      return 'r1';
    });
    await ask();
    await store().send();
    store().newChat();
    expect(mocks.ipc.aiCancel).toHaveBeenCalledWith('r1');
    emit({ type: 'text', delta: 'background' });
    emit({ ...done, stop: 'cancelled' });
    expect(store().activeSessionId).toBeNull();
    expect(store().sessions.s1?.messages[1]?.text).toBe('background');
    store().selectSession('s1');
    expect(store().activeSessionId).toBe('s1');
  });
  it.each([null, 'events', 'forwards', 'alerts'] as const)(
    'cancels streaming when switching to %s and preserves the draft and conversation',
    async (rightPanel) => {
      let emit!: (event: AiEvent) => void;
      mocks.ipc.aiSend.mockImplementation(async (_id, callback) => {
        emit = callback;
        emit({ type: 'started', run_id: 'r1', model: 'm1' });
        emit({ type: 'text', delta: 'partial answer' });
        return 'r1';
      });
      await ask('question', []);
      store().setDraft('unsent question');
      useAppStore.setState({ rightPanel });
      expect(mocks.ipc.aiCancel).toHaveBeenCalledWith('r1');
      expect(store().sessions.s1).toMatchObject({ busy: true, cancelRequested: true });
      expect(store().draft).toBe('unsent question');
      emit({ ...done, stop: 'cancelled' });
      useAppStore.setState({ rightPanel: 'assistant' });
      expect(store().activeSessionId).toBe('s1');
      expect(store().sessions.s1?.messages[1]).toMatchObject({
        text: 'partial answer',
        status: 'cancelled',
      });
      expect(store().sessions.s1).toMatchObject({ busy: false, runId: null });
      expect(store().draft).toBe('unsent question');
      expect(mocks.ipc.aiSend).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['close', 'new-chat'])(
    'cancels a request awaiting tool consent on %s and rejects later consent',
    async (action) => {
      let emit!: (event: AiEvent) => void;
      mocks.ipc.aiSend.mockImplementation(async (_id, callback) => {
        emit = callback;
        emit({ type: 'started', run_id: 'r1', model: 'm1' });
        emit({
          type: 'tool-call',
          call: {
            id: 'call1',
            name: 'get_events',
            input: {},
            status: 'pending-approval',
            result_preview: 'redacted events',
          },
        });
        return 'r1';
      });
      await ask('question', []);
      if (action === 'close') useAppStore.setState({ rightPanel: null });
      else store().newChat();
      expect(mocks.ipc.aiCancel).toHaveBeenCalledWith('r1');
      store().selectSession('s1');
      await store().decide('call1', 'send-session');
      expect(mocks.ipc.aiToolDecision).not.toHaveBeenCalled();
      emit({ ...done, stop: 'cancelled' });
      expect(store().sessions.s1).toMatchObject({ busy: false, runId: null });
      expect(store().sessions.s1?.messages[1]?.status).toBe('cancelled');
    },
  );
  it('cancels every running conversation when hiding the panel after a history selection', async () => {
    await ask('first', []);
    store().newChat();
    mocks.ipc.aiPreview.mockImplementation(async (request: AiRequest) =>
      preview(request, request.session_id ?? 's2'),
    );
    await ask('second', []);
    mocks.ipc.aiSend.mockImplementation(async (id, emit) => {
      const runId = `run-${id}`;
      emit({ type: 'started', run_id: runId, model: 'm1' });
      return runId;
    });
    store().selectSession('s1');
    await ask('first follow-up', []);
    store().selectSession('s2');
    await ask('second follow-up', []);
    useAppStore.setState({ rightPanel: null });
    expect(mocks.ipc.aiCancel).toHaveBeenCalledTimes(2);
    expect(store().sessions.s1?.runId).not.toBe(store().sessions.s2?.runId);
    for (const id of ['s1', 's2']) {
      expect(store().sessions[id]?.cancelRequested).toBe(true);
      expect(mocks.ipc.aiCancel).toHaveBeenCalledWith(store().sessions[id]?.runId);
    }
  });
  it('invalidates a pending typed-only preview on close before it can auto-send', async () => {
    const pending = deferred<AiPreview>();
    let request!: AiRequest;
    mocks.ipc.aiPreview.mockImplementation((value: AiRequest) => {
      request = value;
      return pending.promise;
    });
    store().setDraft('keep my draft');
    const asking = ask('question', []);
    useAppStore.setState({ rightPanel: null });
    expect(store().preparing).toBe(false);
    pending.resolve(preview(request));
    await asking;
    expect(mocks.ipc.aiSend).not.toHaveBeenCalled();
    expect(mocks.ipc.aiSessionEnd).toHaveBeenCalledWith('s1');
    expect(store().pendingPreview).toBeNull();
    expect(store().activeSessionId).toBeNull();
    expect(store().draft).toBe('keep my draft');
  });
  it('preserves an active run across language changes and unrelated panel updates', async () => {
    mocks.ipc.aiSend.mockImplementation(async (_id, emit) => {
      emit({ type: 'started', run_id: 'r1', model: 'm1' });
      return 'r1';
    });
    await ask('question', []);
    store().setDraft('unsent question');
    i18n.setLocale('tr', false);
    useAppStore.setState({ rightPanel: 'assistant', rightPanelWidth: 400 });
    expect(mocks.ipc.aiCancel).not.toHaveBeenCalled();
    expect(store().sessions.s1).toMatchObject({ busy: true, cancelRequested: false });
    expect(store().draft).toBe('unsent question');
  });
  it('never recreates closed sessions from late stream callbacks', async () => {
    const pending = deferred<string>();
    let emit!: (event: AiEvent) => void;
    mocks.ipc.aiSend.mockImplementation((_id, callback) => {
      emit = callback;
      return pending.promise;
    });
    await ask();
    const sending = store().send();
    await store().closeSession('s1');
    emit({ type: 'started', run_id: 'late', model: 'm1' });
    emit(done);
    pending.resolve('late');
    await sending;
    expect(store().sessions).toEqual({});
    expect(mocks.ipc.aiCancel).toHaveBeenCalledWith('late');
  });
  it('keeps errors retryable and re-previews the original excluded request', async () => {
    mocks.ipc.aiSend.mockRejectedValueOnce(new Error('offline'));
    await ask();
    await store().send();
    const failed = store().sessions.s1!.messages[1]!;
    expect(failed).toMatchObject({ status: 'error', retryable: true, error: 'offline' });
    await store().retry(failed.id);
    expect(store().pendingPreview).not.toBeNull();
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0]).toMatchObject({
      intent: 'explain',
      message: 'why secret',
      sections: [section],
    });
  });
  it('routes tool decisions only to the running selected session', async () => {
    mocks.ipc.aiSend.mockImplementation(async (_id, emit) => {
      emit({ type: 'started', run_id: 'r1', model: 'm1' });
      return 'r1';
    });
    await ask();
    await store().send();
    await store().decide('call1', 'deny');
    expect(mocks.ipc.aiToolDecision).toHaveBeenCalledWith('r1', 'call1', 'deny');
    store().newChat();
    await store().decide('call1', 'send');
    expect(mocks.ipc.aiToolDecision).toHaveBeenCalledTimes(1);
  });
  it('starts a fresh session when exact scope, locale or settings change', async () => {
    await ask('first', []);
    mocks.uiScope.namespace = 'another';
    await ask('second', []);
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0].session_id).toBeNull();
    i18n.setLocale('tr', false);
    await ask('third', []);
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0].session_id).toBeNull();
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0].locale).toBe('tr');
    mocks.app.settings.ai.providers[0]!.model = 'm2';
    await ask('fourth', []);
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0].session_id).toBeNull();
  });
  it.each([
    ['en', 'tr'],
    ['tr', 'en'],
    ['en', 'ja'],
  ] as const)('uses the chosen answer language with a %s interface', async (ui, answer) => {
    i18n.setLocale(ui, false);
    mocks.app.settings.ai.response_language = answer;
    await ask('Explain the selected workload', []);
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0].locale).toBe(answer);
    expect(i18n.getLocale()).toBe(ui);
  });
  it('follows the interface language when older settings have no preference', async () => {
    mocks.app.settings.ai.response_language = undefined;
    i18n.setLocale('tr', false);
    await ask('Explain', []);
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0].locale).toBe('tr');
  });
  it('keeps the same chat across interface language changes with an explicit answer language', async () => {
    mocks.app.settings.ai.response_language = 'tr';
    await ask('first', []);
    i18n.setLocale('tr', false);
    await ask('second', []);
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0]).toMatchObject({
      session_id: 's1',
      locale: 'tr',
    });
  });
  it('starts a new chat when the answer language changes and when returning to the app language', async () => {
    await ask('first', []);
    mocks.ipc.aiPreview.mockImplementation(async (request: AiRequest) => preview(request, 's2'));
    mocks.app.settings.ai.response_language = 'tr';
    await ask('second', []);
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0]).toMatchObject({
      session_id: null,
      locale: 'tr',
    });
    mocks.app.settings.ai.response_language = null;
    await ask('third', []);
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0]).toMatchObject({
      session_id: null,
      locale: 'en',
    });
  });
  it('retries in a fresh chat with the newly selected answer language', async () => {
    mocks.ipc.aiSend.mockRejectedValueOnce(new Error('offline'));
    await ask('explain', []);
    const failed = store().sessions.s1!.messages[1]!;
    mocks.app.settings.ai.response_language = 'de';
    await store().retry(failed.id);
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0]).toMatchObject({
      session_id: null,
      locale: 'de',
      message: 'explain',
    });
  });
  it('never attaches a second editor request to the first editor origin', async () => {
    const originA = { kind: 'editor' as const, clusterId: 'c1', tabId: 'editor-a' };
    const originB = { ...originA, tabId: 'editor-b' };
    await store().ask({ intent: 'yaml', message: 'generate A', sections: [], origin: originA });
    mocks.ipc.aiPreview.mockImplementation(async (request: AiRequest) => preview(request, 's2'));
    await store().ask({ intent: 'yaml', message: 'generate B', sections: [], origin: originB });
    expect(mocks.ipc.aiPreview.mock.calls.at(-1)![0].session_id).toBeNull();
    expect(store().sessions.s2?.origin).toEqual(originB);
    expect(store().sessions.s1?.origin).toEqual(originA);
  });
  it('preserves composer drafts across locale switches and opening entry points', () => {
    store().setDraft('my question');
    i18n.setLocale('tr', false);
    store().openComposer('promql', [section]);
    expect(store().draft).toBe('my question');
    expect(store().composerIntent).toBe('promql');
  });
});
