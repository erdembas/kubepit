import * as i18n from '@/i18n/core';
import { DEFAULT_AI_SETTINGS } from '@/lib/ai/defaults';
import { formatAge } from '@/lib/format';
import type {
  AiEvent,
  AiLocale,
  AiLogDetail,
  AiLogFilter,
  AiLogOutcome,
  AiLogPage,
  AiPreview,
  AiPreviewSection,
  AiProviderConfig,
  AiProviderKind,
  AiRequest,
  AiSettings,
  AiStatus,
  AiStop,
  AiToolCall,
  AiToolDecision,
  AiUsage,
  ClusterDef,
  KubeObject,
  Settings,
} from '@/types';
import { writeBackendOwned } from './app';
import { sleep } from './bus';
import {
  DEMO_MODELS,
  DEMO_TOOLS,
  FALLBACK_MODEL,
  TOOL_DECLINED,
  TOOL_LEAD_IN,
  TOOL_TOKENS,
  cannedAnswer,
  chunkWords,
  costOf,
  crashingContainer,
  demoModel,
  demoSystemPrompt,
  demoTrigger,
  estimateTokens,
  fitSections,
  isLoopback,
  priceFor,
  redactDemo,
  restoreMap,
  workloadOf,
  type AnswerTarget,
  type DemoPseudonyms,
  type FitSection,
} from './fixtures/ai';
import { getDb, list } from './fixtures/db';
import { provideAiHistory } from './history';
import { handlers, register, type MockArgs } from './registry';

/**
 * Demo assistant backend for `pnpm dev:ui`, mirroring `kubepit-core::ai`:
 *
 * - `ai_preview` checks the master switch, the active provider (local-only
 *   mode refuses remote ones), the model and the cluster's enablement, then
 *   redacts, budgets and stores the exact payload for ten minutes;
 *   `ai_send` sends a stored preview once and never re-renders it; a demo
 *   key for Anthropic is stored so the flow works without a real one.
 * - Canned answers per intent and locale (`fixtures/ai.ts`) stream three to
 *   six words every 40 ms; an `explain` of a crash-looping pod first calls
 *   `get_events`, whose redacted result waits for "Send" under policy
 *   `ask` (`send-session` stops asking for the session).
 * - Runs report usage and a cost from the user's price table (none for
 *   local models), end with `done`, can be cancelled (disconnecting or
 *   removing the cluster cancels them too) and are appended to the demo
 *   request log that `ai_log_*` page and export and the history clears.
 * - A tool result nobody answers never blocks the demo session: it is
 *   declined, and its run ends as cancelled, when `ai_cancel` is called,
 *   the session ends, or the next message of the session is sent.
 * - `ai_cluster_set` saves through the settings handler and records the
 *   typed production confirmation in `ai.production_acknowledged`; a
 *   production cluster without it is refused. `settings_set` keeps both
 *   lists as stored (`app.ts`) and normalizes the AI settings.
 */

const PREVIEW_TTL_MS = 600_000;
const MAX_PREVIEWS = 32;
const MAX_SESSIONS = 20;
const SESSION_IDLE_MS = 7_200_000;
const CHUNK_MS = 40;
const MAX_LOG_PAGE = 1000;
const THINKING_TOKENS = 180;

// Errors read like the backend's (they are not translated there either).
const OFF = 'The assistant is off. Turn it on in Settings → Assistant.';
const EXPIRED = 'The preview expired or was already sent. Preview the request again.';
const BUSY = 'This chat already has an answer in progress.';
const SESSION_GONE = 'The chat session expired. Start a new chat.';
const NO_PENDING = 'No tool result of this run is waiting for a decision.';

interface Session {
  id: string;
  clusterId: string | null;
  clusterName: string | null;
  production: boolean;
  providerId: string;
  providerKind: AiProviderKind;
  model: string;
  local: boolean;
  locale: AiLocale;
  /** Tools offered for the whole session (fixed when it starts). */
  tools: string[];
  /** Messages already sent (user and assistant). */
  messages: number;
  historyTokens: number;
  /** The cached prompt prefix: system, tools and the first context. */
  prefixTokens: number;
  primed: boolean;
  names: DemoPseudonyms;
  sendSession: boolean;
  runId: string | null;
  lastUsed: number;
}

