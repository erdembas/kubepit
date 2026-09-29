import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_SETTINGS } from '@/lib/ai/defaults';
import { selectLocalAgent } from '@/lib/ai/localAgents';
import { DEMO_LOCAL_AGENTS } from './fixtures/ai';
import type {
  AiAgentCatalog,
  AiContextSection,
  AiEvent,
  AiLocalAgent,
  AiLogDetail,
  AiLogPage,
  AiModelInfo,
  AiPreview,
  AiRequest,
  AiSettings,
  AiStatus,
  AiToolCall,
  HistoryStatus,
  Settings,
} from '@/types';

// The demo assistant mirrors the backend rules: previews are single use,
// the master switch, the per-cluster enablement (production needs the typed
// acknowledgement) and local-only mode are enforced, secrets are redacted
// before the preview, canned answers stream in small chunks, a crash-looping
// pod's explanation asks to send a `get_events` result first, runs can be
// cancelled and every run lands in the demo request log.

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let invoke: Invoke;
let handlers: typeof import('./registry').handlers;
/** The demo settings before any save. */
let initial: Settings;
/** `DEFAULT_AI_SETTINGS.clusters` right after the store's list was changed in place. */
let defaultsAfterMutation: string[] = [];

beforeAll(async () => {
  vi.useFakeTimers({ now: new Date('2026-09-29T10:00:00Z') });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { search: '', href: 'http://localhost:1430/' });
  const mock = await import('./index');
  invoke = (command, args = {}) => mock.mockInvoke(command, args);
  handlers = (await import('./registry')).handlers;
  initial = structuredClone(await invoke<Settings>('settings_get'));
  // Same object as the store holds: an in-place change must not reach the defaults.
  const live = await invoke<Settings>('settings_get');
  live.ai.clusters.push('mutated-in-place');
  defaultsAfterMutation = [...DEFAULT_AI_SETTINGS.clusters];
  live.ai.clusters.pop();
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run `promise` while the fake clock advances. */
async function settle<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  const done = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const result = await done;
  if ('error' in result) throw result.error;
  return result.value;
}

/** Advance the fake clock until `check` holds (a demo run streams on timers). */
async function waitFor(check: () => boolean, limitMs = 60_000) {
  for (let t = 0; t < limitMs && !check(); t += 50) await vi.advanceTimersByTimeAsync(50);
  expect(check()).toBe(true);
}

async function saveAi(change: Partial<AiSettings>): Promise<Settings> {
  const current = await invoke<Settings>('settings_get');
  return invoke<Settings>('settings_set', {
    settings: { ...current, ai: { ...current.ai, ...change } },
  });
}

const POD = 'payment-api-7c9d8b6f5-x2kqp';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLTEyMw';

/** An explain request for the crash-looping payment-api pod, with secrets, a token and an IP. */
function explainRequest(clusterId: string, extra: Partial<AiRequest> = {}): AiRequest {
  const section = (s: Partial<AiContextSection> & Pick<AiContextSection, 'id' | 'kind'>) =>
    ({ label: s.id, priority: 1, format: 'text', content: '', ...s }) as AiContextSection;
  return {
    session_id: null,
    intent: 'explain',
    message: 'Why is payment-api crashing?',
    scope: {
      cluster_id: clusterId,
      namespace: 'checkout',
      object: { api_version: 'v1', kind: 'Pod', namespace: 'checkout', name: POD },
    },
    sections: [
      section({ id: 'scope', kind: 'scope', priority: 0, content: 'cluster: dev-shared' }),
      section({
        id: 'containers',
        kind: 'containers',
        label: `pod/${POD}`,
        content: `pod/${POD} phase=Running ip=10.244.1.17\n  payment-api: waiting CrashLoopBackOff restarts=42; last: Error (1)`,
      }),
      section({
        id: 'object',
        kind: 'object',
        label: `pod/${POD}`,
        format: 'yaml',
        content: `spec:\n  containers:\n  - env:\n    - name: DB_PASSWORD\n      value: hunter2\n    - name: UPSTREAM_HEADER\n      value: Bearer ${JWT}\n`,
      }),
      section({
        id: `logs:${POD}/payment-api@previous`,
        kind: 'logs',
        priority: 2,
        format: 'log',
        content: 'level=info msg="auth ok" secret=aHVudGVyMg== peer=10.244.1.17',
      }),
      section({ id: 'metrics', kind: 'metrics', priority: 4, content: 'payment-api: cpu 12m' }),
    ],
    excluded: ['metrics'],
    locale: 'en',
    ...extra,
  };
}

function chatRequest(sessionId: string | null, intent: AiRequest['intent'], message: string) {
  return {
    session_id: sessionId,
    intent,
    message,
    scope: { cluster_id: 'c-dev', namespace: 'checkout', object: null },
    sections: [],
    excluded: [],
    locale: 'en',
  } satisfies AiRequest;
}

