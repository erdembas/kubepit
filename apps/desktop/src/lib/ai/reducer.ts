import type {
  AiEvent,
  AiIntent,
  AiSectionKind,
  AiStop,
  AiToolCall,
  AiUsage,
  RedactionCounts,
} from '@/types';

/**
 * The message model of the assistant panel and the pure reducer that folds
 * a run's `AiEvent` stream into it (spec §7.2). Usage events carry the
 * run's cumulative totals, so each one replaces the last; `done.usage` is
 * authoritative. `done` is the last event of a run: a finished message
 * never changes again, so late events of a cancelled run are ignored.
 */

export type AiMessageStatus = 'streaming' | 'done' | 'error' | 'cancelled';

/** A tool call as its card shows it, with what its sent result cost. */
export interface AiMessageTool extends AiToolCall {
  /** Estimated tokens of the result once it was sent (0 when not sent); null before. */
  tokens: number | null;
  /** Redactions of the result; null before the result is final. */
  redactions: RedactionCounts | null;
}

/** A context section attached to a user message (identifiers only, for display). */
export interface AiAttachment {
  kind: AiSectionKind;
  label: string;
  tokens: number;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  intent: AiIntent;
  /** User: what they typed. Assistant: the streamed Markdown answer (model output). */
  text: string;
  tools: AiMessageTool[];
  status: AiMessageStatus;
  stop: AiStop | null;
  usage: AiUsage | null;
  cost: number | null;
  /** The model that started the run. */
  model: string | null;
  /** The run of an assistant message (tool decisions go to it). */
  runId: string | null;
  /** The provider answered with another model (server-side fallback). */
  fallback: { from: string; to: string } | null;
  /** The latest retry of the provider request (attempts are 1-based). */
  retry: { attempt: number; delay_ms: number } | null;
  error: string | null;
  retryable: boolean;
  /** The model is thinking (between a `thinking` event and the next content). */
  thinking: boolean;
  /** `__IP_n__` / `__HOST_n__` → original, for restoring suggestions locally. */
  placeholders: Record<string, string>;
  /** Why the provider refused (`done.refusal_category`), when it said. */
  refusal_category: string | null;
  /** User messages: the context sections that went with them. */
  attachments: AiAttachment[];
}

export function newAiMessage(init: {
  id: string;
  role: AiMessage['role'];
  intent: AiIntent;
  text?: string;
  status?: AiMessageStatus;
  attachments?: AiAttachment[];
}): AiMessage {
  return {
    id: init.id,
    role: init.role,
    intent: init.intent,
    text: init.text ?? '',
    tools: [],
    status: init.status ?? 'streaming',
    stop: null,
    usage: null,
    cost: null,
    model: null,
    runId: null,
    fallback: null,
    retry: null,
    error: null,
    retryable: false,
    thinking: false,
    placeholders: {},
    refusal_category: null,
    attachments: init.attachments ?? [],
  };
}

function statusOf(stop: AiStop, failed: boolean): AiMessageStatus {
  if (failed || stop === 'error') return 'error';
  return stop === 'cancelled' ? 'cancelled' : 'done';
}

function upsertTool(tools: AiMessageTool[], call: AiToolCall): AiMessageTool[] {
  const index = tools.findIndex((t) => t.id === call.id);
  if (index < 0) return [...tools, { ...call, tokens: null, redactions: null }];
  const current = tools[index]!;
  const next: AiMessageTool = {
    ...current,
    ...call,
    // A status update without a result keeps the one already shown.
    result_preview: call.result_preview ?? current.result_preview,
  };
  return tools.map((t, i) => (i === index ? next : t));
}

/** The message after `event`; never mutates `message`. */
export function applyAiEvent(message: AiMessage, event: AiEvent): AiMessage {
  if (message.stop !== null) return message;
  switch (event.type) {
    case 'started':
      return { ...message, runId: event.run_id, model: event.model };
    case 'text':
      return { ...message, text: message.text + event.delta, thinking: false };
    case 'thinking':
      return { ...message, thinking: true };
    case 'tool-call':
      return { ...message, tools: upsertTool(message.tools, event.call), thinking: false };
    case 'tool-result': {
      if (!message.tools.some((t) => t.id === event.call_id)) return message;
      return {
        ...message,
        tools: message.tools.map((t) =>
          t.id === event.call_id
            ? { ...t, status: event.status, tokens: event.tokens, redactions: event.redactions }
            : t,
        ),
      };
    }
    case 'retrying':
      return { ...message, retry: { attempt: event.attempt, delay_ms: event.delay_ms } };
    case 'fallback':
      return { ...message, fallback: { from: event.from_model, to: event.to_model } };
    case 'usage':
      return { ...message, usage: { ...event.usage } };
    case 'error':
      if (message.status !== 'streaming') return message;
      return {
        ...message,
        status: 'error',
        error: event.message,
        retryable: event.retryable,
        thinking: false,
      };
    case 'done':
      return {
        ...message,
        status: statusOf(event.stop, message.error !== null),
        stop: event.stop,
        usage: { ...event.usage },
        cost: event.cost,
        placeholders: { ...event.placeholders },
        refusal_category: event.refusal_category ?? null,
        thinking: false,
      };
  }
}
