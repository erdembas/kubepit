import * as i18n from '@/i18n/core';
import type { TerminalOutput, TerminalSpec } from '@/types';
import { call, callWithChannel } from './invoke';

// React cleanup cannot await IPC. Order create/destroy per terminal so an
// older cleanup cannot kill a newly restarted shell. Other terminals proceed
// independently, and a blocked input write never delays destruction.
const lifecycles = new Map<string, Promise<void>>();
const writes = new Map<string, Promise<void>>();
const generations = new Map<string, string>();

function enqueue(
  queue: Map<string, Promise<void>>,
  id: string,
  operation: () => Promise<void>,
): Promise<void> {
  const result = (queue.get(id) ?? Promise.resolve()).then(operation);
  const settled = result.catch(() => undefined);
  queue.set(id, settled);
  void settled.then(() => {
    if (queue.get(id) === settled) queue.delete(id);
  });
  return result;
}

export const terminalIpc = {
  terminalCreate: (
    id: string,
    spec: TerminalSpec,
    cols: number,
    rows: number,
    onOutput: (chunk: TerminalOutput) => void,
  ) => {
    const streamId = crypto.randomUUID();
    generations.set(id, streamId);
    writes.delete(id);
    return enqueue(lifecycles, id, () =>
      callWithChannel<void, TerminalOutput>(
        'terminal_create',
        { id, streamId, spec, cols, rows },
        'onOutput',
        onOutput,
      ),
    );
  },
  terminalWrite: (id: string, data: number[]) => {
    const generation = generations.get(id);
    const ready = lifecycles.get(id) ?? Promise.resolve();
    return enqueue(writes, id, async () => {
      await ready;
      // Keep input ordered, but stop sending a paste as soon as its shell closes.
      for (let offset = 0; offset < data.length; offset += 4096) {
        if (!generation || generations.get(id) !== generation) {
          throw new Error(i18n.t('Terminal is restarting'));
        }
        await call<void>('terminal_write', {
          id,
          streamId: generation,
          data: data.slice(offset, offset + 4096),
        });
      }
    });
  },
  terminalResize: (id: string, cols: number, rows: number) =>
    call<void>('terminal_resize', { id, streamId: generations.get(id), cols, rows }),
  terminalAcknowledge: (id: string, streamId: string, bytes: number) =>
    call<void>('terminal_acknowledge', { id, streamId, bytes }),
  terminalDestroy: (id: string) => {
    generations.delete(id);
    writes.delete(id);
    return enqueue(lifecycles, id, () => call<void>('terminal_destroy', { id }));
  },
};