/** Starts a run and collects its events. */
async function send(previewId: string) {
  const events: AiEvent[] = [];
  const runId = await settle(
    invoke<string>('ai_send', { previewId, onEvent: (e: AiEvent) => events.push(e) }),
    0,
  );
  const done = () => events.some((e) => e.type === 'done');
  const text = () => events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
  const calls = () =>
    events.flatMap((e) => (e.type === 'tool-call' ? [e.call] : ([] as AiToolCall[])));
  return { runId, events, done, text, calls };
}

beforeEach(async () => {
  await saveAi({
    enabled: true,
    local_only: false,
    active_provider: 'anthropic',
    tool_policy: 'ask',
    log_requests: true,
    prices: [],
    agent_options: {},
    response_language: null,
    redaction: { tokens: true, ips: true, hostnames: false },
  });
  await invoke('ai_cluster_set', {
    clusterId: 'c-dev',
    enabled: true,
    acknowledgeProduction: false,
  });
  await invoke('ai_key_set', { providerId: 'anthropic', key: 'demo-key' });
});

describe('demo assistant: status, keys and models', () => {
  it('loads native catalogs for unsaved agents while the assistant is off, without changing consent', async () => {
    await saveAi({ enabled: false });
    const before = structuredClone(await invoke<Settings>('settings_get'));
    expect(before.ai.providers.some((provider) => provider.kind === 'claude-cli')).toBe(false);
    const catalog = await settle(
      invoke<AiAgentCatalog>('ai_agent_catalog', { kind: 'claude-cli' }),
    );
    expect(catalog).toMatchObject({
      kind: 'claude-cli',
      authenticated: true,
      default_model: 'sonnet',
    });
    expect(catalog.models.find((model) => model.id === 'opus')).toMatchObject({
      is_alias: true,
      supports_fast_mode: true,
      efforts: ['low', 'medium', 'high', 'max'],
    });
    catalog.models.length = 0;
    expect(
      (
        await settle(
          invoke<AiAgentCatalog>('ai_agent_catalog', { kind: 'claude-cli', refresh: true }),
        )
      ).models.length,
    ).toBeGreaterThan(0);
    expect(await invoke<Settings>('settings_get')).toEqual(before);
  });

  it('enforces local-only, installation and supported protocol rules for native catalogs', async () => {
    await saveAi({ local_only: true });
    await expect(settle(invoke('ai_agent_catalog', { kind: 'codex-cli' }))).rejects.toThrow(
      /cloud services/,
    );
    await saveAi({ local_only: false });
    const opencode = DEMO_LOCAL_AGENTS.find((agent) => agent.kind === 'opencode-cli')!;
    opencode.available = false;
    try {
      await expect(settle(invoke('ai_agent_catalog', { kind: 'opencode-cli' }))).rejects.toThrow(
        /not installed/,
      );
    } finally {
      opencode.available = true;
    }
    await expect(settle(invoke('ai_agent_catalog', { kind: 'cursor-cli' }))).rejects.toThrow(
      /cannot disable/,
    );
  });

  it('persists native options, rejects unsupported choices, and permits a plain custom model id', async () => {
    const original = structuredClone((await invoke<Settings>('settings_get')).ai);
    const agent = (await invoke<AiLocalAgent[]>('ai_local_agents'))[0]!;
    const selected = { ...original, ...selectLocalAgent(original, agent) };
    await saveAi({
      ...selected,
      agent_options: {
        'codex-cli': { effort: 'ultra', service_tier: 'priority', fast_mode: false },
      },
    });
    expect((await invoke<Settings>('settings_get')).ai.agent_options['codex-cli']).toEqual({
      effort: 'ultra',
      service_tier: 'priority',
      fast_mode: false,
    });
    await expect(
      settle(invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'hello') })),
    ).resolves.toMatchObject({ provider_kind: 'codex-cli' });
    await saveAi({
      providers: selected.providers.map((provider) =>
        provider.id === 'codex-cli' ? { ...provider, model: 'gpt-6-luna' } : provider,
      ),
    });
    await expect(
      settle(invoke('ai_preview', { request: chatRequest(null, 'chat', 'hello') })),
    ).rejects.toThrow(/does not support/);
    await saveAi({
      providers: selected.providers.map((provider) =>
        provider.id === 'codex-cli' ? { ...provider, model: 'future-version' } : provider,
      ),
      agent_options: {},
    });
    await expect(
      settle(invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'hello') })),
    ).resolves.toMatchObject({ model: 'future-version' });
    await saveAi(original);
  });

  it('detects agents without changing saved settings, including unsupported agents', async () => {
    const before = structuredClone(await invoke<Settings>('settings_get'));
    const agents = await invoke<AiLocalAgent[]>('ai_local_agents');
    expect(agents.map((agent) => agent.kind)).toEqual([
      'codex-cli',
      'claude-cli',
      'opencode-cli',
      'cursor-cli',
    ]);
    expect(agents.find((agent) => agent.kind === 'opencode-cli')).toMatchObject({
      available: true,
      executable: '/home/demo/.opencode/bin/opencode',
    });
    expect(agents.find((agent) => agent.kind === 'cursor-cli')).toMatchObject({
      available: true,
      supported: false,
    });
    agents[0]!.available = false;
    expect((await invoke<AiLocalAgent[]>('ai_local_agents'))[0]!.available).toBe(true);
    expect(await invoke<Settings>('settings_get')).toEqual(before);
  });

  it('runs a detected agent without a key or tools and still respects local-only mode', async () => {
    const original = (await invoke<Settings>('settings_get')).ai;
    const agent = (await invoke<AiLocalAgent[]>('ai_local_agents'))[0]!;
    await saveAi(selectLocalAgent(original, agent));
    const status = await invoke<AiStatus>('ai_status');
    expect(status.providers.find((provider) => provider.kind === 'codex-cli')).toMatchObject({
      local: false,
      has_key: false,
      key_error: null,
      allowed: true,
    });
    await expect(
      invoke('ai_key_set', { providerId: 'codex-cli', key: 'not-stored' }),
    ).rejects.toThrow(/own sign-in/);
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    expect(preview).toMatchObject({
      provider_kind: 'codex-cli',
      model: 'gpt-6-sol',
      local: false,
      tools: [],
    });
    const run = await send(preview.preview_id);
    await waitFor(run.done);
    expect(run.text().length).toBeGreaterThan(0);
    expect(run.calls()).toEqual([]);
    await saveAi({ local_only: true });
    await expect(
      settle(invoke('ai_preview', { request: explainRequest('c-dev') })),
    ).rejects.toThrow(/cloud services/);
    await saveAi({
      providers: original.providers,
      active_provider: original.active_provider,
      local_only: false,
    });
  });
  it('reports the providers, the demo credential store and loopback providers as local', async () => {
    const status = await invoke<AiStatus>('ai_status');
    expect(status.remote_allowed).toBe(true);
    expect(status.keychain).not.toBe('');
    const byId = Object.fromEntries(status.providers.map((p) => [p.id, p]));
    expect(byId.anthropic).toMatchObject({ has_key: true, local: false, allowed: true });
    expect(byId.ollama).toMatchObject({ local: true, allowed: true });
    await saveAi({ local_only: true });
    const local = await invoke<AiStatus>('ai_status');
    expect(local.providers.find((p) => p.id === 'anthropic')!.allowed).toBe(false);
  });

  it('stores and removes keys without ever returning them', async () => {
    const removed = await invoke<AiStatus>('ai_key_delete', { providerId: 'anthropic' });
    expect(removed.providers.find((p) => p.id === 'anthropic')!.has_key).toBe(false);
    await expect(invoke('ai_key_set', { providerId: 'anthropic', key: '   ' })).rejects.toThrow();
    const stored = await invoke<AiStatus>('ai_key_set', { providerId: 'anthropic', key: 'sk-x' });
    expect(JSON.stringify(stored)).not.toContain('sk-x');
  });

  it('lists the models of a provider with Claude Opus 5 first', async () => {
    const models = await settle(invoke<AiModelInfo[]>('ai_models', { providerId: 'anthropic' }));
    expect(models[0]).toMatchObject({ id: 'claude-opus-5', adaptive_thinking: true, effort: true });
    await saveAi({ enabled: false });
    await expect(settle(invoke('ai_models', { providerId: 'anthropic' }))).rejects.toThrow(/off/);
  });
});