interface Stored {
  preview: AiPreview;
  request: AiRequest;
  crashLoop: boolean;
  target: AnswerTarget;
}

interface Run {
  id: string;
  session: Session;
  stored: Stored;
  onEvent: (event: AiEvent) => void;
  startedAt: number;
  cancelled: boolean;
  finished: boolean;
  usage: AiUsage;
  text: string;
  calls: AiToolCall[];
  toolTokens: number;
  pending: { callId: string; resolve: (decision: AiToolDecision) => void } | null;
  wake: (() => void) | null;
}

/** Providers with a stored key; the demo ships with one for Anthropic. */
const keys = new Set<string>(['anthropic']);
const sessions = new Map<string, Session>();
const previews = new Map<string, Stored>();
const runs = new Map<string, Run>();
const log: AiLogDetail[] = [];
let nextLogId = 1;

const uuid = () => crypto.randomUUID();
const zeroUsage = (): AiUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
});

// -- Settings and clusters --------------------------------------------------------

function settings(): Settings {
  const current = handlers.settings_get?.({}) as Settings | undefined;
  if (!current) throw new Error('Demo backend: settings are not available.');
  return current;
}

function aiSettings(): AiSettings {
  const ai = settings().ai ?? structuredClone(DEFAULT_AI_SETTINGS);
  // Settings saved by an older demo lack the acknowledgement list.
  return ai.production_acknowledged ? ai : { ...ai, production_acknowledged: [] };
}

function clusters(): ClusterDef[] {
  return (handlers.cluster_list?.({}) as ClusterDef[] | undefined) ?? [];
}

/** `settings_set` normalization of `Settings.ai` (`AiSettings::normalized`). */
function normalizeAi(ai: AiSettings): AiSettings {
  return {
    ...ai,
    providers: ai.providers.map((p) => ({ ...p, base_url: p.base_url.trim().replace(/\/+$/, '') })),
    max_context_tokens: Math.min(
      900_000,
      Math.max(2_000, Math.round(ai.max_context_tokens) || 60_000),
    ),
    clusters: [...new Set(ai.clusters)],
    production_acknowledged: [...new Set(ai.production_acknowledged ?? [])],
  };
}

/**
 * Saves a change of the backend-owned lists (`ai.clusters`,
 * `ai.production_acknowledged`) straight into the store
 * (`writeBackendOwned` in `app.ts`); `settings_set` keeps them as stored
 * for every other caller.
 */
function saveAi(change: (ai: AiSettings) => AiSettings): Settings {
  const ai = aiSettings();
  return writeBackendOwned((current) => ({ ...current, ai: change(ai) }));
}

{
  const inner = handlers.settings_set;
  if (inner)
    register({
      settings_set: (args: MockArgs) => {
        const next = args.settings as Settings;
        return inner({
          ...args,
          settings: { ...next, ai: normalizeAi(next.ai ?? structuredClone(DEFAULT_AI_SETTINGS)) },
        });
      },
    });
}

function providerOf(ai: AiSettings, id: string | null): AiProviderConfig {
  const provider = ai.providers.find((p) => p.id === id);
  if (!provider)
    throw new Error(
      id
        ? `unknown provider ${id}`
        : 'No assistant provider is selected. Choose one in Settings → Assistant.',
    );
  return provider;
}

function checkEgress(ai: AiSettings, provider: AiProviderConfig) {
  if (ai.local_only && !isLoopback(provider.base_url))
    throw new Error(
      `${provider.name} is remote and the assistant is in local-only mode (loopback providers only).`,
    );
}

function checkKey(provider: AiProviderConfig) {
  if (provider.kind !== 'ollama' && !keys.has(provider.id))
    throw new Error(`No API key is stored for ${provider.name}. Set one in Settings → Assistant.`);
}

function clusterOf(id: string): ClusterDef {
  const cluster = clusters().find((c) => c.id === id);
  if (!cluster) throw new Error(`unknown cluster ${id}`);
  return cluster;
}

function checkCluster(ai: AiSettings, cluster: ClusterDef) {
  if (!ai.clusters.includes(cluster.id))
    throw new Error(
      `The assistant is not enabled for ${cluster.name}. Enable it for this cluster first.`,
    );
  if (cluster.environment === 'production' && !ai.production_acknowledged.includes(cluster.id))
    throw new Error(
      `${cluster.name} is a production cluster and the assistant was enabled without the typed confirmation. Enable it again.`,
    );
}

