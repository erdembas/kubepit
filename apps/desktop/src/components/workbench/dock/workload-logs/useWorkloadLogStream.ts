import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '@/lib/ipc';
import type { ClusterId, WorkloadLogBatch, WorkloadLogOptions } from '@/types';
import type { StreamStatus } from '../logs/useLogStream';

interface Params {
  clusterId: ClusterId;
  namespace: string;
  selector: string;
  options: WorkloadLogOptions;
  /** A new stream is starting: drop what the previous one produced. */
  onReset: () => void;
  onBatch: (batch: WorkloadLogBatch) => void;
}

/**
 * Owns one `workload_logs_stream` at a time — the workload counterpart of
 * `useLogStream`. Any change of target or options restarts it; batches of a
 * stream that is no longer current are ignored.
 */
export function useWorkloadLogStream({
  clusterId,
  namespace,
  selector,
  options,
  onReset,
  onBatch,
}: Params) {
  const [status, setStatus] = useState<StreamStatus>({ state: 'connecting' });
  const [nonce, setNonce] = useState(0);
  const callbacks = useRef({ onReset, onBatch });
  callbacks.current = { onReset, onBatch };
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    let alive = true;
    let finished = false;
    let streamId: string | null = null;
    const opts = JSON.parse(optionsKey) as WorkloadLogOptions;
    callbacks.current.onReset();
    setStatus({ state: 'connecting' });

    ipc
      .workloadLogsStream(clusterId, namespace, selector, opts, (batch) => {
        if (!alive || finished) return;
        callbacks.current.onBatch(batch);
        if (batch.error) {
          finished = true;
          setStatus({ state: 'error', message: batch.error });
        } else if (batch.done) {
          finished = true;
          setStatus({ state: 'ended' });
        } else {
          setStatus((prev) => (prev.state === 'streaming' ? prev : { state: 'streaming' }));
        }
      })
      .then((id) => {
        if (!alive) {
          void ipc.workloadLogsStop(id).catch(() => undefined);
          return;
        }
        streamId = id;
        if (!finished)
          setStatus((prev) => (prev.state === 'connecting' ? { state: 'streaming' } : prev));
      })
      .catch((err: unknown) => {
        if (!alive) return;
        finished = true;
        setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });

    return () => {
      alive = false;
      if (streamId && !finished) void ipc.workloadLogsStop(streamId).catch(() => undefined);
    };
  }, [clusterId, namespace, selector, optionsKey, nonce]);

  const restart = useCallback(() => setNonce((n) => n + 1), []);
  return { status, restart };
}