describe('demo assistant: enablement', () => {
  it('refuses production clusters without an acknowledgement', async () => {
    expect(() =>
      handlers.ai_cluster_set!({
        clusterId: 'c-prod-us',
        enabled: true,
        acknowledgeProduction: false,
      }),
    ).toThrow(/production/);
    const saved = await invoke<Settings>('ai_cluster_set', {
      clusterId: 'c-prod-us',
      enabled: true,
      acknowledgeProduction: true,
    });
    expect(saved.ai.clusters).toContain('c-prod-us');
    const off = await invoke<Settings>('ai_cluster_set', {
      clusterId: 'c-prod-us',
      enabled: false,
      acknowledgeProduction: false,
    });
    expect(off.ai.clusters).not.toContain('c-prod-us');
  });

  it('keeps the enabled clusters read-only in settings_set', async () => {
    const saved = await saveAi({ clusters: ['c-prod-eu', 'c-staging'] });
    expect(saved.ai.clusters).toEqual(['c-dev']);
  });

  it('refuses previews while off, for clusters not enabled and remote providers in local-only mode', async () => {
    await saveAi({ enabled: false });
    await expect(
      settle(invoke('ai_preview', { request: explainRequest('c-dev') })),
    ).rejects.toThrow(/off/);
    await saveAi({ enabled: true });
    await expect(
      settle(invoke('ai_preview', { request: explainRequest('c-staging') })),
    ).rejects.toThrow(/not enabled/);
    await saveAi({ local_only: true });
    await expect(
      settle(invoke('ai_preview', { request: explainRequest('c-dev') })),
    ).rejects.toThrow(/local-only/);
  });
});

