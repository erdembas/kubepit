import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '@/lib/ipc';
import type { ClusterId, LogOptions } from '@/types';

export type StreamStatus =
  | { state: 'connecting' }
  | { state: 'streaming' }
  | { state: 'ended' }
  | { state: 'error'; message: string };

interface Params {
  clusterId: ClusterId;
  namespace: string;
  pod: string;
  container: string | null;
  options: LogOptions;
  /** A new stream is starting: drop what the previous one produced. */
  onReset: () => void;
  onData: (data: string) => void;
  /** The stream finished (done or error). */
  onEnd: () => void;
}

/**
 * Owns one `pod_logs_stream` at a time. Any change of target or options
 * stops the running stream and starts a fresh one; chunks from a stream
 * that is no longer current are ignored, so a late message can never mix
 * two containers' output.
 */
export function useLogStream({
  clusterId,
  namespace,
  pod,
  container,
  options,
  onReset,
  onData,
  onEnd,
}: Params) {
  const [status, setStatus] = useState<StreamStatus>({ state: 'connecting' });
  const [nonce, setNonce] = useState(0);
  const callbacks = useRef({ onReset, onData, onEnd });
  callbacks.current = { onReset, onData, onEnd };
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    let alive = true;
    let finished = false;
    let streamId: string | null = null;
    const opts = JSON.parse(optionsKey) as LogOptions;
    callbacks.current.onReset();
    setStatus({ state: 'connecting' });

    ipc
      .podLogsStream(clusterId, namespace, pod, container, opts, (chunk) => {
        if (!alive || finished) return;
        if (chunk.data) {
          callbacks.current.onData(chunk.data);
          setStatus((prev) => (prev.state === 'streaming' ? prev : { state: 'streaming' }));
        }
        if (chunk.error) {
          finished = true;
          callbacks.current.onEnd();
          setStatus({ state: 'error', message: chunk.error });
        } else if (chunk.done) {
          finished = true;
          callbacks.current.onEnd();
          setStatus({ state: 'ended' });
        }
      })
      .then((id) => {
        if (!alive) {
          void ipc.podLogsStop(id).catch(() => undefined);
          return;
        }
        streamId = id;
        if (!finished) {
          setStatus((prev) => (prev.state === 'connecting' ? { state: 'streaming' } : prev));
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        finished = true;
        setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });

    return () => {
      alive = false;
      if (streamId && !finished) void ipc.podLogsStop(streamId).catch(() => undefined);
    };
  }, [clusterId, namespace, pod, container, optionsKey, nonce]);

  const restart = useCallback(() => setNonce((n) => n + 1), []);
  return { status, restart };
}
