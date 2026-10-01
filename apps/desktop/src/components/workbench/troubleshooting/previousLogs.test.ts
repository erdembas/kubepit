import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogChunk } from '@/types';
import { PREVIOUS_LOG_BYTES, readPreviousLogs, type PreviousLogState } from './previousLogs';

const target = { clusterId: 'fixture-cluster', namespace: 'team', pod: 'api-1', container: 'api' };
function harness() {
  let receive: (chunk: LogChunk) => void = () => undefined;
  let resolve: (id: string) => void = () => undefined;
  const states: PreviousLogState[] = [];
  const api = {
    podLogsStream: vi.fn((_cluster, _ns, _pod, _container, _options, onChunk) => {
      receive = onChunk;
      return new Promise<string>((done) => {
        resolve = done;
      });
    }),
    podLogsStop: vi.fn(async () => undefined),
  };
  const cancel = readPreviousLogs(api, target, (state) => states.push(state));
  return {
    api,
    states,
    cancel,
    resolve: (id = 'stream-1') => resolve(id),
    send: (data: string, done = false, error: string | null = null) =>
      receive({ stream_id: 'stream-1', data, done, error }),
  };
}
afterEach(() => vi.useRealTimers());

describe('bounded previous container log reads', () => {
  it('explicitly requests previous, non-following logs and stops at completion', async () => {
    const h = harness();
    expect(h.api.podLogsStream.mock.calls[0]?.[4]).toEqual({
      follow: false,
      tail_lines: 200,
      since_seconds: null,
      timestamps: true,
      previous: true,
    });
    h.send('one line\n', true);
    h.resolve();
    await Promise.resolve();
    expect(h.states.at(-1)).toEqual({ text: 'one line\n', status: 'complete' });
    expect(h.api.podLogsStop).toHaveBeenCalledWith('stream-1');
  });

  it('caps UTF-8 output and stops when chunks arrive before the stream-id reply', async () => {
    const h = harness();
    h.send('😀'.repeat(PREVIOUS_LOG_BYTES));
    h.resolve();
    await Promise.resolve();
    const last = h.states.at(-1)!;
    expect(last.status).toBe('limited');
    expect(new TextEncoder().encode(last.text).length).toBeLessThanOrEqual(PREVIOUS_LOG_BYTES);
    expect(last.text).not.toContain('�');
    expect(h.api.podLogsStop).toHaveBeenCalledTimes(1);
  });

  it('cancellation ignores late data and still stops a late stream-id reply', async () => {
    const h = harness();
    h.send('first');
    h.cancel();
    h.send('must not leak from old Pod', true);
    h.resolve();
    await Promise.resolve();
    expect(h.states.at(-1)).toEqual({ text: 'first', status: 'cancelled' });
    expect(h.api.podLogsStop).toHaveBeenCalledTimes(1);
  });

  it('times out without waiting forever for the first chunk or stream id', async () => {
    vi.useFakeTimers();
    const h = harness();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.states.at(-1)).toEqual({ text: '', status: 'error', error: 'timeout' });
    h.resolve();
    await Promise.resolve();
    expect(h.api.podLogsStop).toHaveBeenCalledWith('stream-1');
  });

  it('preserves partial evidence and classifies a denied read without exposing raw errors', () => {
    const h = harness();
    h.send('partial\n');
    h.send('', true, '403 Forbidden: secret raw server context');
    expect(h.states.at(-1)).toEqual({ text: 'partial\n', status: 'error', error: 'forbidden' });
    expect(JSON.stringify(h.states)).not.toContain('secret raw');
  });
});
