import type { LogChunk, LogOptions } from '@/types';
import { evidenceError, type EvidenceError } from './model';

export const PREVIOUS_LOG_BYTES = 64 * 1024;
export interface PreviousLogState {
  text: string;
  status: 'reading' | 'complete' | 'limited' | 'error' | 'cancelled';
  error?: EvidenceError;
}
interface LogApi {
  podLogsStream: (
    clusterId: string,
    namespace: string,
    pod: string,
    container: string | null,
    options: LogOptions,
    onChunk: (chunk: LogChunk) => void,
  ) => Promise<string>;
  podLogsStop: (streamId: string) => Promise<void>;
}

/** Explicit, non-following read. Stop even if cancellation/cap/timeout precedes
 * the stream-id reply; late chunks can never update a different Pod/container. */
export function readPreviousLogs(
  api: LogApi,
  target: { clusterId: string; namespace: string; pod: string; container: string },
  onUpdate: (state: PreviousLogState) => void,
  timeoutMs = 10_000,
): () => void {
  let ended = false;
  let streamId: string | null = null;
  let stopped = false;
  let text = '';
  let bytes = 0;
  const stop = () => {
    if (streamId && !stopped) {
      stopped = true;
      void api.podLogsStop(streamId).catch(() => undefined);
    }
  };
  const finish = (status: PreviousLogState['status'], error?: EvidenceError) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    stop();
    onUpdate({ text, status, ...(error ? { error } : {}) });
  };
  const timer = setTimeout(() => finish('error', 'timeout'), timeoutMs);
  onUpdate({ text, status: 'reading' });
  void api
    .podLogsStream(
      target.clusterId,
      target.namespace,
      target.pod,
      target.container,
      {
        follow: false,
        tail_lines: 200,
        since_seconds: null,
        timestamps: true,
        previous: true,
      },
      (chunk) => {
        if (ended) return;
        if (chunk.data) {
          const encoded = new TextEncoder().encode(chunk.data);
          const remaining = PREVIOUS_LOG_BYTES - bytes;
          text += new TextDecoder().decode(encoded.subarray(0, remaining), { stream: true });
          bytes += Math.min(encoded.length, remaining);
          if (bytes >= PREVIOUS_LOG_BYTES) {
            finish('limited');
            return;
          }
          onUpdate({ text, status: 'reading' });
        }
        if (chunk.error) finish('error', evidenceError(chunk.error));
        else if (chunk.done) finish('complete');
      },
    )
    .then((id) => {
      streamId = id;
      if (ended) stop();
    })
    .catch((error: unknown) => finish('error', evidenceError(error)));
  return () => finish('cancelled');
}