describe('demo assistant: preview and send', () => {
  it('refuses a stale preview when the response language preference changes', async () => {
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'hello') }),
    );
    await saveAi({ response_language: 'tr' });
    const onEvent = vi.fn();
    await expect(invoke('ai_send', { previewId: preview.preview_id, onEvent })).rejects.toThrow(
      'assistant settings changed; preview the request again',
    );
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('refuses to continue a session in a different request locale', async () => {
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'hello') }),
    );
    await expect(
      settle(
        invoke('ai_preview', {
          request: { ...chatRequest(preview.session_id, 'chat', 'merhaba'), locale: 'tr' },
        }),
      ),
    ).rejects.toThrow('assistant session settings or scope changed; start a new conversation');
  });

  it('refuses to continue a session after its preference changes even if the resolved locale is unchanged', async () => {
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'hello') }),
    );
    await saveAi({ response_language: 'en' });
    await expect(
      settle(
        invoke('ai_preview', {
          request: chatRequest(preview.session_id, 'chat', 'continue'),
        }),
      ),
    ).rejects.toThrow('assistant session settings or scope changed; start a new conversation');
    await expect(
      settle(invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'hello') })),
    ).resolves.toMatchObject({ earlier_messages: 0 });
  });

  it('redacts secrets, tokens and IPs before the preview and lists excluded sections', async () => {
    const asked = Date.now();
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    const all = preview.sections.map((s) => s.text).join('\n');
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('aHVudGVyMg==');
    expect(all).not.toContain(JWT);
    expect(all).not.toContain('10.244.1.17');
    expect(preview.sections.some((s) => s.redactions.secrets > 0)).toBe(true);
    expect(preview.sections.find((s) => s.id === 'object')!.redactions).toMatchObject({
      secrets: 1,
      tokens: 1,
    });
    // The same IP gets the same placeholder in every section, restorable locally.
    expect(preview.placeholders).toEqual({ __IP_1__: '10.244.1.17' });
    expect(all.match(/__IP_1__/g)!.length).toBe(2);
    const metrics = preview.sections.find((s) => s.id === 'metrics')!;
    expect(metrics.excluded).toBe(true);
    expect(preview).toMatchObject({
      provider_id: 'anthropic',
      model: 'claude-opus-5',
      local: false,
      production: false,
      cluster_name: 'dev-shared',
      earlier_messages: 0,
      estimated_cost: null,
    });
    expect(preview.tools).toContain('get_events');
    expect(preview.estimated_input_tokens).toBeGreaterThan(preview.system_tokens);
    // Stored for ten minutes (the demo renders in ~120 ms).
    expect(preview.expires_at - asked).toBeGreaterThanOrEqual(600_000);
    expect(preview.expires_at - asked).toBeLessThan(601_000);
  });

  it('streams an answer after a preview and refuses a second send', async () => {
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    const run = await send(preview.preview_id);
    await waitFor(() => run.calls().some((c) => c.status === 'pending-approval'));
    expect(run.events[0]).toMatchObject({
      type: 'started',
      run_id: run.runId,
      model: 'claude-opus-5',
    });
    await expect(
      settle(invoke('ai_send', { previewId: preview.preview_id, onEvent: () => {} }), 0),
    ).rejects.toThrow(/expired|already sent/);

    // The get_events result waits for consent; nothing else streams meanwhile.
    const pending = run.calls().find((c) => c.status === 'pending-approval')!;
    expect(pending).toMatchObject({
      name: 'get_events',
      input: { namespace: 'checkout', name: POD },
    });
    expect(pending.result_preview).toBeTruthy();
    const before = run.events.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run.events.length).toBe(before);

    await invoke('ai_tool_decision', { runId: run.runId, callId: pending.id, decision: 'send' });
    await waitFor(run.done);
    expect(run.events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', call_id: pending.id, status: 'done' }),
    );
    const text = run.text();
    expect(text).toContain('```yaml');
    expect(text).toContain('kind: Deployment');
    expect(text).toContain('```sh');
    const done = run.events.at(-1)!;
    expect(done).toMatchObject({ type: 'done', stop: 'end', cost: null });
    if (done.type === 'done') {
      expect(done.usage.input_tokens + done.usage.cache_write_tokens).toBeGreaterThan(0);
      expect(done.usage.output_tokens).toBeGreaterThan(0);
      expect(done.placeholders).toEqual({ __IP_1__: '10.244.1.17' });
    }
    // Text streams in chunks of a few words.
    const deltas = run.events.flatMap((e) => (e.type === 'text' ? [e.delta] : []));
    expect(deltas.length).toBeGreaterThan(10);
    expect(Math.max(...deltas.map((d) => d.trim().split(/\s+/).length))).toBeLessThanOrEqual(6);
  });

  it('sends later tool results of the session without asking after "send for this session"', async () => {
    const first = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    const run = await send(first.preview_id);
    await waitFor(() => run.calls().some((c) => c.status === 'pending-approval'));
    const call = run.calls().find((c) => c.status === 'pending-approval')!;
    await invoke('ai_tool_decision', {
      runId: run.runId,
      callId: call.id,
      decision: 'send-session',
    });
    await waitFor(run.done);

    const again = await settle(
      invoke<AiPreview>('ai_preview', {
        request: explainRequest('c-dev', { session_id: first.session_id }),
      }),
    );
    expect(again.earlier_messages).toBe(2);
    const second = await send(again.preview_id);
    await waitFor(second.done);
    expect(second.calls().some((c) => c.status === 'pending-approval')).toBe(false);
    expect(second.calls().some((c) => c.status === 'done')).toBe(true);
  });

  it('reports a declined tool result and offers no tools under policy off', async () => {
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    const run = await send(preview.preview_id);
    await waitFor(() => run.calls().some((c) => c.status === 'pending-approval'));
    const call = run.calls().find((c) => c.status === 'pending-approval')!;
    await invoke('ai_tool_decision', { runId: run.runId, callId: call.id, decision: 'deny' });
    await waitFor(run.done);
    expect(run.events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', call_id: call.id, status: 'denied' }),
    );
    await expect(
      invoke('ai_tool_decision', { runId: run.runId, callId: call.id, decision: 'send' }),
    ).rejects.toThrow();

    await saveAi({ tool_policy: 'off' });
    const off = await settle(invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }));
    expect(off.tools).toEqual([]);
    const plain = await send(off.preview_id);
    await waitFor(plain.done);
    expect(plain.calls()).toEqual([]);
  });

  it('cancels a streaming run and a run waiting for consent', async () => {
    const preview = await settle(
      invoke<AiPreview>('ai_preview', {
        request: chatRequest(null, 'chat', 'What should I look at?'),
      }),
    );
    const run = await send(preview.preview_id);
    await waitFor(() => run.text().length > 0);
    expect(await invoke<boolean>('ai_cancel', { runId: run.runId })).toBe(true);
    await waitFor(run.done);
    expect(run.events.at(-1)).toMatchObject({ type: 'done', stop: 'cancelled' });
    expect(await invoke<boolean>('ai_cancel', { runId: run.runId })).toBe(false);

    const explain = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    const waiting = await send(explain.preview_id);
    await waitFor(() => waiting.calls().some((c) => c.status === 'pending-approval'));
    const call = waiting.calls().find((c) => c.status === 'pending-approval')!;
    // Disconnecting the cluster stops its runs, like the backend's stop_cluster_work.
    await settle(invoke('cluster_disconnect', { id: 'c-dev' }), 0);
    await waitFor(waiting.done);
    expect(waiting.events.at(-1)).toMatchObject({ type: 'done', stop: 'cancelled' });
    await expect(
      invoke('ai_tool_decision', { runId: waiting.runId, callId: call.id, decision: 'send' }),
    ).rejects.toThrow();
  });

  it('fails fast without a key and keeps one run per session', async () => {
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'kubectl', 'failing pods') }),
    );
    await invoke('ai_key_delete', { providerId: 'anthropic' });
    await expect(
      settle(invoke('ai_send', { previewId: preview.preview_id, onEvent: () => {} }), 0),
    ).rejects.toThrow(/API key/);
    await invoke('ai_key_set', { providerId: 'anthropic', key: 'demo-key' });

    const first = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'hello') }),
    );
    const run = await send(first.preview_id);
    const next = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(first.session_id, 'chat', 'more') }),
    );
    await expect(
      settle(invoke('ai_send', { previewId: next.preview_id, onEvent: () => {} }), 0),
    ).rejects.toThrow(/in progress/);
    await waitFor(run.done);
    await expect(
      settle(invoke('ai_preview', { request: chatRequest('s-unknown', 'chat', 'x') })),
    ).rejects.toThrow(/session/);
  });

  it('computes the cost from the price table and shows local models without one', async () => {
    await saveAi({
      prices: [
        {
          model: 'claude-opus-5',
          input_per_mtok: 5,
          output_per_mtok: 25,
          cache_write_per_mtok: null,
          cache_read_per_mtok: null,
        },
      ],
    });
    const priced = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'promql', 'restarts') }),
    );
    expect(priced.estimated_cost).toBeCloseTo((priced.estimated_input_tokens * 5) / 1e6, 10);
    const run = await send(priced.preview_id);
    await waitFor(run.done);
    const done = run.events.at(-1)!;
    if (done.type !== 'done') throw new Error('no done event');
    const u = done.usage;
    expect(done.cost).toBeCloseTo(
      ((u.input_tokens + u.cache_write_tokens + u.cache_read_tokens) * 5 + u.output_tokens * 25) /
        1e6,
      10,
    );
    expect(run.text()).toContain('```promql');

    const current = await invoke<Settings>('settings_get');
    await saveAi({
      active_provider: 'ollama',
      providers: current.ai.providers.map((p) =>
        p.id === 'ollama' ? { ...p, model: 'llama3.1:8b' } : p,
      ),
      prices: [{ ...current.ai.prices[0]!, model: 'llama3.1:8b' }],
    });
    const local = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'logql', 'errors') }),
    );
    expect(local).toMatchObject({ local: true, provider_kind: 'ollama', estimated_cost: null });
    const localRun = await send(local.preview_id);
    await waitFor(localRun.done);
    expect(localRun.events.at(-1)).toMatchObject({ type: 'done', cost: null });
    expect(localRun.text()).toContain('```logql');
  });

  it('answers in the request locale and writes a nightly CronJob for yaml', async () => {
    const tr = await settle(
      invoke<AiPreview>('ai_preview', {
        request: { ...chatRequest(null, 'yaml', 'her gece rapor'), locale: 'tr' },
      }),
    );
    const run = await send(tr.preview_id);
    await waitFor(run.done);
    expect(run.text()).toContain('kind: CronJob');
    expect(run.text()).toContain('schedule: "0 2 * * *"');
    expect(run.text()).toMatch(/gece/);
  });

  it('completes a German answer, tool consent and logged system prompt in the request language', async () => {
    await settle(invoke('history_clear', { kind: 'ai', clusterId: null }), 0);
    await saveAi({ response_language: 'de' });
    const preview = await settle(
      invoke<AiPreview>('ai_preview', {
        request: explainRequest('c-dev', { locale: 'de' }),
      }),
    );
    const run = await send(preview.preview_id);
    await waitFor(() => run.calls().some((call) => call.status === 'pending-approval'));
    expect(run.text()).toContain('Ich prüfe zuerst');
    const call = run.calls().find((call) => call.status === 'pending-approval')!;
    await invoke('ai_tool_decision', {
      runId: run.runId,
      callId: call.id,
      decision: 'deny',
    });
    await waitFor(run.done);
    expect(run.events.at(-1)).toMatchObject({ type: 'done', stop: 'end' });
    expect(run.text()).toContain('Die Ereignisse wurden nicht geteilt');
    expect(run.text()).toContain('vorgefertigte Demo-Antwort auf Deutsch');
    const page = await invoke<AiLogPage>('ai_log_list', {
      filter: { cluster_ids: [], text: null, since: null, cursor: null, limit: 1 },
    });
    const detail = await invoke<AiLogDetail>('ai_log_get', { id: page.entries[0]!.id });
    expect(JSON.parse(detail.request).system).toContain('Answer in German (Deutsch).');
    expect(JSON.parse(detail.request).system).toContain('quoted errors verbatim.');
  });

  it('simulates provider errors on request', async () => {
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'trigger #error') }),
    );
    const run = await send(preview.preview_id);
    await waitFor(run.done);
    expect(run.events).toContainEqual(expect.objectContaining({ type: 'error', retryable: true }));
    expect(run.events.at(-1)).toMatchObject({
      type: 'done',
      stop: 'error',
      refusal_category: null,
    });
  });
});