function status(): AiStatus {
  const ai = aiSettings();
  return {
    enabled: ai.enabled,
    local_only: ai.local_only,
    remote_allowed: true,
    keychain: i18n.t('Demo credential store (this browser tab)'),
    providers: ai.providers.map((p) => {
      const local = isLoopback(p.base_url);
      return {
        id: p.id,
        kind: p.kind,
        local,
        has_key: keys.has(p.id),
        key_error: null,
        allowed: local || !ai.local_only,
      };
    }),
  };
}

// -- Sessions and previews -----------------------------------------------------

function prune() {
  const now = Date.now();
  for (const [id, stored] of previews) if (stored.preview.expires_at < now) previews.delete(id);
  while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value!);
  for (const [id, s] of sessions)
    if (!s.runId && now - s.lastUsed > SESSION_IDLE_MS) endSession(id);
  const idle = [...sessions.values()]
    .filter((s) => !s.runId)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (sessions.size > MAX_SESSIONS && idle.length) endSession(idle.shift()!.id);
}

function endSession(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  if (session.runId) {
    const run = runs.get(session.runId);
    if (run) cancel(run);
  }
  sessions.delete(id);
  for (const [pid, stored] of previews) if (stored.preview.session_id === id) previews.delete(pid);
}

function sessionFor(request: AiRequest, ai: AiSettings, cluster: ClusterDef | null): Session {
  if (request.session_id) {
    const found = sessions.get(request.session_id);
    if (!found) throw new Error(SESSION_GONE);
    if (found.clusterId !== (cluster?.id ?? null))
      throw new Error('This chat belongs to another cluster. Start a new chat.');
    return found;
  }
  const provider = providerOf(ai, ai.active_provider);
  const hasPrometheus = cluster?.prometheus?.mode !== 'off';
  const session: Session = {
    id: `s-${uuid()}`,
    clusterId: cluster?.id ?? null,
    clusterName: cluster?.name ?? null,
    production: cluster?.environment === 'production',
    providerId: provider.id,
    providerKind: provider.kind,
    model: provider.model,
    local: isLoopback(provider.base_url),
    locale: request.locale,
    tools:
      !cluster || ai.tool_policy === 'off'
        ? []
        : DEMO_TOOLS.filter((t) => t !== 'query_prometheus' || hasPrometheus),
    messages: 0,
    historyTokens: 0,
    prefixTokens: 0,
    primed: false,
    names: { ips: new Map(), hosts: new Map() },
    sendSession: false,
    runId: null,
    lastUsed: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

function answerTarget(request: AiRequest, context: string): AnswerTarget {
  const object = request.scope.object;
  const kind = object?.kind ?? null;
  const name = object?.name ?? null;
  const workload = workloadOf(kind, name);
  return {
    namespace: request.scope.namespace ?? object?.namespace ?? 'default',
    kind,
    name,
    workload,
    container: crashingContainer(context) ?? workload,
    query:
      request.sections.find((s) => s.kind === 'query')?.content.trim() ?? request.message.trim(),
    now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

async function preview(request: AiRequest): Promise<AiPreview> {
  await sleep(120);
  const ai = aiSettings();
  if (!ai.enabled) throw new Error(OFF);
  const active = providerOf(ai, ai.active_provider);
  checkEgress(ai, active);
  if (!active.model.trim())
    throw new Error(`Choose a model for ${active.name} in Settings → Assistant.`);
  const cluster = request.scope.cluster_id ? clusterOf(request.scope.cluster_id) : null;
  if (cluster) checkCluster(ai, cluster);
  prune();
  const session = sessionFor(request, ai, cluster);
  session.lastUsed = Date.now();
  const provider = providerOf(ai, session.providerId);

  const excluded = new Set(request.excluded);
  const redacted = request.sections.map((s) => {
    const { text, counts } = redactDemo(s.content, s.format, ai.redaction, session.names);
    return { section: s, text, counts };
  });
  const message = redactDemo(request.message, 'text', ai.redaction, session.names).text;
  const windowTokens =
    provider.context_window ??
    demoModel(provider.kind, session.model)?.context_window ??
    (provider.kind === 'openai-compatible' ? 32_768 : 200_000);
  const systemTokens = estimateTokens(demoSystemPrompt(session.locale));
  const tools = ai.tool_policy === 'off' ? [] : session.tools;
  const toolTokens = tools.length * TOOL_TOKENS;
  const budget = Math.max(
    0,
    Math.min(ai.max_context_tokens, windowTokens - provider.max_output_tokens) -
      systemTokens -
      toolTokens -
      session.historyTokens,
  );
  const fitted = new Map<(typeof redacted)[number], FitSection>();
  for (const r of redacted)
    if (!excluded.has(r.section.id))
      fitted.set(r, {
        priority: r.section.priority,
        format: r.section.format,
        text: r.text,
        trimmed: false,
      });
  fitSections([...fitted.values()], budget - estimateTokens(message));

  const sections: AiPreviewSection[] = redacted.map((r) => {
    const fit = fitted.get(r);
    const text = fit?.text ?? r.text;
    return {
      id: r.section.id,
      kind: r.section.kind,
      label: r.section.label,
      text,
      tokens: estimateTokens(text),
      original_tokens: estimateTokens(r.text),
      trimmed: fit?.trimmed ?? false,
      excluded: !fit,
      redactions: r.counts,
    };
  });
  const sent = sections.filter((s) => !s.excluded);
  const input =
    systemTokens +
    toolTokens +
    session.historyTokens +
    sent.reduce((n, s) => n + s.tokens, 0) +
    estimateTokens(message);
  const context = request.sections
    .filter((s) => !excluded.has(s.id))
    .map((s) => s.content)
    .join('\n');
  const result: AiPreview = {
    preview_id: `p-${uuid()}`,
    session_id: session.id,
    provider_id: provider.id,
    provider_kind: provider.kind,
    model: session.model,
    local: session.local,
    production: session.production,
    cluster_name: session.clusterName,
    message,
    sections,
    earlier_messages: session.messages,
    system_tokens: systemTokens,
    tools,
    estimated_input_tokens: input,
    context_window: windowTokens,
    budget,
    estimated_cost: session.local
      ? null
      : costOf({ ...zeroUsage(), input_tokens: input }, priceFor(ai.prices, session.model)),
    placeholders: restoreMap(session.names),
    expires_at: Date.now() + PREVIEW_TTL_MS,
  };
  previews.set(result.preview_id, {
    preview: result,
    request: structuredClone(request),
    crashLoop: /CrashLoopBackOff/.test(context),
    target: answerTarget(request, context),
  });
  prune();
  return structuredClone(result);
}

// -- Runs ------------------------------------------------------------------------

function emit(run: Run, event: AiEvent) {
  try {
    run.onEvent(structuredClone(event));
  } catch {
    /* a closed panel: the run goes on until it ends or is cancelled */
  }
}

/** Waits `ms`; false once the run was cancelled. */
function pause(run: Run, ms: number): Promise<boolean> {
  if (run.cancelled) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      run.wake = null;
      resolve(!run.cancelled);
    }, ms);
    run.wake = () => {
      clearTimeout(timer);
      run.wake = null;
      resolve(false);
    };
  });
}

