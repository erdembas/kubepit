import { describe, expect, it } from 'vitest';
import type { AiEvent, AiToolCall, AiUsage } from '@/types';
import { applyAiEvent, newAiMessage, type AiMessage } from './reducer';

// An empty assistant message as the store creates it when a run starts.
const empty = (): AiMessage => newAiMessage({ id: 'm1', role: 'assistant', intent: 'explain' });
const apply = (m: AiMessage, ...events: AiEvent[]) => events.reduce(applyAiEvent, m);
const usage = (input: number, output: number, read = 0, write = 0): AiUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: read,
  cache_write_tokens: write,
});
const call = (status: AiToolCall['status'], result: string | null = null): AiToolCall => ({
  id: 'toolu_1',
  name: 'get_events',
  input: { namespace: 'shop' },
  status,
  result_preview: result,
});
const done = (stop: Extract<AiEvent, { type: 'done' }>['stop'], extra = {}): AiEvent => ({
  type: 'done',
  stop,
  usage: usage(100, 20),
  cost: null,
  placeholders: {},
  refusal_category: null,
  ...extra,
});

describe('applyAiEvent', () => {
  it('starts streaming with no content', () => {
    const m = empty();
    expect(m).toMatchObject({ status: 'streaming', text: '', tools: [], stop: null, usage: null });
  });

  it('records the run and the model when the run starts', () => {
    const m = apply(empty(), { type: 'started', run_id: 'ai:1', model: 'claude-opus-5' });
    expect(m.runId).toBe('ai:1');
    expect(m.model).toBe('claude-opus-5');
  });

  it('appends text deltas and marks thinking', () => {
    let m = empty();
    m = applyAiEvent(m, { type: 'thinking' });
    expect(m.thinking).toBe(true);
    m = applyAiEvent(m, { type: 'text', delta: 'Hel' });
    m = applyAiEvent(m, { type: 'text', delta: 'lo' });
    expect(m.text).toBe('Hello');
    expect(m.thinking).toBe(false);
  });

  it('upserts tool calls by id', () => {
    let m = apply(empty(), { type: 'tool-call', call: call('running') });
    m = applyAiEvent(m, { type: 'tool-call', call: call('pending-approval', 'LAST SEEN …') });
    expect(m.tools).toHaveLength(1);
    expect(m.tools[0]).toMatchObject({ status: 'pending-approval', result_preview: 'LAST SEEN …' });
    m = applyAiEvent(m, { type: 'tool-call', call: call('done', 'LAST SEEN …') });
    m = applyAiEvent(m, {
      type: 'tool-result',
      call_id: 'toolu_1',
      status: 'done',
      tokens: 42,
      redactions: { secrets: 0, tokens: 1, ips: 0, hostnames: 0 },
    });
    expect(m.tools).toHaveLength(1);
    expect(m.tools[0]).toMatchObject({
      status: 'done',
      tokens: 42,
      redactions: { secrets: 0, tokens: 1, ips: 0, hostnames: 0 },
    });
  });

  it('keeps the result of an earlier update when a later one has none', () => {
    const m = apply(
      empty(),
      { type: 'tool-call', call: call('pending-approval', 'rows') },
      { type: 'tool-call', call: call('denied') },
    );
    expect(m.tools[0]).toMatchObject({ status: 'denied', result_preview: 'rows' });
  });

  it('ignores a result for an unknown call', () => {
    const m = apply(empty(), {
      type: 'tool-result',
      call_id: 'nope',
      status: 'done',
      tokens: 1,
      redactions: { secrets: 0, tokens: 0, ips: 0, hostnames: 0 },
    });
    expect(m.tools).toEqual([]);
  });

  it('replaces usage with the cumulative run totals', () => {
    const m = apply(
      empty(),
      { type: 'usage', usage: usage(100, 10) },
      { type: 'usage', usage: usage(180, 30, 50) },
    );
    expect(m.usage).toEqual(usage(180, 30, 50));
  });

  it('finishes with usage, cost, stop and placeholders', () => {
    const m = apply(
      empty(),
      { type: 'usage', usage: usage(1, 1) },
      done('end', {
        usage: usage(1234, 567, 890),
        cost: 0.01,
        placeholders: { __IP_1__: '10.0.0.1' },
      }),
    );
    expect(m).toMatchObject({
      status: 'done',
      stop: 'end',
      cost: 0.01,
      placeholders: { __IP_1__: '10.0.0.1' },
      thinking: false,
    });
    // `done.usage` is authoritative over the last `usage` event.
    expect(m.usage).toEqual(usage(1234, 567, 890));
  });

  it('keeps the refusal category of a refused run', () => {
    const m = apply(empty(), done('refusal', { refusal_category: 'cyber' }));
    expect(m).toMatchObject({ status: 'done', stop: 'refusal', refusal_category: 'cyber' });
  });

  it('maps cancelled and error stops', () => {
    expect(apply(empty(), done('cancelled')).status).toBe('cancelled');
    const failed = apply(
      empty(),
      { type: 'text', delta: 'partial' },
      { type: 'error', message: 'connection reset', retryable: true },
    );
    expect(failed).toMatchObject({
      status: 'error',
      error: 'connection reset',
      retryable: true,
      text: 'partial',
    });
    const ended = applyAiEvent(failed, done('error'));
    expect(ended).toMatchObject({ status: 'error', stop: 'error', error: 'connection reset' });
    expect(apply(empty(), done('error')).status).toBe('error');
  });

  it('treats max-tokens, tool-limit and refusal as finished answers', () => {
    for (const stop of ['max-tokens', 'tool-limit', 'refusal'] as const)
      expect(apply(empty(), done(stop)).status).toBe('done');
  });

  it('records fallbacks and retries', () => {
    const m = apply(
      empty(),
      { type: 'retrying', attempt: 1, delay_ms: 1000, reason: 'HTTP 529' },
      { type: 'retrying', attempt: 2, delay_ms: 2000, reason: 'HTTP 529' },
      { type: 'fallback', from_model: 'claude-opus-5', to_model: 'claude-opus-4-8' },
    );
    expect(m.retry).toEqual({ attempt: 2, delay_ms: 2000 });
    expect(m.fallback).toEqual({ from: 'claude-opus-5', to: 'claude-opus-4-8' });
  });

  it('ignores events after the run finished', () => {
    const finished = apply(empty(), { type: 'text', delta: 'a' }, done('end'));
    expect(applyAiEvent(finished, { type: 'text', delta: 'b' })).toBe(finished);
    expect(applyAiEvent(finished, { type: 'error', message: 'x', retryable: true })).toBe(finished);
  });

  it('never mutates the message it is given', () => {
    const m = apply(empty(), { type: 'tool-call', call: call('running') });
    const snapshot = structuredClone(m);
    apply(m, { type: 'text', delta: 'x' }, { type: 'tool-call', call: call('done') }, done('end'));
    expect(m).toEqual(snapshot);
  });
});