describe('demo assistant: refusal', () => {
  it('names the refusal category of a refused run', async () => {
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'trigger #refusal') }),
    );
    const run = await send(preview.preview_id);
    await waitFor(run.done);
    expect(run.events.at(-1)).toMatchObject({
      type: 'done',
      stop: 'refusal',
      refusal_category: 'cyber',
    });
  });
});

describe('demo assistant: request log', () => {
  it('pages, exports and clears the runs, bodies redacted', async () => {
    await settle(invoke('history_clear', { kind: 'ai', clusterId: null }), 0);
    for (const intent of ['kubectl', 'promql'] as const) {
      const p = await settle(
        invoke<AiPreview>('ai_preview', { request: chatRequest(null, intent, 'x') }),
      );
      const run = await send(p.preview_id);
      await waitFor(run.done);
    }
    const explain = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    const run = await send(explain.preview_id);
    await waitFor(() => run.calls().some((c) => c.status === 'pending-approval'));
    const call = run.calls().find((c) => c.status === 'pending-approval')!;
    await invoke('ai_tool_decision', { runId: run.runId, callId: call.id, decision: 'send' });
    await waitFor(run.done);

    const filter = { cluster_ids: [], text: null, since: null, cursor: null, limit: 2 };
    const page = await invoke<AiLogPage>('ai_log_list', { filter });
    expect(page.total).toBe(3);
    expect(page.entries.map((e) => e.intent)).toEqual(['explain', 'promql']);
    expect(page.entries[0]).toMatchObject({
      cluster_name: 'dev-shared',
      outcome: 'ok',
      tool_calls: 1,
    });
    expect(page.usage.output_tokens).toBeGreaterThan(0);
    const rest = await invoke<AiLogPage>('ai_log_list', {
      filter: { ...filter, cursor: page.next_cursor },
    });
    expect(rest.entries.map((e) => e.intent)).toEqual(['kubectl']);
    expect(rest.next_cursor).toBeNull();

    const detail = await invoke<AiLogDetail>('ai_log_get', { id: page.entries[0]!.id });
    expect(detail.request).toContain('__SECRET__');
    expect(detail.request).not.toContain('hunter2');
    expect(detail.response).toContain('```yaml');

    const lines = (await invoke<string>('ai_log_export', { filter })).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => typeof JSON.parse(l).request === 'string')).toBe(true);

    const status = await invoke<HistoryStatus>('history_status');
    expect(status.ai.rows).toBe(3);
    const cleared = await settle(
      invoke<HistoryStatus>('history_clear', { kind: 'ai', clusterId: null }),
      0,
    );
    expect(cleared.ai.rows).toBe(0);
    expect((await invoke<AiLogPage>('ai_log_list', { filter })).total).toBe(0);
  });

  it('logs nothing when request logging is off', async () => {
    await settle(invoke('history_clear', { kind: 'ai', clusterId: null }), 0);
    await saveAi({ log_requests: false });
    const p = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'kubectl', 'x') }),
    );
    const run = await send(p.preview_id);
    await waitFor(run.done);
    const page = await invoke<AiLogPage>('ai_log_list', {
      filter: { cluster_ids: [], text: null, since: null, cursor: null, limit: 100 },
    });
    expect(page.total).toBe(0);
  });
});