function cancel(run: Run) {
  if (run.cancelled || run.finished) return;
  run.cancelled = true;
  run.wake?.();
  run.pending?.resolve('deny');
}

/** Streams `text` into the run in chunks of a few words; false once cancelled. */
async function stream(run: Run, text: string, cut = 1): Promise<boolean> {
  const chunks = chunkWords(text);
  const count = Math.ceil(chunks.length * cut);
  for (const delta of chunks.slice(0, count)) {
    if (!(await pause(run, CHUNK_MS))) return false;
    run.text += delta;
    emit(run, { type: 'text', delta });
  }
  return true;
}

/** One provider response: the request's input (prefix cached after the first) and its output. */
function addRound(run: Run, extraInput: number, output: number) {
  const session = run.session;
  const total = run.stored.preview.estimated_input_tokens + extraInput;
  const prefix = Math.min(session.prefixTokens, total);
  if (session.primed) run.usage.cache_read_tokens += prefix;
  else {
    run.usage.cache_write_tokens += prefix;
    session.primed = true;
  }
  run.usage.input_tokens += total - prefix;
  run.usage.output_tokens += output;
  emit(run, { type: 'usage', usage: { ...run.usage } });
}

function eventsTable(clusterId: string | null, input: Record<string, string>): string {
  let events: KubeObject[] = [];
  try {
    if (clusterId) events = list(getDb(clusterId), 'events');
  } catch {
    events = [];
  }
  const seen = (e: KubeObject) =>
    Date.parse(String(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp)) || 0;
  const rows = events
    .filter((e) => {
      const o = (e.involvedObject ?? {}) as Record<string, string | undefined>;
      return (
        (!input.namespace || o.namespace === input.namespace) &&
        (!input.kind || o.kind === input.kind) &&
        (!input.name || o.name === input.name)
      );
    })
    .sort((a, b) => seen(b) - seen(a))
    .slice(0, 100)
    .map((e) => {
      const o = (e.involvedObject ?? {}) as Record<string, string | undefined>;
      return [
        formatAge(seen(e)),
        String(e.type ?? 'Normal'),
        String(e.reason ?? ''),
        `×${Number(e.count ?? 1)}`,
        `${o.kind ?? ''}/${o.name ?? ''}`,
        String(e.message ?? '').replace(/\s+/g, ' '),
      ].join('  ');
    });
  const what = [input.kind, [input.namespace, input.name].filter(Boolean).join('/')]
    .filter(Boolean)
    .join(' ');
  if (!rows.length) return `No events found for ${what || 'the scope'}.`;
  return ['LAST SEEN  TYPE  REASON  COUNT  OBJECT  MESSAGE', ...rows].join('\n');
}

async function eventsRound(run: Run): Promise<'done' | 'denied' | 'cancelled'> {
  const { session, stored } = run;
  const locale = session.locale;
  if (!(await stream(run, TOOL_LEAD_IN[locale]))) return 'cancelled';
  const object = stored.request.scope.object;
  const input: Record<string, string> = {
    namespace: object?.namespace ?? stored.target.namespace,
    ...(object ? { kind: object.kind, name: object.name } : {}),
  };
  addRound(run, 0, estimateTokens(run.text) + 40);
  const call: AiToolCall = {
    id: `toolu_${uuid().replace(/-/g, '').slice(0, 20)}`,
    name: 'get_events',
    input,
    status: 'running',
    result_preview: null,
  };
  run.calls.push(call);
  emit(run, { type: 'tool-call', call });
  if (!(await pause(run, 450))) return 'cancelled';
  const ai = aiSettings();
  const result = redactDemo(
    eventsTable(session.clusterId, input),
    'text',
    ai.redaction,
    session.names,
  );
  call.result_preview = result.text;
  let decision: AiToolDecision = 'send';
  if (ai.tool_policy !== 'session' && !session.sendSession) {
    call.status = 'pending-approval';
    emit(run, { type: 'tool-call', call });
    decision = await new Promise<AiToolDecision>((resolve) => {
      run.pending = { callId: call.id, resolve };
    });
    run.pending = null;
    if (decision === 'send-session') session.sendSession = true;
  }
  call.status = run.cancelled || decision === 'deny' ? 'denied' : 'done';
  emit(run, { type: 'tool-call', call });
  const tokens = call.status === 'done' ? estimateTokens(result.text) : 0;
  run.toolTokens += tokens;
  emit(run, {
    type: 'tool-result',
    call_id: call.id,
    status: call.status,
    tokens,
    redactions: result.counts,
  });
  if (run.cancelled) return 'cancelled';
  return call.status === 'done' ? 'done' : 'denied';
}