describe('demo assistant: backend-owned settings', () => {
  it('starts from a copy of the defaults, never the shared objects', () => {
    expect(initial.ai).toEqual(DEFAULT_AI_SETTINGS);
    expect(defaultsAfterMutation).toEqual([]);
    expect(DEFAULT_AI_SETTINGS.clusters).toEqual([]);
    expect(DEFAULT_AI_SETTINGS.production_acknowledged).toEqual([]);
  });

  it('persists a selected response language and defaults an older settings object to the UI language', async () => {
    const saved = await saveAi({ response_language: 'fr' });
    expect(saved.ai.response_language).toBe('fr');
    await saveAi({ max_context_tokens: saved.ai.max_context_tokens + 1 });
    const current = await invoke<Settings>('settings_get');
    expect(current.ai.response_language).toBe('fr');

    const legacyAi: Partial<AiSettings> = { ...current.ai };
    delete legacyAi.response_language;
    const migrated = await invoke<Settings>('settings_set', {
      settings: { ...current, ai: legacyAi },
    });
    expect(migrated.ai.response_language).toBeNull();
  });

  it('records the production acknowledgement and keeps it read-only in settings_set', async () => {
    const on = await invoke<Settings>('ai_cluster_set', {
      clusterId: 'c-prod-us',
      enabled: true,
      acknowledgeProduction: true,
    });
    expect(on.ai.production_acknowledged).toEqual(['c-prod-us']);
    const kept = await saveAi({ production_acknowledged: [], clusters: [] });
    expect(kept.ai.production_acknowledged).toEqual(['c-prod-us']);
    expect(kept.ai.clusters).toContain('c-prod-us');
    const off = await invoke<Settings>('ai_cluster_set', {
      clusterId: 'c-prod-us',
      enabled: false,
      acknowledgeProduction: false,
    });
    expect(off.ai.production_acknowledged).toEqual([]);
  });

  it('refuses a production cluster enabled without the acknowledgement', async () => {
    await invoke('ai_cluster_set', {
      clusterId: 'c-kind',
      enabled: true,
      acknowledgeProduction: false,
    });
    const kind = (await invoke<import('@/types').ClusterDef[]>('cluster_list')).find(
      (c) => c.id === 'c-kind',
    )!;
    await invoke('cluster_update', { cluster: { ...kind, environment: 'production' } });
    const request = {
      ...chatRequest(null, 'chat', 'hi'),
      scope: { cluster_id: 'c-kind', namespace: null, object: null },
    };
    await expect(settle(invoke('ai_preview', { request }))).rejects.toThrow(/typed confirmation/);
    await invoke('ai_cluster_set', {
      clusterId: 'c-kind',
      enabled: true,
      acknowledgeProduction: true,
    });
    await expect(settle(invoke<AiPreview>('ai_preview', { request }))).resolves.toMatchObject({
      production: true,
    });
  });

  it('drops a removed cluster from both lists', async () => {
    await invoke('ai_cluster_set', {
      clusterId: 'c-prod-eu',
      enabled: true,
      acknowledgeProduction: true,
    });
    await settle(invoke('cluster_remove', { id: 'c-prod-eu' }), 0);
    const settings = await invoke<Settings>('settings_get');
    expect(settings.ai.clusters).not.toContain('c-prod-eu');
    expect(settings.ai.production_acknowledged).not.toContain('c-prod-eu');
  });

  it('keeps keychain_kubeconfigs for kubeconfig_storage_set alone', async () => {
    const current = await invoke<Settings>('settings_get');
    const saved = await invoke<Settings>('settings_set', {
      settings: { ...current, keychain_kubeconfigs: !current.keychain_kubeconfigs },
    });
    expect(saved.keychain_kubeconfigs).toBe(current.keychain_kubeconfigs);
    const moved = await settle(
      invoke<Settings>('kubeconfig_storage_set', { keychain: !current.keychain_kubeconfigs }),
    );
    expect(moved.keychain_kubeconfigs).toBe(!current.keychain_kubeconfigs);
    await settle(invoke('kubeconfig_storage_set', { keychain: current.keychain_kubeconfigs }));
  });
});

describe('demo assistant: unanswered tool consent', () => {
  it('declines a waiting tool result when the next message of the chat is sent', async () => {
    const first = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    const waiting = await send(first.preview_id);
    await waitFor(() => waiting.calls().some((c) => c.status === 'pending-approval'));
    const next = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(first.session_id, 'chat', 'go on') }),
    );
    const run = await send(next.preview_id);
    await waitFor(waiting.done);
    expect(waiting.events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', status: 'denied' }),
    );
    expect(waiting.events.at(-1)).toMatchObject({ type: 'done', stop: 'cancelled' });
    await waitFor(run.done);
    expect(run.events.at(-1)).toMatchObject({ type: 'done', stop: 'end' });
  });

  it('declines a waiting tool result when the session ends', async () => {
    const first = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    const waiting = await send(first.preview_id);
    await waitFor(() => waiting.calls().some((c) => c.status === 'pending-approval'));
    await invoke('ai_session_end', { sessionId: first.session_id });
    await waitFor(waiting.done);
    expect(waiting.events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', status: 'denied' }),
    );
    expect(waiting.events.at(-1)).toMatchObject({ type: 'done', stop: 'cancelled' });
  });
});

describe('demo assistant: replaced cluster credentials', () => {
  it('invalidates old previews, chats and pending tool consent only after successful reimport', async () => {
    const first = await settle(
      invoke<AiPreview>('ai_preview', { request: explainRequest('c-dev') }),
    );
    const waiting = await send(first.preview_id);
    await waitFor(() => waiting.calls().some((c) => c.status === 'pending-approval'));
    const preview = await settle(
      invoke<AiPreview>('ai_preview', { request: chatRequest(null, 'chat', 'Which context?') }),
    );
    await expect(
      invoke('cluster_reimport_kubeconfig', {
        id: 'c-dev',
        input: { context: 'missing', kubeconfig_path: '~/.kube/config' },
      }),
    ).rejects.toThrow();
    // A rejected import leaves the old chat usable.
    await settle(
      invoke('ai_preview', { request: chatRequest(preview.session_id, 'chat', 'still here') }),
    );
    await invoke('cluster_reimport_kubeconfig', {
      id: 'c-dev',
      input: {
        context: 'replacement',
        kubeconfig_path: '~/.kube/contextless-demo.yaml',
        create_context: { cluster: 'demo-east', user: 'demo-reader', namespace: null },
      },
    });
    await waitFor(waiting.done);
    expect(waiting.events.at(-1)).toMatchObject({ type: 'done', stop: 'cancelled' });
    await expect(
      settle(invoke('ai_send', { previewId: preview.preview_id, onEvent: () => {} }), 0),
    ).rejects.toThrow();
    await expect(
      settle(
        invoke('ai_preview', { request: chatRequest(preview.session_id, 'chat', 'old target') }),
      ),
    ).rejects.toThrow();
  });
});