async function play(run: Run) {
  const { session, stored } = run;
  const trigger = demoTrigger(stored.request.message);
  const thinks = demoModel(session.providerKind, session.model)?.adaptive_thinking === true;
  emit(run, { type: 'started', run_id: run.id, model: session.model });
  if (!(await pause(run, 350))) return finish(run, 'cancelled');
  if (trigger === 'retry') {
    emit(run, {
      type: 'retrying',
      attempt: 1,
      delay_ms: 1000,
      reason: 'HTTP 529: overloaded (demo)',
    });
    if (!(await pause(run, 1000))) return finish(run, 'cancelled');
  }
  if (thinks) {
    emit(run, { type: 'thinking' });
    if (!(await pause(run, 600))) return finish(run, 'cancelled');
  }
  if (trigger === 'refusal') {
    addRound(run, 0, thinks ? THINKING_TOKENS : 12);
    return finish(run, 'refusal');
  }
  let prefix = '';
  const tools = aiSettings().tool_policy === 'off' ? [] : session.tools;
  if (stored.crashLoop && stored.request.intent === 'explain' && tools.includes('get_events')) {
    const outcome = await eventsRound(run);
    if (outcome === 'cancelled') return finish(run, 'cancelled');
    if (outcome === 'denied') prefix = TOOL_DECLINED[session.locale];
    if (thinks) {
      emit(run, { type: 'thinking' });
      if (!(await pause(run, 500))) return finish(run, 'cancelled');
    }
  }
  if (trigger === 'fallback')
    emit(run, { type: 'fallback', from_model: session.model, to_model: FALLBACK_MODEL });
  const before = run.text.length;
  const answer =
    prefix + cannedAnswer(stored.request.intent, session.locale, stored.target, stored.crashLoop);
  const cut = trigger === 'error' ? 0.4 : trigger === 'truncate' ? 0.7 : 1;
  if (!(await stream(run, answer, cut))) return finish(run, 'cancelled');
  const earlier = run.calls.length ? estimateTokens(run.text.slice(0, before)) + 40 : 0;
  addRound(
    run,
    earlier + run.toolTokens,
    estimateTokens(run.text.slice(before)) + (thinks ? THINKING_TOKENS : 0),
  );
  if (trigger === 'error') {
    const message = 'The connection to the provider was reset mid-answer (demo).';
    emit(run, { type: 'error', message, retryable: true });
    return finish(run, 'error', message);
  }
  return finish(run, trigger === 'truncate' ? 'max-tokens' : 'end');
}

const OUTCOME: Record<AiStop, AiLogOutcome> = {
  end: 'ok',
  'max-tokens': 'ok',
  'tool-limit': 'ok',
  refusal: 'refused',
  cancelled: 'cancelled',
  error: 'error',
};

/** The request body as the demo "sent" it (already redacted). */
function requestBody(run: Run): string {
  const { preview, request } = run.stored;
  const context = preview.sections
    .filter((s) => !s.excluded)
    .map((s) => `<section id="${s.id}" kind="${s.kind}" label="${s.label}">\n${s.text}\n</section>`)
    .join('\n');
  const content = [
    ...(context ? [{ type: 'text', text: `<context>\n${context}\n</context>` }] : []),
    { type: 'text', text: `Intent: ${request.intent}\n\n${preview.message}` },
  ];
  return JSON.stringify({
    model: run.session.model,
    system: demoSystemPrompt(run.session.locale),
    tools: preview.tools,
    messages: [{ role: 'user', content }],
  });
}

function finish(run: Run, stop: AiStop, error: string | null = null) {
  if (run.finished) return;
  run.finished = true;
  runs.delete(run.id);
  const { session, stored } = run;
  if (session.runId === run.id) session.runId = null;
  const ai = aiSettings();
  const cost = session.local ? null : costOf(run.usage, priceFor(ai.prices, session.model));
  emit(run, {
    type: 'done',
    stop,
    usage: { ...run.usage },
    cost,
    placeholders: restoreMap(session.names),
    refusal_category: stop === 'refusal' ? 'cyber' : null,
  });
  session.messages += 2;
  session.historyTokens +=
    stored.preview.sections.reduce((n, s) => n + (s.excluded ? 0 : s.tokens), 0) +
    estimateTokens(stored.preview.message) +
    estimateTokens(run.text) +
    run.toolTokens;
  session.lastUsed = Date.now();
  if (!ai.log_requests) return;
  log.push({
    entry: {
      id: nextLogId++,
      ts: run.startedAt,
      cluster_id: session.clusterId,
      cluster_name: session.clusterName,
      provider_id: session.providerId,
      model: session.model,
      intent: stored.request.intent,
      outcome: OUTCOME[stop],
      error,
      duration_ms: Date.now() - run.startedAt,
      usage: { ...run.usage },
      cost,
      tool_calls: run.calls.length,
    },
    request: requestBody(run),
    response: run.text,
    tools: structuredClone(run.calls),
  });
}

function send(previewId: string, onEvent: (event: AiEvent) => void): string {
  const stored = previews.get(previewId);
  if (!stored || stored.preview.expires_at < Date.now()) {
    previews.delete(previewId);
    throw new Error(EXPIRED);
  }
  const ai = aiSettings();
  if (!ai.enabled) throw new Error(OFF);
  const session = sessions.get(stored.preview.session_id);
  if (!session) throw new Error(SESSION_GONE);
  if (session.clusterId) checkCluster(ai, clusterOf(session.clusterId));
  const provider = providerOf(ai, session.providerId);
  checkEgress(ai, provider);
  checkKey(provider);
  const active = session.runId ? runs.get(session.runId) : undefined;
  // A run still waiting for tool consent does not block the chat: the next
  // message declines the result and ends it. A streaming run does.
  if (active && !active.pending) throw new Error(BUSY);
  if (active) cancel(active);
  previews.delete(previewId);
  if (!session.primed)
    session.prefixTokens =
      stored.preview.system_tokens +
      stored.preview.tools.length * TOOL_TOKENS +
      stored.preview.sections.reduce((n, s) => n + (s.excluded ? 0 : s.tokens), 0);
  const run: Run = {
    id: `ai:${uuid()}`,
    session,
    stored,
    onEvent,
    startedAt: Date.now(),
    cancelled: false,
    finished: false,
    usage: zeroUsage(),
    text: '',
    calls: [],
    toolTokens: 0,
    pending: null,
    wake: null,
  };
  runs.set(run.id, run);
  session.runId = run.id;
  session.lastUsed = Date.now();
  void play(run);
  return run.id;
}

/** Cancels the runs of a disconnected or removed cluster (`ai_stop_cluster`). */
function stopCluster(clusterId: string) {
  for (const run of [...runs.values()]) if (run.session.clusterId === clusterId) cancel(run);
}

// -- Request log -------------------------------------------------------------------

function logMatches(d: AiLogDetail, f: AiLogFilter): boolean {
  const e = d.entry;
  if (f.cluster_ids.length && (!e.cluster_id || !f.cluster_ids.includes(e.cluster_id)))
    return false;
  if (f.since !== null && e.ts < f.since) return false;
  const text = f.text?.trim().toLowerCase();
  if (!text) return true;
  return [e.cluster_name ?? '', e.model, e.intent, d.response.slice(0, 2048)]
    .join(' ')
    .toLowerCase()
    .includes(text);
}

function sortedLog(f: AiLogFilter): AiLogDetail[] {
  return log
    .filter((d) => logMatches(d, f))
    .sort((a, b) => b.entry.ts - a.entry.ts || b.entry.id - a.entry.id);
}

function logPage(f: AiLogFilter): AiLogPage {
  const all = sortedLog(f);
  const cursor = /^(-?\d+):(\d+)$/.exec(f.cursor ?? '');
  const rest = cursor
    ? all.filter(
        (d) =>
          d.entry.ts < Number(cursor[1]) ||
          (d.entry.ts === Number(cursor[1]) && d.entry.id < Number(cursor[2])),
      )
    : all;
  const limit = Math.min(MAX_LOG_PAGE, Math.max(1, Math.round(f.limit) || 100));
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  const usage = zeroUsage();
  let cost: number | null = null;
  for (const d of all) {
    usage.input_tokens += d.entry.usage.input_tokens;
    usage.output_tokens += d.entry.usage.output_tokens;
    usage.cache_read_tokens += d.entry.usage.cache_read_tokens;
    usage.cache_write_tokens += d.entry.usage.cache_write_tokens;
    if (d.entry.cost !== null) cost = (cost ?? 0) + d.entry.cost;
  }
  return structuredClone({
    entries: page.map((d) => d.entry),
    next_cursor: rest.length > limit && last ? `${last.entry.ts}:${last.entry.id}` : null,
    total: all.length,
    usage,
    cost,
  });
}

provideAiHistory({
  table: () => ({
    rows: log.length,
    oldest_ts: log.length ? Math.min(...log.map((d) => d.entry.ts)) : null,
  }),
  clear: (clusterId) => {
    for (let i = log.length - 1; i >= 0; i--)
      if (!clusterId || log[i]!.entry.cluster_id === clusterId) log.splice(i, 1);
  },
});

// -- Commands ----------------------------------------------------------------------

register({
  ai_status: () => status(),
  ai_key_set: ({ providerId, key }: MockArgs) => {
    providerOf(aiSettings(), String(providerId));
    if (!String(key ?? '').trim()) throw new Error('The API key is empty.');
    keys.add(String(providerId));
    return status();
  },
  ai_key_delete: ({ providerId }: MockArgs) => {
    providerOf(aiSettings(), String(providerId));
    keys.delete(String(providerId));
    return status();
  },
  ai_models: async ({ providerId }: MockArgs) => {
    await sleep(400);
    const ai = aiSettings();
    if (!ai.enabled) throw new Error(OFF);
    const provider = providerOf(ai, String(providerId));
    checkEgress(ai, provider);
    checkKey(provider);
    return structuredClone(DEMO_MODELS[provider.kind]);
  },
  // Synchronous refusal, like the backend refusing before anything is saved.
  ai_cluster_set: ({ clusterId, enabled, acknowledgeProduction }: MockArgs) => {
    const cluster = clusterOf(String(clusterId));
    if (enabled && cluster.environment === 'production' && !acknowledgeProduction)
      throw new Error(
        `${cluster.name} is a production cluster: enabling the assistant needs a typed confirmation.`,
      );
    if (!enabled) stopCluster(cluster.id);
    const production = cluster.environment === 'production';
    return saveAi((ai) => ({
      ...ai,
      clusters: enabled
        ? [...new Set([...ai.clusters, cluster.id])]
        : ai.clusters.filter((c) => c !== cluster.id),
      production_acknowledged:
        enabled && production
          ? [...new Set([...ai.production_acknowledged, cluster.id])]
          : ai.production_acknowledged.filter((c) => c !== cluster.id),
    }));
  },
  ai_preview: ({ request }: MockArgs) => preview(request as AiRequest),
  ai_send: ({ previewId, onEvent }: MockArgs) =>
    send(String(previewId), onEvent as (event: AiEvent) => void),
  ai_tool_decision: ({ runId, callId, decision }: MockArgs) => {
    const run = runs.get(String(runId));
    if (!run?.pending || run.pending.callId !== callId) throw new Error(NO_PENDING);
    if (!['send', 'send-session', 'deny'].includes(String(decision)))
      throw new Error(`unknown decision ${String(decision)}`);
    run.pending.resolve(decision as AiToolDecision);
  },
  ai_cancel: ({ runId }: MockArgs) => {
    const run = runs.get(String(runId));
    if (!run || run.cancelled || run.finished) return false;
    cancel(run);
    return true;
  },
  ai_session_end: ({ sessionId }: MockArgs) => {
    endSession(String(sessionId));
  },
  ai_log_list: ({ filter }: MockArgs) => logPage(filter as AiLogFilter),
  ai_log_get: ({ id }: MockArgs): AiLogDetail => {
    const found = log.find((d) => d.entry.id === Number(id));
    if (!found) throw new Error(`request ${id} is no longer in the log`);
    return structuredClone(found);
  },
  // Every matching run, bodies included: the audit trail of what left the machine.
  ai_log_export: ({ filter }: MockArgs) =>
    sortedLog(filter as AiLogFilter)
      .map((d) =>
        JSON.stringify({ ...d.entry, request: d.request, response: d.response, tools: d.tools }),
      )
      .join('\n'),
});

// Disconnecting a cluster stops its runs; removing it also ends its sessions
// and drops it from the enabled and acknowledged clusters (the backend's
// `ai_forget_cluster`).
for (const command of ['cluster_disconnect', 'cluster_remove'] as const) {
  const inner = handlers[command];
  if (!inner) continue;
  register({
    [command]: async (args: MockArgs) => {
      const id = String(args.id);
      stopCluster(id);
      const result = await inner(args);
      if (command === 'cluster_remove') {
        for (const s of [...sessions.values()]) if (s.clusterId === id) endSession(s.id);
        const ai = aiSettings();
        if (ai.clusters.includes(id) || ai.production_acknowledged.includes(id))
          await saveAi((current) => ({
            ...current,
            clusters: current.clusters.filter((c) => c !== id),
            production_acknowledged: current.production_acknowledged.filter((c) => c !== id),
          }));
      }
      return result;
    },
  });
}
